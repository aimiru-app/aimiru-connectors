// Shared plumbing for Aimiru's check for Codex: settings, stdin, local state, the report Aimiru
// reads the tier from, and Codex's own files (ADR-0091).

import { createHmac, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readKeyFile } from '../vendor/pair.mjs';
import { createPauseWatch } from '../vendor/pause-watch.mjs';
import { ASK_HOLD_MS, createSaysoClient, setting, sha256Hex } from '../vendor/sayso-client.mjs';

export const CONNECTOR = 'codex';
export const VERSION = '0.3.0-rc.2';
/** The npm package (ADR-0091): unscoped, a command people run with npx, like aimiru-mcp-proxy. */
export const PACKAGE_NAME = 'aimiru-codex';
/** The line that removes the check (wave 10, shapes 3), word for word as the demo page and the README show it. */
export const UNDO_LINE = 'npx aimiru-codex uninstall';
export const AGENT_LABEL = 'Codex';

/**
 * What this connector holds, sent with every report and kept on the install's Record entry:
 * Codex's own commands (its shell tool), its file changes (apply_patch) and its tool server calls.
 * Codex's hosted tools (web search) do not pass through Codex's checks (OpenAI, Codex hooks,
 * "Tool coverage"), so they are not listed.
 */
export const COVERS = Object.freeze(['commands', 'file_changes', 'tool_servers']);

/**
 * Time for one check: 40 s in all, of which an ask holds the call at most 4 s (ADR-0145). The guard
 * (guard.mjs) stops the check at 45 s, so Codex always gets Aimiru's answer before its own time runs
 * out (a check Codex stops lets the call run). A step held while paused (ADR-0142) tells the guard to
 * wait the hold's 55 minutes too, inside the hour hooks.json gives the entry (CODEX_TIMEOUT_S).
 */
export const HOOK_BUDGET_MS = 40_000;
export const DEFAULT_ASK_BUDGET_MS = ASK_HOLD_MS;
/**
 * The longest an ask holds the call, whatever the person's reach (ADR-0145): then the call is refused
 * for now and the question stays open, and the person's yes answers Codex's next identical try, which
 * looks at the same question (ADR-0035).
 */
export const WAIT_CAP_MS = ASK_HOLD_MS;
export const GUARD_LIMIT_MS = 45_000;
/**
 * The entry's time limit in hooks.json (ADR-0142): an hour, so a step held while paused (at most 55
 * minutes) and its check after Resume end before Codex stops the entry. Written by init; an entry from
 * an older install keeps its 60 s until init runs again, and then steps are refused while paused.
 */
export const CODEX_TIMEOUT_S = 3600;
/**
 * The longest Codex is known to wait on a check: its documented default, 600 s (ADR-0091; VERIFY-LOG,
 * Codex hooks, 22 Oct). Whether Codex 0.154.0 honours the hour in hooks.json is a Mac-run fact (MR-2),
 * and a check Codex stops lets the call run, so a held step would turn into a yes past this limit.
 */
export const CODEX_PROVEN_LIMIT_MS = 600_000;
/**
 * Codex's hold ceiling until the Mac run logs a Codex hold past 600 s (quality and engineering review
 * of wk/connectors-flow, 28 Oct): 8 minutes, so the hold and the check after it end inside Codex's
 * default limit even if Codex keeps it, and the guard answers by 9 minutes 45 seconds after its start
 * whatever the check asks (guard.mjs HOLD_LIMIT_MS). The step is then refused with pauseCeilingAfter,
 * and the next step holds again: one model turn every 8 minutes of a long Pause, never a step run.
 * Raise it to HOLD_CEILING_MS (55 minutes), with the guard's limit, in the commit that logs the line.
 */
export const CODEX_HOLD_CEILING_MS = 8 * 60_000;
/**
 * Pause holds (ADR-0142): the one switch for the Mac run's finding. If Codex does not wait 90 s on a
 * check, set this to false and every step is refused while paused, as before (ADR-0022), and the
 * README's Paused row says refused. AIMIRU_PAUSE_HOLD=0 does the same on one computer.
 */
