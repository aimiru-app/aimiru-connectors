// Maps one Codex tool call (PreToolUse input) to an Aimiru action, with the shared classifier
// (connectors/shared/classify.mjs) and nothing Codex-specific in it, so a change there reaches
// Codex and Claude Code alike (ADR-0091).
//
// What Codex sends (OpenAI, Codex hooks, "PreToolUse"; openai/codex codex-rs/core/src/tools/handlers):
//   Bash         tool_input.command, the command text only. Codex runs it in the folder the model
//                names (exec_command's `workdir`), which the check is never told
//                (unified_exec/exec_command.rs pre_tool_use_payload); `cwd` is the session's folder.
//                So a command is read in the session's folder and again in the home folder, and
//                held when the two differ and the command names something in the home folder
//                (readCommand below).
//   apply_patch  tool_input.command, the whole patch ("*** Begin Patch" ... "*** End Patch"), read
//                with Codex's own parser rules (parsePatch below)
//   mcp__<server>__<tool>   the tool's own arguments
//   other local function tools (update_plan, view_image, spawn_agent, wait_agent, ...): their
//                arguments, under the name codex-rs/core/src/tools/mod.rs flat_tool_name gives them
//
// Codex never checks what it types into a command that is already running (write_stdin: "transport
// for an existing unified-exec session", unified_exec/write_stdin.rs), so a command that starts a
// shell or an interpreter waiting for typed input is held as something Aimiru cannot see into.
//
// A file change inside the project reads exactly as Aimiru for Claude Code reads an Edit or Write
// there (actionForClaudeCodeTool, per file): today local work, class read with resource code.local,
// which Aimiru words as a change to files where the agent works. A deletion outside the project reads
// as `rm` of that file would. Codex's own and Aimiru's settings are protected: changing them is
// sensitive, held when Aimiru cannot answer, and asked about.

import fs from 'node:fs';
import path from 'node:path';
import {
  actionForClaudeCodeTool,
  classifyCommand,
  classifyToolName,
  counterpartyOf,
  INCIDENT_RESOURCES,
  isInsideWorkArea,
  isProtectedPath,
  lexShell,
  LOCAL_WORK_RESOURCE,
  makePathContext,
  NEW_PROGRAM_RESOURCE,
  PART_RESOURCES,
  programDescription,
  splitMcpToolName,
  strongest,
  withProgramSentence,
} from '../vendor/classify.mjs';
import { evidenceText, redactSecrets, shellEvidenceInput, truncate } from '../vendor/sayso-client.mjs';

/** What a change to Codex's or Aimiru's own files names (CONTRACT.md, the protected-paths row). */
const REMOVE_GUARD = INCIDENT_RESOURCES.removeGuard;

/**
 * The project Codex works in, when it works in none (the home folder, or above it): a folder that
 * cannot exist, so nothing counts as local work and the person's files read as theirs.
 */
export const NO_PROJECT = path.join(path.sep, '.sayso-codex-no-project');

/**
 * Codex's own local tools that change nothing outside Codex: answered without asking Aimiru, as Aimiru
 * for Claude Code leaves Claude Code's read-only tools out of its matcher. A helper's own tool calls
 * are checked one by one as they happen (they run PreToolUse too). Names from openai/codex
 * codex-rs/core/src/tools/handlers at 0769c6a (22 Oct 2026); request_plugin_install is not here, it
 * installs something and is checked.
 */
export const CODEX_LOCAL_TOOLS = new Set([
  // planning, images and questions to the person, inside Codex
  'update_plan',
  'view_image',
  'request_user_input',
  'request_user_input_async',
  'send_message_to_user_async',
  'request_permissions',
  'imagegen',
  // tool servers' own listings
  'list_mcp_resources',
  'list_mcp_resource_templates',
  'read_mcp_resource',
  'tool_search',
  'tool_search_tool',
  'list_available_plugins_to_install',
  // helpers (multi_agent, on by default; multi_agent_v2)
  'spawn_agent',
  'Agent',
  'wait_agent',
  'wait',
  'send_input',
  'send_message',
  'followup_task',
  'resume_agent',
  'list_agents',
  'close_agent',
  'interrupt_agent',
  // time and Codex's own context
  'curr_time',
  'current_time',
  'sleep',
  'get_context_remaining',
  'new_context',
  'new_context_window',
  'wait_for_environment',
]);