export const PAUSE_HOLDS = true;
/** The check starts the background watcher when no process of this folder has read the Pause for this long. */
export const BACKGROUND_DUE_MS = 6_000;
/** The background watcher lives while Codex works (each check extends its lease), at most this long. */
export const BACKGROUND_MAX_MS = 15 * 60_000;

/** The background's budget: BACKGROUND_MAX_MS, or shorter with AIMIRU_WATCH_BUDGET_MS (tests). */
export function backgroundBudgetMs(env = process.env) {
  return Math.min(BACKGROUND_MAX_MS, intFromEnv(env, 'WATCH_BUDGET_MS', BACKGROUND_MAX_MS));
}

/** The Pause watch for this check's data folder (pause-watch.mjs): one agent on this computer. */
export function watchFor(settings) {
  return createPauseWatch({ dataDir: settings.dataDir });
}
/** After Aimiru fails to answer, reads and local work skip the network for this long. */
export const DOWN_WINDOW_MS = 30_000;
/**
 * How often a check that ran inside Codex reports in. Aimiru reads an Enforced agent as Advised 24 hours
 * after its last report (core.effective_tier), so a check Codex stopped running stops showing Enforced.
 */
export const REPORT_EVERY_MS = 6 * 3600_000;

/** The run's budget: AIMIRU_HOOK_BUDGET_MS (or SAYSO_) can only make it shorter, never longer than HOOK_BUDGET_MS. */
export function hookBudgetMs(env = process.env) {
  return Math.min(HOOK_BUDGET_MS, intFromEnv(env, 'HOOK_BUDGET_MS', HOOK_BUDGET_MS));
}

/** A positive number setting (AIMIRU_<name>, or SAYSO_<name>), else the fallback. */
function intFromEnv(env, name, fallback) {
  const v = Number(setting(env, name));
  return Number.isFinite(v) && v > 0 ? v : fallback;
}

function homeOf(env) {
  return env.HOME || env.USERPROFILE || os.homedir();
}

/** Where this connector keeps its key, its waiting questions and its records: ~/.sayso/codex (AIMIRU_CODEX_DATA or SAYSO_CODEX_DATA moves it). */
export function dataDirOf(env = process.env) {
  return setting(env, 'CODEX_DATA') || path.join(homeOf(env), '.sayso', 'codex');
}

/** Codex's own folder (CODEX_HOME, else ~/.codex), where its user settings and hooks.json live. */
export function codexHomeOf(env = process.env) {
  return env.CODEX_HOME || path.join(homeOf(env), '.codex');
}

export const KEY_FILE = 'key.json';

export function keyFilePath(dataDir) {
  return path.join(dataDir, KEY_FILE);
}

/**
 * Settings: the key from AIMIRU_AGENT_TOKEN (or SAYSO_AGENT_TOKEN) or the key file init saved
 * (owner-only, with the address it was made for), the address from AIMIRU_BASE_URL (or
 * SAYSO_BASE_URL, AIMIRU_URL, SAYSO_URL) or that file.
 */
export function loadSettings(env = process.env) {
  const configuredToken = (setting(env, 'AGENT_TOKEN') || '').trim();
  const configuredUrl = (setting(env, 'BASE_URL') || setting(env, 'URL') || '').trim();
  const dataDir = dataDirOf(env);
  const saved = configuredToken ? null : readKeyFile(keyFilePath(dataDir));
  const token = configuredToken || saved?.key || '';
  const baseUrl = saved ? saved.baseUrl || configuredUrl : configuredUrl;
  return {
    token,
    baseUrl,
    keySource: configuredToken ? 'env' : saved ? 'file' : null,
    dataDir,
    codexHome: codexHomeOf(env),
    home: homeOf(env),
    checkTimeoutMs: intFromEnv(env, 'CHECK_TIMEOUT_MS', 10_000),
    // Null unless the person set it: an ask then holds the call 4 s (ADR-0145); set, only shorter.
    askBudgetMs: intFromEnv(env, 'ASK_BUDGET_MS', null),
  };
}

export function makeClient(settings, { spool = true } = {}) {
  return createSaysoClient({
    baseUrl: settings.baseUrl,
    token: settings.token,
    connector: `${CONNECTOR}/${VERSION}`,
    agentLabel: AGENT_LABEL,
    spoolDir: spool ? settings.dataDir : undefined,
    timeouts: { checkMs: settings.checkTimeoutMs },
  });
}