/**
 * Namespaces Codex puts its own tools in (multi_agent_v1, collaboration for multi_agent_v2, clock,
 * image_gen). flat_tool_name joins a namespace and a name with nothing between them
 * ("multi_agent_v1wait_agent"); a separator is accepted too, in case that changes.
 */
const CODEX_NAMESPACES = ['multi_agent_v1', 'collaboration', 'clock', 'image_gen'];

/** True for one of Codex's own local tools, under its plain or namespaced name. */
export function isCodexLocalTool(toolName) {
  const name = String(toolName ?? '');
  if (CODEX_LOCAL_TOOLS.has(name)) return true;
  for (const ns of CODEX_NAMESPACES) {
    if (!name.startsWith(ns)) continue;
    const rest = name.slice(ns.length).replace(/^(?:\.|__|_|\/|:)/, '');
    if (rest && CODEX_LOCAL_TOOLS.has(rest)) return true;
  }
  return false;
}

/** Codex's own web search, when it runs as a local tool (namespace web, tool run): a read. */
const WEB_SEARCH_TOOLS = new Set(['webrun', 'web.run', 'web__run', 'web_run', 'web_search']);

// ---------------------------------------------------------------------------
// Patches, read as Codex reads them (codex-rs/apply-patch/src/parser.rs, streaming_parser.rs)
// ---------------------------------------------------------------------------

const BEGIN = '*** Begin Patch';
const END = '*** End Patch';
const ADD = '*** Add File: ';
const DELETE = '*** Delete File: ';
const UPDATE = '*** Update File: ';
const MOVE = '*** Move to: ';
const END_OF_FILE = '*** End of File';
const ENVIRONMENT = '*** Environment ID:';

/** Codex's lenient boundaries: the patch itself, or one wrapped in <<EOF ... EOF. */
function patchLines(text) {
  const lines = String(text ?? '')
    .trim()
    .split('\n')
    .map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
  const strict = (ls) => ls.length > 0 && ls[0].trim() === BEGIN && ls[ls.length - 1].trim() === END;
  if (strict(lines)) return lines;
  if (lines.length >= 4 && ['<<EOF', "<<'EOF'", '<<"EOF"'].includes(lines[0]) && lines[lines.length - 1].endsWith('EOF')) {
    const inner = lines.slice(1, -1);
    if (strict(inner)) return inner;
  }
  return null;
}

/**
 * The files one patch touches, with Codex's own rules: a header is read from the trimmed line, except
 * inside an Update section, where only the line's end is trimmed (a header indented there is a line
 * of context to Codex), and `*** Move to:` counts only right after its `*** Update File:`.
 *
 * Aimiru reads less than Codex would apply, never more: a patch Codex would refuse, one that names
 * another environment, or an indented `*** ` line inside an Update section (Codex reads it as
 * context; a reader that trims would read it as a header) is "a patch Aimiru could not read".
 * @returns {{ok: boolean, files: Array<{op: 'add'|'update'|'delete', path: string, moveTo?: string}>, why: string|null}}
 */
export function parsePatch(text) {
  const files = [];
  const lines = patchLines(text);
  if (!lines) return { ok: false, files, why: 'not a patch' };
  let mode = 'start';
  const fail = (why) => ({ ok: false, files, why });
  const header = (t) => {
    if (mode === 'started' && t.startsWith(ENVIRONMENT)) return 'environment';
    if (t === END) {
      mode = 'ended';
      return true;
    }
    for (const [marker, op] of [
      [ADD, 'add'],
      [DELETE, 'delete'],
      [UPDATE, 'update'],
    ]) {
      if (t.startsWith(marker)) {
        files.push({ op, path: t.slice(marker.length) });
        mode = op;
        return true;
      }
    }
    return false;
  };
  let changed = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (mode === 'start') {
      if (trimmed !== BEGIN) return fail('not a patch');
      mode = 'started';
      continue;
    }
    if (mode === 'ended') {
      if (trimmed) return fail('text after the end');
      continue;
    }
    if (mode === 'update') {
      const u = line.trimEnd();
      const h = header(u);
      if (h === 'environment') return fail('another environment');
      if (h) {
        changed = false;
        continue;
      }
      const last = files[files.length - 1];
      if (u.startsWith(MOVE) && last.moveTo === undefined && !changed) {
        last.moveTo = u.slice(MOVE.length);
        continue;
      }
      if (u === END_OF_FILE) continue;
      // An indented header: context to Codex, a header to anything that trims. Never guess.
      if (/^\s/.test(u) && trimmed.startsWith('*** ')) return fail('an indented header');
      if (u === '' || u.startsWith(' ') || u.startsWith('+') || u.startsWith('-') || u === '@@' || u.startsWith('@@ ')) {
        changed = true;
        continue;
      }
      return fail('a line Codex would refuse');
    }
    const h = header(trimmed);
    if (h === 'environment') return fail('another environment');
    if (h) {
      changed = false;
      continue;
    }
    if (mode === 'add' && line.startsWith('+')) continue;
    return fail('a line Codex would refuse');
  }
  if (mode !== 'ended') return fail('no end');
  return { ok: true, files, why: null };
}