/** Reads all of stdin as JSON. Returns {} for empty input; throws on invalid JSON. */
export async function readStdinJson({ maxBytes = 8 * 1024 * 1024 } = {}) {
  if (process.stdin.isTTY) return {};
  const chunks = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    size += chunk.length;
    if (size > maxBytes) throw new Error('input too large');
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString('utf8').trim();
  if (!raw) return {};
  return JSON.parse(raw);
}

/**
 * Refuses a call in the one way Codex reads before anything the person's login shell prints: the
 * reason on stderr and exit 2. Codex runs the entry through `$SHELL -lc`, so a profile that prints
 * puts its text ahead of stdout, and a refusal written there as JSON would read as no refusal at all
 * (openai/codex codex-rs/hooks/src/events/pre_tool_use.rs, parse_completed; output_parser.rs,
 * looks_like_json). Exit 2 with a reason on stderr blocks whatever stdout holds.
 */
export function refuseAndExit(reason) {
  process.stderr.write(`${String(reason).trim()}\n`, () => process.exit(2));
}

/**
 * The project the call belongs to: the git folder that holds Codex's working folder (Codex may start
 * in a subfolder), else the working folder itself. Codex sends only `cwd`.
 *
 * Never the home folder or a folder above it, even when it is a git folder (a home kept in git):
 * there the whole home folder would count as the project, and "Never delete my data" would never see
 * a deletion of the person's files. Null then: Codex works in no project (ADR-0091).
 */
export function projectDirOf(cwd, home = os.homedir()) {
  if (!cwd || typeof cwd !== 'string') return null;
  const start = path.resolve(cwd);
  const h = path.resolve(home || os.homedir());
  const homeOrAbove = (d) => d === h || h.startsWith(d.endsWith(path.sep) ? d : d + path.sep);
  let dir = start;
  for (let i = 0; i < 40; i += 1) {
    if (homeOrAbove(dir)) break;
    try {
      if (fs.existsSync(path.join(dir, '.git'))) return dir;
    } catch {
      break;
    }
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return homeOrAbove(start) ? null : start;
}

/**
 * True when the input has the shape of Codex's own PreToolUse call: the fields Codex sends that a
 * person typing JSON by hand is unlikely to (turn_id and model are Codex's own additions, OpenAI's
 * hook reference). The shape alone proves nothing: see ranInsideCodex.
 */
export function looksLikeCodexRun(input) {
  return (
    input?.hook_event_name === 'PreToolUse' &&
    typeof input?.turn_id === 'string' &&
    input.turn_id !== '' &&
    typeof input?.model === 'string' &&
    typeof input?.tool_use_id === 'string'
  );
}

/** How much of the end of a transcript is read when looking for the call (Codex appends it last). */
export const TRANSCRIPT_TAIL_BYTES = 8 * 1024 * 1024;

/** How recently Codex must have written the transcript: it writes the call just before the check. */
export const TRANSCRIPT_FRESH_MS = 10 * 60_000;

/**
 * Code mode (ranInsideCodex): how recently the model's call must have been written to count once its
 * output is in the transcript too. Codex writes the call, runs the check, then writes the output.
 */
export const CALL_RECENT_MS = 5_000;

/**
 * True only when Codex itself ran this check (wave 10, T3), so only then does it count as "the check
 * ran inside Codex" for the report Aimiru reads the tier from. Besides Codex's own fields, the
 * transcript Codex names (transcript_path) must be a real file inside Codex's sessions folder
 * ($CODEX_HOME/sessions, links resolved), named for this session (rollout-<time>-<session_id>.jsonl;
 * a file name never holds a slash, so a session id with one never matches),
 * written in the last few minutes, that already holds this call as the model's call
 * ("call_id":"<tool_use_id>"). Codex 0.154.0 writes the model's call to that file, in that form,
 * before it runs PreToolUse, for commands and patches alike (checked 22 Oct 2026 against the real
 * codex with a sandboxed CODEX_HOME and a stand-in model). Codex's documented input piped into the
 * entry by hand names no such file, and naming another session's file, a word that happens to be in
 * one, or an old call does not count either (wave 10 review, finding 3): the call is still checked,
 * but Aimiru keeps showing Codex as Advised. A session Codex keeps no transcript for shows Advised
 * too: the tier never says more than this can prove.
 *
 * Code mode (Codex 0.165.0 with a real model, Rohit's Mac, 28 Oct 2026, ChatGPT sign-in, its own
 * CODEX_HOME): the model runs commands from JavaScript it writes, one custom tool call named exec,
 * {"type":"custom_tool_call","call_id":"call_...","name":"exec","input":"await
 * tools.exec_command({cmd:\"echo hi\",max_output_tokens:1000});\n"}, which Codex writes to the
 * transcript before the check and follows with its output after. Codex checks each command that
 * code runs as tool_name Bash with tool_use_id exec-<id>, an inner id the transcript never holds, so
 * the call-id match above cannot hold there; CODEX_HOME, transcript_path, the file's name and its
 * freshness hold as above. So for such a step (an exec- id and a command) the same file must hold,
 * in the part read, the model's own call that hands Codex this exact command (handsCommand): an exec
 * call whose code gives it as the whole value of a cmd key ({cmd:"..."}, as exec_command takes it)
 * or as apply_patch's one argument, read from the text around it (handedWhole), or a function call
 * whose arguments' cmd is it. That call must still wait for its output or have been written in the
 * last few seconds (CALL_RECENT_MS). An older call that already has its output does not count, nor
 * a command only mentioned (in a message, the model's reasoning, an event, an output, a comment,
 * another key's value or quoted in a longer command), nor a plain id the file lacks, nor input piped
 * in by hand that names no live transcript. In code mode this replaces the call-id match and is no
 * stronger: a process that can read this session's transcript while a call waits can satisfy
 * either. `codeMode: false` leaves this part out (callArgsOf, which reads no arguments from it).
 */
export function ranInsideCodex(input, { codexHome, tailBytes = TRANSCRIPT_TAIL_BYTES, now = Date.now(), codeMode = true } = {}) {
  if (!looksLikeCodexRun(input) || !input.tool_use_id || !codexHome) return false;
  const session = input.session_id;
  if (typeof session !== 'string' || session === '') return false;
  const file = input.transcript_path;
  if (typeof file !== 'string' || !path.isAbsolute(file)) return false;
  let fd = null;
  try {
    const sessions = fs.realpathSync(path.join(codexHome, 'sessions'));
    const real = fs.realpathSync(file);
    if (!real.startsWith(sessions + path.sep)) return false;
    // This session's own transcript, as Codex names it, not any session's.
    if (!path.basename(real).endsWith(`-${session}.jsonl`)) return false;
    fd = fs.openSync(real, 'r');
    const st = fs.fstatSync(fd);
    if (!st.isFile() || st.size === 0) return false;
    // Codex has just written this call to it; a file untouched for longer is not this run.
    if (Math.abs(now - st.mtimeMs) > TRANSCRIPT_FRESH_MS) return false;
    const length = Math.min(st.size, tailBytes);
    const buf = Buffer.alloc(length);
    fs.readSync(fd, buf, 0, length, st.size - length);
    // The model's call itself, keyed and quoted, so call_ab1 never matches call_ab12 and a word
    // elsewhere in the file ("response_item") never counts.
    if (buf.includes(Buffer.from(`"call_id":${JSON.stringify(input.tool_use_id)}`, 'utf8'))) return true;
    // Code mode: the step's id is Codex's own, so the model's call is found by the command it hands Codex.
    return codeMode && isCodeModeStep(input) && codeModeCallWaits(buf.toString('utf8'), input.tool_input.command, now);
  } catch {
    return false;
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {
        // already closed
      }
    }
  }
}

/** A command Codex runs from the model's code (code mode): Codex's own id, exec-<id>, and a command. */
function isCodeModeStep(input) {
  const command = input.tool_input?.command;
  return /^exec-./.test(input.tool_use_id) && typeof command === 'string' && command.trim() !== '';
}

/**
 * How the model's code may spell a command as a string literal: in double quotes with JSON's escapes
 * (as the Mac run's model wrote every one), and, when the command needs no escape there, in single
 * quotes or backquotes (never one holding ${, which JavaScript fills in). A spelling counts only where
 * the call hands it to Codex whole (handedWhole); anywhere else the command is only mentioned.
 */