/** The patches a shell command hands to apply_patch, each with the folder its paths are read in. */
function patchesInCommand(command, ctx) {
  const text = String(command ?? '');
  const found = [];
  let missing = false;
  let lex = null;
  try {
    lex = lexShell(text);
  } catch {
    lex = null;
  }
  let cwd = ctx.cwd;
  for (const s of lex?.segments ?? []) {
    const words = s.words ?? [];
    if (!words.length) continue;
    const prog = path.basename(words[0]);
    if (prog === 'cd') {
      const target = words[1];
      if (!target || target === '~') cwd = ctx.home;
      else if (s.dynamic?.[1] || target === '-') cwd = null;
      else cwd = cwd ? resolveIn({ ...ctx, cwd }, target) : null;
      continue;
    }
    if (prog !== 'apply_patch' && prog !== 'applypatch') continue;
    const bodies = [
      ...(s.redirects ?? []).filter((r) => typeof r.body === 'string' && r.body.includes(BEGIN)).map((r) => r.body),
      ...words.slice(1).filter((w) => w.includes(BEGIN)),
    ];
    if (!bodies.length) missing = true;
    for (const b of bodies) found.push({ text: b, cwd });
  }
  if (!found.length && (missing || text.includes(BEGIN))) {
    // Handed over some other way (a pipe, a file): whatever patch text the command holds, read from
    // its first "*** Begin Patch" to its last "*** End Patch", or none Aimiru could read.
    const start = text.indexOf(BEGIN);
    const end = text.lastIndexOf(END);
    found.push({ text: start >= 0 && end > start ? text.slice(start, end + END.length) : '', cwd: ctx.cwd });
  }
  return found;
}