function spellingsOf(command) {
  const spellings = [JSON.stringify(command)];
  if (!/['\\\n\r\u2028\u2029]/.test(command)) spellings.push(`'${command}'`);
  if (!/[`\\\r]|\$\{/.test(command)) spellings.push(`\`${command}\``);
  return spellings;
}

/**
 * What comes just before a value the model's code hands Codex: a cmd key (exec_command's {cmd: ...},
 * bare or quoted), or apply_patch's opening parenthesis. The first character is one no name ends in.
 */
const CMD_KEY_BEFORE = /[^\w$](?:cmd|"cmd"|'cmd')\s*:\s*$/;
const PATCH_ARG_BEFORE = /[^\w$]apply_patch\s*\(\s*$/;

/**
 * Whether `code` (the model's JavaScript) hands Codex `spelling` whole, read from the text around it:
 * a cmd key just before it and the next key or the object's end just after, or apply_patch's
 * parentheses on both sides. The same text quoted in a longer command, as another key's value, in a
 * comment or as another function's argument does not count. The code is read as text, not parsed: a
 * longer string that itself spells out a cmd key ("echo cmd:'x',y") passes 'x' for a cmd value. That
 * reaches no further than the transcript it needs: whoever reads it can name the call's real command.
 */
function handedWhole(code, spelling) {
  for (let at = code.indexOf(spelling); at !== -1; at = code.indexOf(spelling, at + 1)) {
    // 64 characters either side: more space than that between the key and its value never counts.
    const before = at <= 64 ? ` ${code.slice(0, at)}` : code.slice(at - 64, at);
    const after = code.slice(at + spelling.length, at + spelling.length + 64);
    if (CMD_KEY_BEFORE.test(before) && /^\s*[,}]/.test(after)) return true;
    if (PATCH_ARG_BEFORE.test(before) && /^\s*\)/.test(after)) return true;
  }
  return false;
}

/**
 * Whether the model's call (modelCallOf) hands Codex exactly this command (code mode): a function
 * call whose arguments' cmd is the command, or a custom tool call named exec (the model's code, the
 * one shape the Mac run saw) that hands one of its spellings whole (handedWhole).
 */
function handsCommand(call, command, spellings) {
  if (call.type === 'function_call') {
    try {
      return JSON.parse(call.said)?.cmd === command;
    } catch {
      return false;
    }
  }
  return call.type === 'custom_tool_call' && call.name === 'exec' && spellings.some((s) => handedWhole(call.said, s));
}

/** A transcript line read as the model's call ({type, name, id, said, at}), or null for any other line. */
function modelCallOf(line) {
  let item;
  try {
    item = JSON.parse(line);
  } catch {
    return null;
  }
  const p = item?.type === 'response_item' ? item.payload : null;
  if (typeof p?.call_id !== 'string' || p.call_id === '') return null;
  const said = p.type === 'custom_tool_call' ? p.input : p.type === 'function_call' ? p.arguments : null;
  return typeof said === 'string' ? { type: p.type, name: p.name, id: p.call_id, said, at: Date.parse(item.timestamp ?? '') } : null;
}

/**
 * Whether a transcript line is the output of the model's call `id`: a response item whose type ends
 * in _output (custom_tool_call_output, function_call_output).
 */
function isOutputOf(line, id) {
  try {
    const item = JSON.parse(line);
    const p = item?.type === 'response_item' ? item.payload : null;
    return p?.call_id === id && typeof p.type === 'string' && p.type.endsWith('_output');
  } catch {
    return false;
  }
}

/** A "call_id" field as written in a transcript line; its value, a JSON string, is read by JSON.parse. */
const CALL_ID_FIELD = /"call_id"\s*:\s*("(?:[^"\\]|\\.)*")/g;

/**
 * Whether the end of a transcript holds the model's own call for this command that Codex is running
 * now (ranInsideCodex, code mode): a call that hands Codex the command (handsCommand) and was written
 * in the last CALL_RECENT_MS, or still waits for its output. Each line is searched at most twice,
 * however many calls ran the command: once for the calls, then, only for older calls of it, once for
 * their outputs.
 */
function codeModeCallWaits(text, command, now) {
  const spellings = spellingsOf(command);
  const lines = text.split('\n');
  const older = new Set();
  for (const line of lines) {
    // Only the model's calls are read for the command (outputs are "..._output", never these).
    if (!line.includes('"type":"custom_tool_call"') && !line.includes('"type":"function_call"')) continue;
    const call = modelCallOf(line);
    if (!call || !handsCommand(call, command, spellings)) continue;
    if (Math.abs(now - call.at) <= CALL_RECENT_MS) return true;
    older.add(call.id);
  }
  if (older.size === 0) return false;
  // An older call counts only while it waits: each output ends the wait of the call it answers.
  for (const line of lines) {
    if (!line.includes('_output"')) continue;
    for (const [, field] of line.matchAll(CALL_ID_FIELD)) {
      let id;
      try {
        id = JSON.parse(field);
      } catch {
        continue;
      }
      if (older.has(id) && isOutputOf(line, id)) older.delete(id);
    }
    if (older.size === 0) return false;
  }
  return true;
}

/**
 * The model's own arguments for this call (exec_command's cmd, workdir, sandbox_permissions ...),
 * read from the session's transcript ranInsideCodex trusts: Codex sends the check only the command
 * text. {args} (args may be null when the call has none that read as an object), or null when the
 * transcript cannot be read or the call is not in it. The keys are a Mac-run fact to confirm. In code
 * mode (an exec-<id> step, ranInsideCodex) no line holds the step's id and the model's call is its
 * JavaScript, so this is null, and the model's calls are not even read for it (codeMode: false):
 * Codex's sandbox then reads as unknown and a push's folder as not known, both toward asking.
 */
export function callArgsOf(input, { codexHome, tailBytes = TRANSCRIPT_TAIL_BYTES, now = Date.now() } = {}) {
  if (!ranInsideCodex(input, { codexHome, tailBytes, now, codeMode: false })) return null;
  let text;
  try {
    const fd = fs.openSync(fs.realpathSync(input.transcript_path), 'r');
    try {
      const size = fs.fstatSync(fd).size;
      const length = Math.min(size, tailBytes);
      const buf = Buffer.alloc(length);
      fs.readSync(fd, buf, 0, length, size - length);
      text = buf.toString('utf8');
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return null;
  }
  // The model's call itself: the newest line for this call that carries its arguments.
  const key = `"call_id":${JSON.stringify(input.tool_use_id)}`;
  let found = false;
  let args = null;
  for (const line of text.split('\n').reverse()) {
    if (!line.includes(key)) continue;
    try {
      const item = JSON.parse(line);
      const payload = item?.payload ?? item;
      if (payload?.call_id !== input.tool_use_id || !('arguments' in payload || 'input' in payload)) continue;
      const raw = payload.arguments ?? payload.input;
      args = typeof raw === 'string' && /^\s*\{/.test(raw) ? JSON.parse(raw) : raw;
      found = true;
      break;
    } catch {
      return null;
    }
  }
  if (!found) return null;
  return { args: args && typeof args === 'object' && !Array.isArray(args) ? args : null };
}

/**
 * The folder Codex runs this call's command in (CN7), when its session transcript says so: Codex
 * runs a command in the folder the model names (exec_command's `workdir`, read relative to the
 * session's folder) and never tells the check which (callArgsOf). The session's folder when the
 * call names none. Null when the call cannot be read: the folder is then unknown.
 */
export function callFolderOf(input, opts = {}) {
  if (typeof input?.cwd !== 'string' || !path.isAbsolute(input.cwd)) return null;
  const call = callArgsOf(input, opts);
  if (!call) return null;
  const { args } = call;
  const session = path.resolve(input.cwd);
  if (!args) return session;
  const named = [args.workdir, args.cwd].find((v) => v !== undefined && v !== null);
  if (named === undefined) return session;
  return typeof named === 'string' && named.trim() ? path.resolve(session, named) : null;
}

// ---------------------------------------------------------------------------
// Local state in ~/.sayso/codex
// ---------------------------------------------------------------------------

function safeName(s) {
  return String(s).replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 120) || 'none';
}

function readJsonFile(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

export function writeJsonFile(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(obj), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

/**
 * A MAC over a waiting question and the call it belongs to, keyed by the Aimiru key, as Aimiru for
 * Claude Code keeps it: a question file copied or written for another call does not verify, so an
 * earlier yes is never applied to a different command.
 */
function pendingMac(secret, fp, data) {
  const words = typeof data.explain === 'string' && data.explain ? `\n${data.explain}` : '';
  // What Aimiru said with the ask (ADR-0094): the reach and whether a yes can be used again.
  const call = data.call && typeof data.call === 'object' ? `\ncall:${JSON.stringify(data.call)}` : '';
  // The programs the question was about, by file and content (CN6): a yes is for those only.
  const programs = Array.isArray(data.programs) ? `\nprograms:${JSON.stringify(data.programs)}` : '';
  return createHmac('sha256', `sayso-pending:${secret}`).update(`${fp}\n${data.exceptionId ?? ''}\n${data.actionId ?? ''}${words}${call}${programs}`).digest('hex');
}

function macEqual(a, b) {
  const x = Buffer.from(String(a ?? ''), 'utf8');
  const y = Buffer.from(String(b ?? ''), 'utf8');
  return x.length === y.length && x.length > 0 && timingSafeEqual(x, y);
}

export function stateStore(dataDir, { secret = '' } = {}) {
  const pendingDir = path.join(dataDir, 'pending');
  const healthFile = path.join(dataDir, 'health.json');
  const statusFile = path.join(dataDir, 'status.json');

  return {
    dataDir,
    statusFile,
    /** An ask that ran out of this check's time: the same call later waits on the same question. */
    putPending(fp, data) {
      if (!secret) return;
      writeJsonFile(path.join(pendingDir, `${safeName(fp)}.json`), { ...data, mac: pendingMac(secret, fp, data), ts: Date.now() });
    },
    getPending(fp) {
      const v = readJsonFile(path.join(pendingDir, `${safeName(fp)}.json`));
      if (!v) return null;
      if (!secret || !macEqual(v.mac, pendingMac(secret, fp, v))) {
        this.deletePending(fp);
        return null;
      }
      const expires = v.expiresAt ? Date.parse(v.expiresAt) : v.ts + 15 * 60_000;
      if (Number.isFinite(expires) && expires < Date.now()) {
        this.deletePending(fp);
        return null;
      }
      return v;
    },
    deletePending(fp) {
      try {
        fs.rmSync(path.join(pendingDir, `${safeName(fp)}.json`), { force: true });
      } catch {
        // ignore
      }
    },
    isDown(now = Date.now()) {
      const h = readJsonFile(healthFile);
      return Boolean(h && h.downUntil && h.downUntil > now);
    },
    markDown(ms = DOWN_WINDOW_MS) {
      try {
        writeJsonFile(healthFile, { downUntil: Date.now() + ms });
      } catch {
        // ignore
      }
    },
    markUp() {
      try {
        if (fs.existsSync(healthFile)) fs.rmSync(healthFile, { force: true });
      } catch {
        // ignore
      }
    },
    readStatus() {
      return readJsonFile(statusFile) || {};
    },
    /** Merges into status.json (what init and the check last learned; never the key). */
    updateStatus(patch) {
      try {
        writeJsonFile(statusFile, { ...(readJsonFile(statusFile) || {}), ...patch });
      } catch {
        // a read-only disk keeps nothing; the next check reports again
      }
    },
    /** Removes waiting questions older than maxAgeMs. */
    cleanup(maxAgeMs = 24 * 3600_000) {
      let names = [];
      try {
        names = fs.readdirSync(pendingDir);
      } catch {
        return;
      }
      for (const n of names) {
        const f = path.join(pendingDir, n);
        try {
          if (Date.now() - fs.statSync(f).mtimeMs > maxAgeMs) fs.rmSync(f, { force: true });
        } catch {
          // ignore
        }
      }
    },
  };
}

/** The same call in the same session: same tool, same input (for a command or a patch, only its text). */
export function fingerprint(input) {
  const ti = input?.tool_input && typeof input.tool_input === 'object' ? { ...input.tool_input } : { value: input?.tool_input ?? null };
  delete ti.description;
  const what = ['Bash', 'apply_patch'].includes(input?.tool_name) && typeof ti.command === 'string' ? { command: ti.command } : ti;
  return sha256Hex(`${input?.session_id ?? ''}\n${input?.tool_name ?? ''}\n${JSON.stringify(what)}`).slice(0, 40);
}

/**
 * Whether the check should report in now (ADR-0091): Aimiru shows Codex as Enforced only once the
 * check has really run inside Codex, which Codex allows only after the person trusts it. So the first
 * run after an install reports, then one every REPORT_EVERY_MS, and again after an update.
 */
export function reportDue(status, now = Date.now()) {
  if (!status || typeof status !== 'object') return true;
  if (status.hook_version !== VERSION) return true;
  const at = Date.parse(status.hook_reported_at ?? '');
  if (!Number.isFinite(at)) return true;
  if (lastInstallAt(status) >= at) return true;
  return now - at > REPORT_EVERY_MS || now < at - 60_000;
}

/**
 * When init last ran on this computer: its own note (installed_at), or its report to Aimiru,
 * whichever is later; -Infinity before any. An init whose report failed still counts (wave 10
 * review, finding 6), so a run from before it never stands for the entry init has just rewritten.
 */
export function lastInstallAt(status) {
  const times = [status?.installed_at, status?.install_reported_at].map((t) => Date.parse(t ?? '')).filter(Number.isFinite);
  return times.length ? Math.max(...times) : -Infinity;
}

/** Whether the check has run inside Codex (and reported) since init last ran: the person trusted it. */
export function ranSinceInstall(status) {
  const at = Date.parse(status?.hook_reported_at ?? '');
  return Number.isFinite(at) && !(lastInstallAt(status) >= at);
}

/**
 * The report init sends: installed, waiting for the person to trust it in Codex (Advised until the
 * check runs inside Codex). The brief entry sends the same when init's never reached Aimiru (ADR-0157),
 * so a report names Codex's own connector and its version before the first brief.
 */
export function installReport({ codexVersion: cv = null, source = 'unknown', checksOff = false } = {}) {
  return {
    connector: CONNECTOR,
    version: VERSION,
    client_version: cv,
    install_source: source,
    environment: {
      step: 'install',
      // Codex skips a new or changed check until the person trusts it: not run yet.
      hook_ran: false,
      hooks_enabled: !checksOff,
      on_failure_block: true,
      covers: [...COVERS],
      platform: process.platform,
      node: process.versions.node,
    },
  };
}

/** True once a report reached Aimiru since init last ran here: init's own, or the check's (ADR-0157). */
export function reportedSinceInstall(status) {
  const installed = Date.parse(status?.installed_at ?? '');
  if (!Number.isFinite(installed)) return true;
  return [status?.install_reported_at, status?.hook_reported_at].some((t) => Date.parse(t ?? '') >= installed);
}

/** The report a check that ran inside Codex sends: Aimiru reads the tier from these facts. */
export function checkReport({ status = {}, input = {}, env = process.env } = {}) {
  // Whether Codex's own sandbox held the last command a check read it for (CN6, lib/sandbox.mjs),
  // kept in status.json when it changes: reading it here would put `ps` on the answer's path.
  const sandbox = status?.sandbox;
  return {
    connector: CONNECTOR,
    version: VERSION,
    client_version: typeof status.codex_version === 'string' ? status.codex_version.slice(0, 40) : null,
    install_source: typeof status.install_source === 'string' ? status.install_source : 'unknown',
    environment: {
      step: 'check',
      // Codex ran this check, which it does only for a check the person trusted.
      hook_ran: true,
      hooks_enabled: true,
      // The guard turns a check that dies or runs out of time into a refusal (guard.mjs).
      on_failure_block: env.SAYSO_CODEX_GUARD === '1',
      covers: [...COVERS],
      ...(typeof input.permission_mode === 'string' ? { permission_mode: input.permission_mode.slice(0, 40) } : {}),
      sandbox: ['on', 'off', 'unknown'].includes(sandbox) ? sandbox : 'unknown',
      platform: process.platform,
      node: process.versions.node,
    },
  };
}