function shellQuote(p) {
  return `'${String(p).replace(/'/g, `'\\''`)}'`;
}

function rel(p, ctx) {
  const r = path.relative(ctx.project, p);
  return r && !r.startsWith('..') && !path.isAbsolute(r) ? r : p;
}

function resolveIn(ctx, p) {
  return path.resolve(ctx.cwd, String(p).replace(/^~(?=$|\/)/, ctx.home));
}

const UNREADABLE_PATCH = Object.freeze({ class: 'write', resource: null, sensitive: true, description: 'Change files with a patch Aimiru could not read', parts: [] });

/**
 * What one patch does, in Aimiru's terms: the strongest class over its files, the resource of that
 * file (code.local when every file is inside the project), sensitive when any file is protected.
 * A change to Codex's or Aimiru's own files (a protected path: CODEX_HOME, Aimiru's data folder, the
 * settings files isProtectedPath names) is class delete with code.remove_guard, as the same change
 * from the shell is (CONTRACT.md, the protected-paths row); it names the patch, and every other
 * step that names its own resource (a deletion of the person's files) goes as a part, so a Never
 * about it still refuses the whole patch (ADR-0096).
 */
export function classifyPatch(patchText, ctx, input = {}) {
  if (!ctx.cwd) return { ...UNREADABLE_PATCH };
  const { ok, files } = parsePatch(patchText);
  if (!ok || files.length === 0) {
    // A patch Aimiru cannot read could change anything: held when Aimiru cannot answer, and asked about.
    return { ...UNREADABLE_PATCH };
  }
  const parts = [];
  const names = [];
  const write = (abs, verb, said) => {
    const a = actionForClaudeCodeTool(
      { tool_name: verb === 'Create' ? 'Write' : 'Edit', tool_input: { file_path: abs }, cwd: ctx.cwd, scratchpad_dir: input.scratchpad_dir },
      { projectDir: ctx.project, home: ctx.home, protectedPaths: ctx.protectedPaths },
    );
    parts.push({ class: a.class, resource: a.resource ?? null, sensitive: a.sensitive === true || isProtectedPath(abs, ctx), said });
  };
  const remove = (abs, said) => {
    if (isProtectedPath(abs, ctx)) {
      parts.push({ class: 'delete', resource: REMOVE_GUARD, sensitive: true, said });
      return;
    }
    if (isInsideWorkArea(abs, ctx)) {
      parts.push({ class: 'read', resource: LOCAL_WORK_RESOURCE, sensitive: false, said });
      return;
    }
    // Outside the project: exactly what `rm` of that file would be (Never delete my data matches it).
    const c = classifyCommand(`rm -f -- ${shellQuote(abs)}`, ctx);
    parts.push({ class: c.class, resource: c.resource ?? null, sensitive: c.sensitive === true, said });
  };
  for (const f of files) {
    const abs = resolveIn(ctx, f.path);
    if (f.op === 'add') {
      write(abs, 'Create', `Create ${abs}`);
      names.push({ verb: 'Create', name: rel(abs, ctx) });
    } else if (f.op === 'delete') {
      remove(abs, `Delete ${abs}`);
      names.push({ verb: 'Delete', name: rel(abs, ctx) });
    } else if (f.moveTo) {
      const to = resolveIn(ctx, f.moveTo);
      write(to, 'Create', `Move ${abs} to ${to}`);
      remove(abs, `Move ${abs} to ${to}`);
      names.push({ verb: 'Move', name: `${rel(abs, ctx)} to ${rel(to, ctx)}` });
    } else {
      write(abs, 'Edit', `Edit ${abs}`);
      names.push({ verb: 'Edit', name: rel(abs, ctx) });
    }
  }
  const cls = strongest(...parts.map((p) => p.class));
  const sensitive = parts.some((p) => p.sensitive);
  const allLocal = parts.every((p) => p.resource === LOCAL_WORK_RESOURCE);
  const settingsChange = parts.some((p) => p.resource === REMOVE_GUARD);
  const resource = allLocal
    ? LOCAL_WORK_RESOURCE
    : settingsChange && cls === 'delete'
      ? REMOVE_GUARD
      : (parts.find((p) => p.class === cls && p.resource && p.resource !== LOCAL_WORK_RESOURCE)?.resource ?? null);
  const touchesSettings = files.some((f) => isProtectedPath(resolveIn(ctx, f.path), ctx) || (f.moveTo && isProtectedPath(resolveIn(ctx, f.moveTo), ctx)));
  // The other steps that name their own resource, once per kind, in patch order (at most 3 go).
  const seen = new Set([`${cls}\u0000${resource}`]);
  const named = [];
  for (const p of parts) {
    const key = `${p.class}\u0000${p.resource}`;
    if (!p.resource || !PART_RESOURCES.includes(p.resource) || seen.has(key)) continue;
    seen.add(key);
    named.push({ class: p.class, resource: p.resource, text: truncate(p.said, 120) });
  }
  let description;
  if (touchesSettings) {
    description = `Change Codex or Aimiru settings: ${names.map((n) => n.name).join(', ')}`;
  } else if (names.length === 1) {
    description = `${names[0].verb} ${names[0].name}`;
  } else {
    const shown = names.slice(0, 5).map((n) => n.name);
    const more = names.length > 5 ? ` and ${names.length - 5} more` : '';
    description = `Change ${names.length} files: ${shown.join(', ')}${more}`;
  }
  return { class: cls, resource, sensitive, description, parts: named };
}

// ---------------------------------------------------------------------------
// Commands: the folder Codex runs them in, and programs Codex can keep typing into
// ---------------------------------------------------------------------------

function exists(p) {
  try {
    return fs.existsSync(p);
  } catch {
    return false;
  }
}

const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
/** Words that name the whole folder a command runs in. */
const WHOLE_FOLDER = new Set(['.', './', '*', './*', '.*', '*/', './.*']);

/**
 * Whether a command's relative words could name the person's own files if Codex ran it in the home
 * folder: a word that names the whole folder, or one that names something in the home folder and
 * nothing in the session's folder. Words after a `cd` to a known place are pinned, so stop there.
 */
export function namesSomethingAtHome(command, ctx) {
  let lex;
  try {
    lex = lexShell(command);
  } catch {
    return true;
  }
  const check = (w) => {
    if (!w || w.startsWith('/') || w.startsWith('~') || w.startsWith('$')) return false;
    if (WHOLE_FOLDER.has(w)) return true;
    const plain = w.replace(/^\.\//, '');
    const glob = plain.search(/[*?[{]/);
    const named = glob >= 0 ? path.dirname(`${plain.slice(0, glob)}x`) : plain;
    if (glob >= 0 && (named === '.' || named === '')) return true;
    return exists(path.resolve(ctx.home, named)) && !exists(path.resolve(ctx.cwd, named));
  };
  for (const s of lex.segments ?? []) {
    const words = s.words ?? [];
    let i = 0;
    while (i < words.length && ASSIGNMENT.test(words[i])) i += 1;
    if (path.basename(words[i] ?? '') === 'cd') {
      const target = words[i + 1];
      if (!target || target.startsWith('/') || target.startsWith('~')) return false;
    }
    for (let k = i + 1; k < words.length; k += 1) {
      if (s.dynamic?.[k] || words[k].startsWith('-') || ASSIGNMENT.test(words[k])) continue;
      if (check(words[k])) return true;
    }
    for (const r of s.redirects ?? []) {
      if (typeof r.body === 'string' || r.dynamic) continue;
      if (check(String(r.target ?? ''))) return true;
    }
  }
  return false;
}

/**
 * A command read where Codex says the session is, and again in the home folder (Codex runs it in a
 * folder the model names and does not tell the check which). When reading it in the home folder is
 * stronger and the command names something there, the folder decides what it does: the stronger
 * class, with no resource, held when Aimiru cannot answer, so Aimiru asks.
 */
function readCommand(command, ctx) {
  const here = classifyCommand(command, ctx);
  // The pushes git looks up (CN7) are kept out of sight on the classifier's answer: carried by name.
  if (!ctx.cwd || path.resolve(ctx.cwd) === path.resolve(ctx.home)) return { ...here, folderUnknown: false, pushes: here.pushes ?? null };
  // Programs Codex wrote are looked for in the session's folder only (CN6): the home reading only
  // asks whether the folder changes what the command does.
  const atHome = classifyCommand(command, { ...ctx, cwd: ctx.home, inspectProgram: undefined });
  const worse = strongest(here.class, atHome.class) !== here.class;
  if (!worse || !namesSomethingAtHome(command, ctx)) return { ...here, folderUnknown: false, pushes: here.pushes ?? null };
  return {
    class: strongest(here.class, atHome.class),
    counterparty: here.counterparty || atHome.counterparty,
    resource: null,
    sensitive: true,
    folderUnknown: true,
    // The steps as read in the session's folder (ADR-0096): a Never there still refuses the command.
    parts: here.parts || [],
  };
}

const SHELLS = new Set(['sh', 'bash', 'zsh', 'fish', 'dash', 'ksh', 'mksh', 'tcsh', 'csh', 'ash', 'nu', 'xonsh', 'elvish', 'pwsh', 'powershell']);
const ALWAYS_TYPED = new Set(['irb', 'pry', 'ghci', 'iex', 'ipython', 'jshell', 'erl', 'scala', 'clojure', 'clj']);
const SCRIPT_FLAGS = {
  python: ['-c', '-m'],
  node: ['-e', '--eval', '-p', '--print', '--test'],
  ruby: ['-e'],
  perl: ['-e', '-E'],
  php: ['-r', '-f'],
  lua: ['-e'],
  julia: ['-e', '--eval', '-E', '--print'],
  r: ['-e', '-f', '--file'],
  osascript: ['-e'],
  tclsh: [],
};

/** True when the program, started with these words, waits for text typed into it. */
function waitsForTyping(prog, args) {
  const opts = args.filter((a) => a.startsWith('-') && a !== '-');
  const positional = args.filter((a) => !a.startsWith('-') || a === '-');
  const has = (...names) => opts.some((o) => names.includes(o) || names.some((n) => n.startsWith('--') && o.startsWith(`${n}=`)));
  const cluster = (letter) => opts.some((o) => /^-[A-Za-z]+$/.test(o) && o.includes(letter));
  if (SHELLS.has(prog)) {
    if (cluster('c') || has('-Command', '-command', '--command', '-File', '-file')) return false;
    if (cluster('s') || cluster('i')) return true;
    return positional.length === 0 || positional[0] === '-';
  }
  if (ALWAYS_TYPED.has(prog)) return !has('-c', '-e', '-eval', '-noshell');
  const family = /^(python|pypy)[0-9.]*$/.test(prog) ? 'python' : prog === 'nodejs' ? 'node' : prog === 'luajit' ? 'lua' : prog === 'wish' ? 'tclsh' : prog;
  if (SCRIPT_FLAGS[family]) {
    if (family === 'php' && has('-a')) return true;
    if (has('-i', '--interactive')) return true;
    if (has(...SCRIPT_FLAGS[family])) return false;
    return positional.length === 0 || positional[0] === '-';
  }
  if (prog === 'deno') return args.length === 0 || args[0] === 'repl';
  if (prog === 'bun') return args[0] === 'repl';
  if (prog === 'sqlite3') return !has('-cmd') && positional.length <= 1;
  if (prog === 'psql') return !has('-c', '--command', '-f', '--file');
  if (prog === 'mysql' || prog === 'mariadb') return !has('-e', '--execute') && !cluster('e');
  if (prog === 'mongosh' || prog === 'mongo') return !has('--eval', '-f', '--file') && positional.filter((p) => !p.endsWith('.js')).length <= 1;
  if (prog === 'redis-cli') {
    const rest = [];
    for (let i = 0; i < args.length; i += 1) {
      if (['-h', '-p', '-a', '-n', '-u', '-s', '--user', '--pass'].includes(args[i])) i += 1;
      else if (!args[i].startsWith('-')) rest.push(args[i]);
    }
    return rest.length === 0;
  }
  if (prog === 'su') return !has('-c', '--command');
  if (prog === 'ssh') {
    let i = 0;
    while (i < args.length && args[i].startsWith('-')) {
      const o = args[i];
      i += 1;
      if (/^-[A-Za-z]*[bcDEeFIiJLlmOoPpQRSWw]$/.test(o)) i += 1;
    }
    const remote = args.slice(i + 1);
    if (!remote.length) return true;
    return waitsForTyping(path.basename(remote[0]).toLowerCase(), remote.slice(1));
  }
  if (['docker', 'podman', 'nerdctl'].includes(prog)) {
    const sub = args.findIndex((a) => ['exec', 'run', 'attach'].includes(a));
    if (sub < 0) return false;
    if (args[sub] === 'attach') return true;
    const after = args.slice(sub + 1).filter((a) => a.startsWith('-'));
    if (args.slice(0, sub).includes('compose')) return !['-T', '--no-TTY', '-d', '--detach'].some((o) => after.includes(o));
    return after.some((o) => o === '--interactive' || (/^-[A-Za-z]+$/.test(o) && o.includes('i')));
  }
  if (prog === 'kubectl' || prog === 'oc') {
    const sub = args.findIndex((a) => ['exec', 'attach', 'run'].includes(a));
    if (sub < 0) return false;
    return args.slice(sub + 1).some((o) => o === '--stdin' || o === '--stdin=true' || (/^-[A-Za-z]+$/.test(o) && o.includes('i')));
  }
  return false;
}

/**
 * The first program in a command that is left waiting for typed text with nothing else feeding it
 * (not after a pipe, no input redirection or here-document): a shell, an interpreter, a database
 * prompt, a remote or container shell. Codex can type into it later without any check, so Aimiru
 * cannot see what it runs. Null when there is none.
 */
export function programWaitingForTyping(command) {
  let lex;
  try {
    lex = lexShell(command);
  } catch {
    return null;
  }
  for (const s of lex.segments ?? []) {
    if (s.piped) continue;
    if ((s.redirects ?? []).some((r) => typeof r.body === 'string' || /^\d*<(?!\()/.test(String(r.op ?? '')))) continue;
    const w = [...(s.words ?? [])];
    for (;;) {
      if (!w.length) break;
      if (ASSIGNMENT.test(w[0])) {
        w.shift();
        continue;
      }
      const b = path.basename(w[0]);
      if (['exec', 'command', 'builtin', 'nohup', 'time', 'caffeinate'].includes(b)) {
        w.shift();
        while (w.length && w[0].startsWith('-')) w.shift();
        continue;
      }
      if (b === 'nice') {
        w.shift();
        while (w.length && w[0].startsWith('-')) if (w.shift() === '-n') w.shift();
        continue;
      }
      if (b === 'env') {
        w.shift();
        while (w.length && (w[0].startsWith('-') || ASSIGNMENT.test(w[0]))) if (['-u', '-C', '-S', '--unset', '--chdir'].includes(w.shift())) w.shift();
        continue;
      }
      if (b === 'sudo' || b === 'doas') {
        w.shift();
        let shell = false;
        while (w.length && w[0].startsWith('-')) {
          const o = w.shift();
          if (o === '--') break;
          if (/^-[A-Za-z]+$/.test(o) && /[si]/.test(o)) shell = true;
          if (['-u', '-g', '-C', '-h', '-p', '-r', '-t', '-U', '-D', '-R', '-T'].includes(o)) w.shift();
        }
        if (shell && !w.length) return b;
        continue;
      }
      break;
    }
    if (!w.length) continue;
    const prog = path.basename(w[0]).toLowerCase();
    if (waitsForTyping(prog, w.slice(1))) return prog;
  }
  return null;
}

// ---------------------------------------------------------------------------
// One tool call
// ---------------------------------------------------------------------------

/**
 * Maps one Codex PreToolUse input to an Aimiru action:
 * {class, description, evidence, counterparty?, resource?, sensitive?, amount?, currency?, checkout?}.
 * @param {object} input  the hook's stdin JSON
 * @param {object} [opts] { projectDir (null: Codex works in no project), home, protectedPaths,
 *   evidenceKey, inspectProgram, sandbox, programAllowed }
 *   evidenceKey: the agent key, for the evidence's input_mac (ADR-0094).
 *   inspectProgram(path, kind): newness.mjs programInspector, from what the session began with;
 *   sandbox(): true when Codex's own sandbox holds this command (lib/sandbox.mjs), read only when
 *   the command runs a program Codex wrote; programAllowed(path, sha256): the person allowed that
 *   same file in this session (CN6, ADR-0090 for Codex).
 * The action also carries `neverParts` (not enumerable): a command's steps that name their own
 * resource, sent as the check's `parts` (ADR-0096); and, for a command that runs programs Codex
 * wrote, `programs` and `sandbox` (not enumerable, never sent).
 */
export function actionForCodexTool(input, opts = {}) {
  const toolName = String(input?.tool_name ?? '');
  const raw = input?.tool_input;
  const ti = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const ctx = makePathContext({
    projectDir: opts.projectDir === null ? NO_PROJECT : opts.projectDir || input?.cwd,
    cwd: input?.cwd || opts.projectDir || opts.home,
    home: opts.home,
    protectedPaths: opts.protectedPaths || [],
    sandbox: typeof opts.sandbox === 'function' ? opts.sandbox : opts.sandbox === true,
    programAllowed: opts.programAllowed,
    inspectProgram: opts.inspectProgram,
  });
  /** Programs Codex wrote that the command runs (CN6), and whether its sandbox holds them. */
  let programs = null;
  let sandboxOn = false;
  let cls = 'read';
  let description = '';
  let counterparty = null;
  let resource = null;
  let sensitive = false;
  let extra = {};
  let parts = [];
  /** The pushes git looks up the destination of (CN7), for namePushTarget once the folder is known. */
  let pushes = null;

  const fromCommand = (command, label) => {
    const c = readCommand(command, ctx);
    const said = command.replace(/\s+/g, ' ').trim();
    cls = c.class;
    counterparty = c.counterparty;
    resource = c.resource;
    sensitive = c.sensitive === true;
    parts = c.parts || [];
    pushes = c.pushes || null;
    description = c.folderUnknown ? `${label}: ${said}. Codex did not say which folder it runs in` : `${label}: ${said}`;
    if (c.programs) {
      programs = c.programs;
      sandboxOn = c.sandbox === true;
      if (resource === NEW_PROGRAM_RESOURCE) description = withProgramSentence(description, programDescription(c.programs, c.sandbox, 'Codex'));
    }
    if (c.checkout) extra = { checkout: c.checkout, ...(c.amount != null ? { amount: c.amount } : {}), ...(c.currency ? { currency: c.currency } : {}) };
    if (programWaitingForTyping(command)) {
      // Codex types into it later without a check (write_stdin), so Aimiru cannot see what it runs.
      const merged = strongest(cls, 'other');
      if (merged !== cls) resource = null;
      cls = merged;
      sensitive = true;
      description = `${label} that Codex can keep typing into: ${said}`;
    }
  };

  if (toolName === 'Bash') {
    const command = Array.isArray(ti.command) ? ti.command.map(String).join(' ') : String(ti.command ?? '');
    fromCommand(command, 'Run a command');
    for (const found of patchesInCommand(command, ctx)) {
      // A patch beside a push: the push is no longer the only step, so it names no repository.
      pushes = null;
      const p = classifyPatch(found.text, { ...ctx, cwd: found.cwd }, input);
      const merged = strongest(cls, p.class);
      if (merged !== cls) resource = p.resource;
      cls = merged;
      sensitive = sensitive || p.sensitive;
      // The patch's own named steps, and the patch itself when the command names something else.
      const own = p.resource && PART_RESOURCES.includes(p.resource) && p.resource !== resource ? [{ class: p.class, resource: p.resource, text: truncate(p.description, 120) }] : [];
      parts = [...parts, ...own, ...p.parts];
    }
  } else if (toolName === 'apply_patch') {
    const p = classifyPatch(typeof ti.command === 'string' ? ti.command : typeof raw === 'string' ? raw : '', ctx, input);
    cls = p.class;
    resource = p.resource;
    sensitive = p.sensitive;
    description = p.description;
    parts = p.parts;
  } else if (splitMcpToolName(toolName)) {
    const { server, tool } = splitMcpToolName(toolName);
    const c = classifyToolName({ server, tool, args: ti, pathContext: ctx });
    cls = c.class;
    counterparty = c.counterparty;
    resource = c.resource;
    sensitive = c.sensitive === true;
    if (c.amount != null) extra = { amount: c.amount, ...(c.currency ? { currency: c.currency } : {}) };
    if (c.checkout) extra.checkout = c.checkout;
    description = `Use ${tool} from ${server}`;
  } else if (isCodexLocalTool(toolName)) {
    cls = 'read';
    description = `Use ${toolName}`;
  } else if (WEB_SEARCH_TOOLS.has(toolName)) {
    cls = 'read';
    description = typeof ti.query === 'string' && ti.query.trim() ? `Search the web: ${ti.query.trim()}` : 'Search the web';
  } else {
    // A tool this connector does not know (new in Codex, a browser or a computer it drives): never
    // treated as plain reading, and held when Aimiru cannot answer. Text in its input that may be run
    // is read as a command, and an address as an address.
    cls = 'other';
    sensitive = true;
    description = `Use ${toolName || 'a tool'}`;
    for (const key of ['command', 'cmd', 'script', 'code']) {
      const value = Array.isArray(ti[key]) ? ti[key].map(String).join(' ') : ti[key];
      if (typeof value !== 'string' || !value.trim()) continue;
      const c = classifyCommand(value, ctx);
      const merged = strongest(cls, c.class);
      if (merged !== cls) resource = c.resource;
      cls = merged;
      counterparty = counterparty || c.counterparty;
      if (description === `Use ${toolName}`) description = `Use ${toolName}: ${value.replace(/\s+/g, ' ').trim()}`;
    }
    if (!counterparty && typeof ti.url === 'string') counterparty = counterpartyOf(ti.url);
  }

  // What the evidence quotes (ADR-0094): for a command or a patch, only its text, with a keyed MAC of
  // the whole input ahead of the 1,000 character cut, so a retry of the same step matches and two
  // steps that differ after the cut never do.
  const evidenceInput =
    toolName === 'Bash' || toolName === 'apply_patch' ? shellEvidenceInput(typeof raw === 'string' ? { command: raw } : ti) : raw ?? null;
  const action = {
    class: cls,
    description: truncate(redactSecrets(description), 280),
    // The programs' fingerprints go with the evidence, as for Claude Code (ADR-0090).
    evidence: evidenceText(toolName, evidenceInput, {
      key: opts.evidenceKey,
      programs: programs ? programs.slice(0, 8).map((p) => ({ path: truncate(p.rel, 160), sha256: p.sha256 })) : null,
      sandbox: programs ? sandboxOn : undefined,
    }),
    ...(counterparty ? { counterparty: truncate(redactSecrets(counterparty), 200) } : {}),
    ...(resource ? { resource } : {}),
    ...extra,
  };
  if (sensitive) action.sensitive = true;
  if (pushes && toolName === 'Bash' && (cls === 'send' || cls === 'delete')) Object.defineProperty(action, 'pushes', { value: pushes, enumerable: false });
  if (programs) {
    Object.defineProperty(action, 'programs', { value: programs, enumerable: false });
    Object.defineProperty(action, 'sandbox', { value: sandboxOn, enumerable: false });
  }
  Object.defineProperty(action, 'neverParts', { value: parts, enumerable: false });
  return action;
}
