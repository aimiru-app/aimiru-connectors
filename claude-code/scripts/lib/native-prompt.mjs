// Would Claude Code have asked the person about this call on its own? (ADR-0040)
//
// Claude Code's hook input carries `permission_mode` but no field that says whether Claude Code
// itself would show a permission prompt (hooks reference, read 21 Oct 2026; docs/VERIFY-LOG.md).
// So the connector works it out the way Claude Code's documentation describes it:
//
//   1. The baseline is Claude Code's own default: Manual mode (config value `default`) with the
//      person's allow, ask and deny lists from their Claude Code settings files.
//   2. It is a lower bound. Manual mode offers "Yes, and don't ask again", so a person who always
//      takes it is asked once per command prefix and repository (Bash), once per session (file
//      edits), once per domain and repository (WebFetch), once per repository (WebSearch) and once
//      per tool and repository (tool servers). Later calls with the same key count as "would not
//      have asked". When in doubt the answer is the one that keeps the count lower.
//   3. Only prompts Aimiru stood in for are counted. Aimiru's plain allow prints nothing (ADR-0009),
//      so in a session where Claude Code still asks by itself (Manual mode, acceptEdits for anything
//      but in-project edits outside protected paths, an explicit ask rule in any mode, removing a
//      critical path) the call is `null`: Claude Code's own prompt still appeared, and nothing is
//      claimed. Plan and dontAsk sessions, an unknown mode and an unknown tool are `null` too, and so
//      is a call whose keys cannot be remembered.
//   4. When a settings file exists but cannot be read, the lists are unknown: the answer comes from
//      the kind of tool alone and is marked as an estimate.
//
// Nothing here changes what Aimiru decides or what Claude Code runs. Only the verdict
// (true, false or nothing) and whether it is an estimate leave this computer.

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { lexShell } from '../vendor/classify.mjs';

/** The permission modes the hooks reference lists for `permission_mode`. */
export const PERMISSION_MODES = Object.freeze(['default', 'plan', 'acceptEdits', 'auto', 'dontAsk', 'bypassPermissions']);

/** Tools that prompt in Manual mode (tools reference, "Permission required: Yes"). */
const NEEDS_PERMISSION = new Set([
  'Artifact',
  'Bash',
  'Edit',
  'EnterWorktree',
  'ExitPlanMode',
  'Monitor',
  'MultiEdit',
  'NotebookEdit',
  'PowerShell',
  'ShareOnboardingGuide',
  'Skill',
  'WebFetch',
  'WebSearch',
  'Workflow',
  'Write',
]);

/** Tools that never prompt in Manual mode inside the working directories ("Permission required: No"). */
const NO_PERMISSION = new Set([
  'Agent',
  'AskUserQuestion',
  'BashOutput',
  'CronCreate',
  'CronDelete',
  'CronList',
  'EndConversation',
  'EnterPlanMode',
  'ExitWorktree',
  'Glob',
  'Grep',
  'KillBash',
  'KillShell',
  'LS',
  'LSP',
  'ListAgents',
  'ListMcpResourcesTool',
  'NotebookRead',
  'PushNotification',
  'Read',
  'ReadMcpResourceDirTool',
  'ReadMcpResourceTool',
  'RemoteTrigger',
  'ReportFindings',
  'ScheduleWakeup',
  'SendFeedback',
  'SendMessage',
  'SendUserFile',
  'SubagentHandback',
  'Task',
  'TaskCreate',
  'TaskGet',
  'TaskList',
  'TaskOutput',
  'TaskStop',
  'TaskUpdate',
  'TodoRead',
  'TodoWrite',
  'ToolSearch',
  'WaitForMcpServers',
]);

const FILE_EDIT_TOOLS = new Set(['Edit', 'MultiEdit', 'Write', 'NotebookEdit']);
const SHELL_TOOLS = new Set(['Bash', 'PowerShell', 'Monitor']);

/** Wrappers Claude Code strips before matching a Bash rule (permissions, "Wrappers"). */
const WRAPPERS = new Set(['timeout', 'time', 'nice', 'nohup', 'stdbuf', 'command', 'builtin', 'noglob']);

/** acceptEdits also lets these run on paths inside the working directories (permission modes). */
const ACCEPT_EDITS_COMMANDS = new Set(['mkdir', 'touch', 'rm', 'rmdir', 'mv', 'cp', 'sed']);

/**
 * Commands Claude Code runs without a prompt in every mode (permissions, "Read-only commands").
 * The documented set "includes" the first line; the rest are read-only programs it is likely to
 * hold too. A larger set only makes the count smaller, which is the safe direction.
 */
const READ_ONLY = new Set([
  'ls', 'cat', 'echo', 'pwd', 'head', 'tail', 'grep', 'find', 'wc', 'which', 'diff', 'stat', 'du', 'cd',
  'egrep', 'fgrep', 'rg', 'ag', 'printf', 'tree', 'less', 'more', 'sort', 'uniq', 'cut', 'tr', 'nl',
  'basename', 'dirname', 'realpath', 'readlink', 'date', 'whoami', 'id', 'hostname', 'uname', 'df',
  'file', 'ps', 'cmp', 'comm', 'column', 'fold', 'od', 'hexdump', 'xxd', 'strings', 'sha256sum',
  'shasum', 'md5sum', 'md5', 'cksum', 'true', 'false', 'test', '[', 'seq', 'printenv', 'type',
  'whereis', 'jq', 'yq', 'lsof', 'uptime', 'locale', 'tty', 'groups', 'arch', 'sw_vers', 'nproc', 'sed',
]);

/** Read-only git subcommands (the documented "read-only forms of git"). */
const GIT_READ_ONLY = new Set([
  'status', 'log', 'diff', 'show', 'rev-parse', 'ls-files', 'describe', 'blame', 'shortlog',
  'reflog', 'ls-tree', 'cat-file', 'show-ref', 'grep', 'merge-base', 'name-rev', 'for-each-ref',
  'count-objects', 'whatchanged', 'version', 'help', 'ls-remote', 'rev-list', 'show-branch',
]);

const FIND_ACTIONS = /^-(exec|execdir|ok|okdir|delete|fprint|fprint0|fprintf|fls|files0-from)$/;
const SPECIAL_VARS = /^(PATH|IFS|PS4|BASH_ENV|ENV|PROMPT_COMMAND|LD_PRELOAD|LD_LIBRARY_PATH|DYLD_[A-Z_]+|CDPATH)=/;
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
const MAX_COMMAND = 10_000;
const MAX_RULES = 2_000;

// ---------------------------------------------------------------------------
// Settings files (settings, "Settings files and who they affect"; read 21 Oct 2026)

/** The git repository root above dir (a `.git` folder or file), or null. */
export function gitRootOf(dir) {
  let cur = dir ? path.resolve(dir) : null;
  for (let i = 0; cur && i < 64; i += 1) {
    try {
      if (fs.existsSync(path.join(cur, '.git'))) return cur;
    } catch {
      return null;
    }
    const up = path.dirname(cur);
    if (up === cur) break;
    cur = up;
  }
  return null;
}

/** Managed settings files for this platform: the file, then the drop-in folder's files in name order. */
export function managedSettingsFiles(platform = process.platform) {
  const dir =
    platform === 'darwin'
      ? '/Library/Application Support/ClaudeCode'
      : platform === 'win32'
        ? 'C:\\Program Files\\ClaudeCode'
        : '/etc/claude-code';
  const files = [path.join(dir, 'managed-settings.json')];
  try {
    const dropIn = path.join(dir, 'managed-settings.d');
    for (const f of fs.readdirSync(dropIn).filter((n) => n.endsWith('.json')).sort()) files.push(path.join(dropIn, f));
  } catch {
    // no drop-in folder
  }
  return files;
}

/**
 * Every settings file Claude Code reads permission rules from, with its scope: managed, user
 * (CLAUDE_CONFIG_DIR or ~/.claude), the shared project file in the primary working directory, and
 * the local file at the repository root (and in the starting folder, where older versions kept it).
 */
export function settingsFiles({ env = process.env, projectDir = null, home = os.homedir(), managed = null } = {}) {
  const files = [];
  for (const f of managed ?? managedSettingsFiles()) files.push({ scope: 'managed', file: f });
  const configDir = env.CLAUDE_CONFIG_DIR ? path.resolve(env.CLAUDE_CONFIG_DIR) : path.join(home, '.claude');
  files.push({ scope: 'user', file: path.join(configDir, 'settings.json') });
  if (projectDir) {
    const root = gitRootOf(projectDir) ?? projectDir;
    files.push({ scope: 'project', file: path.join(projectDir, '.claude', 'settings.json') });
    files.push({ scope: 'local', file: path.join(root, '.claude', 'settings.local.json') });
    if (path.resolve(root) !== path.resolve(projectDir)) {
      files.push({ scope: 'local', file: path.join(projectDir, '.claude', 'settings.local.json') });
    }
  }
  return files;
}

function stringList(v) {
  return Array.isArray(v) ? v.filter((x) => typeof x === 'string' && x.length > 0 && x.length <= 1000).slice(0, MAX_RULES) : [];
}

/**
 * The permission lists from the settings files, merged (lists combine across files). A file that
 * does not exist is fine; one that exists and cannot be read or parsed makes the lists unknown.
 * `allowManagedPermissionRulesOnly` in a managed file keeps only the managed rules.
 */
export function readPermissionSettings(files, { readFile = (f) => fs.readFileSync(f, 'utf8') } = {}) {
  const byScope = [];
  const unreadable = [];
  let managedOnly = false;
  for (const { scope, file } of files) {
    let raw;
    try {
      raw = readFile(file);
    } catch (err) {
      if (err && (err.code === 'ENOENT' || err.code === 'ENOTDIR')) continue;
      unreadable.push(scope);
      continue;
    }
    let json;
    try {
      json = JSON.parse(String(raw));
    } catch {
      unreadable.push(scope);
      continue;
    }
    if (!json || typeof json !== 'object' || Array.isArray(json)) {
      unreadable.push(scope);
      continue;
    }
    if (scope === 'managed' && json.allowManagedPermissionRulesOnly === true) managedOnly = true;
    const p = json.permissions && typeof json.permissions === 'object' ? json.permissions : {};
    byScope.push({
      scope,
      allow: stringList(p.allow),
      ask: stringList(p.ask),
      deny: stringList(p.deny),
      additionalDirectories: stringList(p.additionalDirectories),
    });
  }
  const out = { allow: [], ask: [], deny: [], additionalDirectories: [], unreadable };
  for (const s of byScope) {
    if (managedOnly && s.scope !== 'managed') continue;
    out.allow.push(...s.allow);
    out.ask.push(...s.ask);
    out.deny.push(...s.deny);
    out.additionalDirectories.push(...s.additionalDirectories);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Rules (permissions, "Permission rule syntax")

/** `Tool` or `Tool(specifier)`; parentheses inside the specifier are literal. */
export function parseRule(text) {
  const s = String(text ?? '').trim();
  const open = s.indexOf('(');
  if (open < 0) return s ? { tool: s, spec: null } : null;
  if (!s.endsWith(')')) return null;
  const tool = s.slice(0, open).trim();
  return tool ? { tool, spec: s.slice(open + 1, -1) } : null;
}

function escapeRegex(s) {
  return s.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
}

function globRegex(glob) {
  return new RegExp(`^${glob.split('*').map(escapeRegex).join('.*')}$`, 's');
}

function splitMcp(name) {
  const m = /^mcp__(.+?)__(.+)$/.exec(name);
  return m ? { server: m[1], tool: m[2] } : null;
}

/** Whether a rule's tool name covers the call's tool. Allow rules take globs only after `mcp__<server>__`. */
function toolMatches(ruleTool, toolName, kind) {
  if (ruleTool === toolName) return true;
  if (ruleTool === 'Edit' && FILE_EDIT_TOOLS.has(toolName)) return true;
  // `mcp__server` covers every tool of that server.
  if (ruleTool.startsWith('mcp__') && !ruleTool.includes('*') && !ruleTool.slice(5).includes('__') && toolName.startsWith(`${ruleTool}__`)) {
    return true;
  }
  if (!ruleTool.includes('*')) return false;
  if (kind === 'allow' && !/^mcp__[^*]+__/.test(ruleTool)) return false;
  return globRegex(ruleTool).test(toolName);
}

/** A Bash rule's pattern against one simple command's text (permissions, "Wildcard patterns"). */
export function commandMatches(spec, text) {
  let p = String(spec ?? '').trim();
  if (p === '' || p === '*') return true;
  if (p.endsWith(':*')) p = `${p.slice(0, -2)} *`;
  const stars = (p.match(/\*/g) || []).length;
  if (stars === 0) return text === p;
  if (stars === 1 && p.endsWith(' *')) {
    const prefix = p.slice(0, -2);
    return text === prefix || text.startsWith(`${prefix} `);
  }
  return globRegex(p).test(text);
}

/** A gitignore-style pattern body as a regular expression: `**` crosses folders (none too), `*` and `?` stay in one. */
function gitignoreBody(p) {
  let out = '';
  for (let i = 0; i < p.length; ) {
    if (p.startsWith('**/', i)) {
      out += '(?:.*/)?';
      i += 3;
    } else if (p.startsWith('**', i)) {
      out += '.*';
      i += 2;
    } else if (p[i] === '*') {
      out += '[^/]*';
      i += 1;
    } else if (p[i] === '?') {
      out += '[^/]';
      i += 1;
    } else {
      out += escapeRegex(p[i]);
      i += 1;
    }
  }
  return out;
}

/**
 * A path rule (`//abs`, `~/home`, `/project`, `./cwd` or `cwd`) against an absolute path
 * (permissions, "Read and Edit"): a pattern without a slash matches at any depth, and for deny and
 * ask rules so does a relative single-folder pattern such as `secrets/**`.
 */
export function pathMatches(spec, absPath, { projectDir, cwd, home }, kind = 'allow') {
  let p = String(spec ?? '').trim();
  if (p === '' || p === '*' || p === '**') return true;
  let base;
  let relative = false;
  if (p.startsWith('//')) {
    base = '/';
    p = p.slice(2);
  } else if (p.startsWith('~/')) {
    base = home;
    p = p.slice(2);
  } else if (p.startsWith('/')) {
    base = projectDir || cwd;
    p = p.slice(1);
  } else {
    base = cwd || projectDir;
    relative = true;
    if (p.startsWith('./')) p = p.slice(2);
  }
  const rel = path.relative(path.resolve(base || '/'), absPath).split(path.sep).join('/');
  if (rel.startsWith('..')) return false;
  const anyDepth = !p.includes('/') || (relative && kind !== 'allow' && /^[^/*]+\/\*\*$/.test(p));
  const re = new RegExp(`^${anyDepth ? '(?:.*/)?' : ''}${gitignoreBody(p)}(?:/.*)?$`, 's');
  return re.test(rel);
}

function hostOfUrl(url) {
  try {
    return new URL(String(url)).hostname.toLowerCase();
  } catch {
    return null;
  }
}

/**
 * Whether one rule covers the call. A specifier this file cannot read counts as a match: for an
 * allow or a deny that means "Claude Code would not have asked", for an ask it means "Claude Code
 * still asks by itself"; either way the call is not counted, so the count stays a lower bound.
 */
function ruleMatches(rule, call, kind, segmentText = null) {
  if (!toolMatches(rule.tool, call.toolName, kind)) return false;
  if (rule.spec === null) return true;
  // Claude Code skips tool server rules with parentheses in settings files.
  if (rule.tool.startsWith('mcp__')) return false;
  if (SHELL_TOOLS.has(call.toolName) && (rule.tool === 'Bash' || rule.tool === 'PowerShell' || rule.tool === 'Monitor')) {
    return segmentText === null ? false : commandMatches(rule.spec, segmentText);
  }
  if (FILE_EDIT_TOOLS.has(call.toolName)) {
    return call.filePath ? pathMatches(rule.spec, call.filePath, call.paths, kind) : true;
  }
  if (call.toolName === 'WebFetch') {
    const m = /^domain:(.*)$/.exec(rule.spec.trim());
    if (!m) return true;
    return call.host ? globRegex(m[1].trim().toLowerCase()).test(call.host) : false;
  }
  // Tool(param:value) for deny and ask; allow rules keep each tool's own syntax.
  const param = /^([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(.*)$/s.exec(rule.spec);
  if (param && kind !== 'allow') {
    const value = call.input?.[param[1]];
    if (value === undefined || value === null || typeof value === 'object') return false;
    return globRegex(param[2]).test(String(value));
  }
  return true;
}

/** Whether any rule in the list (rule text as written in settings) covers the call. */
function firstMatch(rules, call, kind, segmentText = null) {
  return rules.some((text) => {
    const rule = typeof text === 'string' ? parseRule(text) : text;
    return rule !== null && ruleMatches(rule, call, kind, segmentText);
  });
}

// ---------------------------------------------------------------------------
// Shell commands

/**
 * One simple command, with wrappers and leading assignments stripped, as rules see it. `dynamic`
 * and `expand` stay aligned with `words`: a word with a variable or a substitution in it, and a
 * word with a glob.
 */
function simpleCommand(seg) {
  const items = seg.words.map((w, i) => ({ w, dyn: Boolean(seg.dynamic?.[i]), glob: Boolean(seg.expand?.[i]) }));
  const assignments = [];
  for (let guard = 0; guard < 16 && items.length > 0; guard += 1) {
    if (ASSIGNMENT.test(items[0].w)) {
      assignments.push(items.shift().w);
      continue;
    }
    const w = items[0].w;
    if (WRAPPERS.has(w) && !(w === 'command' && (items[1]?.w === '-v' || items[1]?.w === '-V'))) {
      items.shift();
      // the wrapper's own options (some take a value), then timeout's duration
      while (items.length > 1 && items[0].w.startsWith('-')) {
        const opt = items.shift().w;
        if (/^-[nskioe]$/.test(opt) && items.length > 1) items.shift();
      }
      if (w === 'timeout' && items.length > 1 && /^\d/.test(items[0].w)) items.shift();
      continue;
    }
    if (w === 'xargs' && items.length > 1 && !items[1].w.startsWith('-')) {
      items.shift();
      continue;
    }
    break;
  }
  const words = items.map((x) => x.w);
  return {
    words,
    assignments,
    text: words.join(' '),
    redirects: seg.redirects || [],
    expand: items.map((x) => x.glob),
    dynamic: items.map((x) => x.dyn),
  };
}

function isReadOnly(cmd, paths) {
  const [prog, ...args] = cmd.words;
  if (!prog) return true;
  if (cmd.assignments.some((a) => SPECIAL_VARS.test(a))) return false;
  // A redirect is checked like a file Claude writes or reads (permissions, "Redirections").
  for (const r of cmd.redirects) {
    if (r.op.startsWith('<<')) continue; // here-documents and here-strings
    if (r.target === '/dev/null') continue;
    if (r.op.includes('>')) return false;
    if (!paths || r.dynamic || /[*?[~]/.test(r.target)) return false;
    if (!insideWorkArea(path.resolve(paths.cwd || paths.projectDir || '/', r.target), paths)) return false;
  }
  const globbed = cmd.expand.some(Boolean);
  if (prog === 'git') {
    const sub = args.find((a) => !a.startsWith('-'));
    if (globbed) return false;
    if (args.some((a) => a === '-c' || a.startsWith('--exec-path') || a === '-C')) return false;
    if (GIT_READ_ONLY.has(sub)) return true;
    if (sub === 'branch' || sub === 'tag' || sub === 'remote' || sub === 'stash' || sub === 'config') {
      const rest = args.slice(args.indexOf(sub) + 1);
      if (sub === 'stash') return rest[0] === 'list' || rest[0] === 'show';
      if (sub === 'config') return rest.some((a) => a === '--get' || a === '--list' || a === '-l' || a === '--get-all');
      return rest.every((a) => a.startsWith('-') && !/^-(d|D|m|M|c|C|f|u)$|^--(delete|move|copy|force|set-upstream)/.test(a));
    }
    return false;
  }
  if (prog === 'docker') {
    if (args.some((a) => /^(-H|--host|--context|--url|--connection)/.test(a))) return false;
    return ['ps', 'images', 'inspect', 'logs', 'version', 'info'].includes(args[0]);
  }
  if (!READ_ONLY.has(prog)) {
    // `<program> --version` and friends only print.
    return args.length === 1 && /^(--version|-v|-V|--help|-h)$/.test(args[0]);
  }
  if (prog === 'find') return !globbed && !args.some((a) => FIND_ACTIONS.test(a));
  if (prog === 'sed') return !globbed && !args.some((a) => /^(-i|--in-place)/.test(a) || /^-[a-zA-Z]*i/.test(a));
  if (prog === 'sort') return !globbed && !args.some((a) => a === '-o' || a.startsWith('--output'));
  if (prog === 'file') return !args.some((a) => /^(-m|--magic-file|-f|--files-from)/.test(a));
  if (prog === 'ps') return !args.some((a) => /^[a-zA-Z]*e[a-zA-Z]*$/.test(a.replace(/^-/, '')) && a !== '-ef' && a !== 'ef');
  return true;
}

function insideWorkArea(p, paths) {
  const dirs = [paths.projectDir, paths.cwd, ...(paths.additionalDirectories || [])].filter(Boolean).map((d) => path.resolve(d));
  return dirs.some((d) => p === d || p.startsWith(`${d}${path.sep}`));
}

/**
 * Protected paths (permission modes, "Protected paths", read 21 Oct 2026): writes to them are never
 * auto-approved except in bypassPermissions, so acceptEdits still asks about them by itself. The
 * documented exceptions inside `.claude` are kept narrow on purpose (only Claude's own worktrees):
 * reading a path as protected only takes a call out of the count.
 */
const PROTECTED_DIRS = new Set(['.git', '.vscode', '.idea', '.husky', '.cargo', '.devcontainer', '.yarn', '.mvn', '.claude']);
const PROTECTED_FILES = new Set([
  '.gitconfig', '.gitmodules',
  '.bashrc', '.bash_profile', '.bash_login', '.bash_aliases', '.bash_logout', '.zshrc', '.zprofile', '.zshenv', '.zlogin',
  '.zlogout', '.profile', '.envrc',
  '.npmrc', '.yarnrc', '.yarnrc.yml', '.pnp.cjs', '.pnp.loader.mjs', '.pnpmfile.cjs', 'bunfig.toml', '.bunfig.toml',
  '.bazelrc', '.bazelversion', '.bazeliskrc',
  '.pre-commit-config.yaml', 'lefthook.yml', 'lefthook.yaml', '.lefthook.yml', '.lefthook.yaml',
  'gradle-wrapper.properties', 'maven-wrapper.properties',
  '.devcontainer.json', '.ripgreprc', 'pyrightconfig.json', '.mcp.json', '.claude.json',
]);

/** Whether a write to this absolute path is one Claude Code protects. */
export function isProtectedPath(absPath) {
  const segs = String(absPath ?? '').split(/[\\/]+/).filter(Boolean);
  if (segs.length > 0 && PROTECTED_FILES.has(segs[segs.length - 1])) return true;
  for (let i = 0; i < segs.length; i += 1) {
    // Claude's own git worktrees under .claude/worktrees/<name>/ are not protected as a whole.
    if (segs[i] === '.claude' && segs[i + 1] === 'worktrees') {
      i += 2;
      continue;
    }
    if (PROTECTED_DIRS.has(segs[i])) return true;
    if (segs[i] === '.config' && segs[i + 1] === 'git') return true;
  }
  return false;
}

/**
 * acceptEdits runs mkdir, touch, rm, rmdir, mv, cp and sed on paths inside the working directories,
 * except protected paths. A target with a variable, a substitution or a glob in it cannot be checked
 * before it runs, so it is not counted as covered (the call then stays out of the count).
 */
function acceptEditsRuns(cmd, paths) {
  const [prog, ...args] = cmd.words;
  if (!ACCEPT_EDITS_COMMANDS.has(prog)) return false;
  const targets = args.map((a, i) => ({ a, i: i + 1 })).filter(({ a }) => !a.startsWith('-'));
  if (prog === 'sed' && targets.length > 0 && !args.includes('-i') && !args.some((a) => a.startsWith('-i'))) return true;
  return targets.every(({ a, i }) => {
    if (cmd.dynamic?.[i] || cmd.expand?.[i]) return false;
    const p = path.resolve(paths.cwd || paths.projectDir || '/', a.replace(/^~(?=$|\/)/, paths.home));
    return insideWorkArea(p, paths) && !isProtectedPath(p);
  });
}

/** Shells whose `-c` script Claude Code reads for critical-path removals. */
const POSIX_SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'ash', 'mksh']);

/**
 * `rm` or `rmdir` of a critical path: Claude Code asks about it in every mode, whatever the rules
 * or a hook say (permission modes, "Critical paths"), so it asked by itself. Critical: `/` and
 * what is directly under it, the home folder, the working directory and its parents, a target
 * with a variable or a substitution in it, a glob ending in `/*`, and any removal inside a shell's
 * `-c` script. Reading more as critical only takes calls out of the count.
 */
function criticalRemoval(cmd, paths) {
  const [prog, ...args] = cmd.words;
  if (POSIX_SHELLS.has(prog)) {
    const c = args.findIndex((a) => /^-[A-Za-z]*c[A-Za-z]*$/.test(a));
    return c >= 0 && /(^|[\s;&|({`$])(rm|rmdir)(\s|$)/.test(args[c + 1] ?? '');
  }
  if (prog !== 'rm' && prog !== 'rmdir') return false;
  const home = path.resolve(paths?.home || os.homedir());
  const work = [paths?.cwd, paths?.projectDir].filter(Boolean).map((d) => path.resolve(d));
  return args.some((a, k) => {
    if (a.startsWith('-')) return false;
    if (cmd.dynamic?.[k + 1]) return true;
    if (/^(\$HOME|\$\{HOME\}|~)(\/\*?)?$/.test(a) || a === '/*') return true;
    if (/\*\/?$/.test(a) && a.includes('/')) return true;
    const p = path.resolve(paths?.cwd || '/', a.replace(/^~(?=$|\/)/, home));
    if (p === '/' || p === home || path.dirname(p) === '/') return true;
    if (path.dirname(p) === home && a.endsWith('*')) return true;
    return work.some((d) => d === p || d.startsWith(`${p}${path.sep}`));
  });
}

/** The key under which Claude Code would save "Yes, and don't ask again" for one command. */
function commandKey(cmd) {
  const [prog = '', second] = cmd.words;
  const sub = second && /^[A-Za-z][A-Za-z0-9:_-]*$/.test(second) ? ` ${second}` : '';
  return `bash:${prog}${sub}`;
}

/**
 * Manual mode's answer for a shell command: prompts (with the keys that would be saved), never
 * prompts, or cannot say. Every simple command, nested ones included, must be read-only or
 * allowed for the whole call to go ahead; one that matches deny refuses it without a prompt.
 */
function shellVerdict(command, call, lists) {
  const text = String(command ?? '');
  if (text.length > MAX_COMMAND) return { asks: true, keys: [`bash:long:${hash(text).slice(0, 16)}`] };
  let lexed;
  try {
    lexed = lexShell(text, { powershell: call.toolName === 'PowerShell' });
  } catch {
    return { asks: null };
  }
  const queue = [lexed];
  const cmds = [];
  for (let guard = 0; queue.length > 0 && guard < 32; guard += 1) {
    const l = queue.shift();
    for (const seg of l.segments) cmds.push(simpleCommand(seg));
    for (const inner of l.nested || []) {
      try {
        queue.push(lexShell(inner, { powershell: call.toolName === 'PowerShell' }));
      } catch {
        return { asks: null };
      }
    }
  }
  if (cmds.length === 0) return { asks: false };
  if (lists) {
    if (cmds.some((c) => firstMatch(lists.deny, call, 'deny', c.text))) return { asks: false, denied: true };
    if (cmds.some((c) => firstMatch(lists.ask, call, 'ask', c.text))) return { asks: true, askRule: true, keys: [] };
  }
  // Asked in every mode: counted like an ask rule (Claude Code asked by itself).
  if (cmds.some((c) => criticalRemoval(c, call.paths))) return { asks: true, askRule: true, keys: [] };
  const changesDir = cmds.some((c) => c.words[0] === 'cd' && c.words[1] && c.words[1] !== '.');
  const needing = cmds.filter((c) => {
    if (changesDir && c.words[0] === 'git') return true;
    if (isReadOnly(c, call.paths)) return false;
    return !(lists && firstMatch(lists.allow, call, 'allow', c.text));
  });
  if (needing.length === 0) return { asks: false };
  return {
    asks: true,
    keys: [...new Set(needing.map(commandKey))],
    acceptEditsCovers: needing.every((c) => acceptEditsRuns(c, call.paths)),
  };
}

// ---------------------------------------------------------------------------
// Manual mode's verdict for one call

function hash(s) {
  return crypto.createHash('sha256').update(String(s)).digest('hex');
}

/**
 * What Claude Code in Manual mode, with these lists, would do about the call before Aimiru is
 * counted: {asks: true|false|null, keys, askRule, acceptEditsCovers}. `lists` null means the
 * settings could not be read: the answer then comes from the kind of tool alone.
 */
export function manualVerdict(call, lists) {
  const { toolName } = call;
  if (!toolName) return { asks: null };
  if (SHELL_TOOLS.has(toolName)) {
    const command = call.input?.command;
    if (typeof command !== 'string') return toolName === 'Monitor' ? simpleToolVerdict(call, lists, `tool:${toolName}`) : { asks: null };
    return shellVerdict(command, call, lists);
  }
  if (FILE_EDIT_TOOLS.has(toolName)) {
    const v = simpleToolVerdict(call, lists, `edit:session:${call.sessionId ?? ''}`);
    // acceptEdits takes edits inside the working directories, but still asks about protected paths.
    if (v.asks === true && !v.askRule) {
      v.acceptEditsCovers = Boolean(call.filePath && insideWorkArea(call.filePath, call.paths) && !isProtectedPath(call.filePath));
    }
    // A session's edits are approved together, so the key belongs to the session.
    if (v.asks === true && !call.sessionId) return { asks: null };
    return v;
  }
  if (toolName === 'WebFetch') return simpleToolVerdict(call, lists, call.host ? `fetch:${call.host}` : null);
  if (toolName === 'WebSearch') return simpleToolVerdict(call, lists, 'search');
  if (toolName.startsWith('mcp__')) return simpleToolVerdict(call, lists, `mcp:${toolName}`);
  if (NEEDS_PERMISSION.has(toolName)) return simpleToolVerdict(call, lists, `tool:${toolName}`);
  if (NO_PERMISSION.has(toolName)) {
    if (lists && firstMatch(lists.deny, call, 'deny')) return { asks: false, denied: true };
    if (lists && firstMatch(lists.ask, call, 'ask')) return { asks: true, askRule: true, keys: [] };
    return { asks: false };
  }
  return { asks: null };
}

function simpleToolVerdict(call, lists, key) {
  if (lists) {
    if (firstMatch(lists.deny, call, 'deny')) return { asks: false, denied: true };
    if (firstMatch(lists.ask, call, 'ask')) return { asks: true, askRule: true, keys: [] };
    if (firstMatch(lists.allow, call, 'allow')) return { asks: false };
  }
  if (!key) return { asks: null };
  return { asks: true, keys: [key] };
}

// ---------------------------------------------------------------------------
// "Yes, and don't ask again": the keys Claude Code would already have saved

const SEEN_FILE = 'native-prompts.json';
const MAX_KEYS_PER_REPO = 5_000;
const MAX_REPOS = 200;

function readSeen(dataDir) {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(dataDir, SEEN_FILE), 'utf8'));
    if (j && typeof j === 'object' && j.repos && typeof j.repos === 'object') return j;
  } catch {
    // first use, or a file that cannot be read: start again
  }
  return { v: 1, repos: {} };
}

const LOCK_TRIES = 25;
const LOCK_WAIT_MS = 8;
const LOCK_STALE_MS = 5_000;

function pause(ms) {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch {
    // no blocking wait here: try again at once
  }
}

/**
 * Runs fn holding the remembered keys' lock, so two hooks running at once (parallel tool calls)
 * cannot both read a key as new, or lose each other's writes. Returns undefined when the lock
 * cannot be taken in about 200 ms.
 */
function withSeenLock(dataDir, fn) {
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const lock = path.join(dataDir, `${SEEN_FILE}.lock`);
  for (let i = 0; i < LOCK_TRIES; i += 1) {
    let fd = null;
    try {
      fd = fs.openSync(lock, 'wx', 0o600);
    } catch (err) {
      if (!err || err.code !== 'EEXIST') throw err;
      try {
        // A hook that died holding the lock leaves it behind; it is old after a few seconds.
        if (Date.now() - fs.statSync(lock).mtimeMs > LOCK_STALE_MS) fs.rmSync(lock, { force: true });
      } catch {
        // gone already
      }
      pause(LOCK_WAIT_MS);
      continue;
    }
    try {
      fs.closeSync(fd);
      return fn();
    } finally {
      fs.rmSync(lock, { force: true });
    }
  }
  return undefined;
}

function writeSeen(dataDir, seen) {
  const repos = Object.entries(seen.repos)
    .sort((a, b) => (b[1].at ?? 0) - (a[1].at ?? 0))
    .slice(0, MAX_REPOS);
  for (const [, r] of repos) {
    const keys = Object.entries(r.keys ?? {});
    if (keys.length > MAX_KEYS_PER_REPO) {
      r.keys = Object.fromEntries(keys.sort((a, b) => b[1] - a[1]).slice(0, MAX_KEYS_PER_REPO));
    }
  }
  const out = { v: 1, repos: Object.fromEntries(repos) };
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const file = path.join(dataDir, SEEN_FILE);
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(out), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

/**
 * Marks the keys as asked about. Returns true when at least one was new: with "Yes, and don't
 * ask again" taken every time, Claude Code would have asked this once and never again; false
 * when all were known. Null when the keys cannot be remembered (no data folder, a full or
 * read-only disk, the lock held too long): counting such a call would count the same prompt again
 * on every call, so it is left out of the count.
 */
export function firstTimeAsked(dataDir, repo, keys, now = Date.now()) {
  if (!dataDir || keys.length === 0) return null;
  try {
    const fresh = withSeenLock(dataDir, () => {
      const seen = readSeen(dataDir);
      const id = hash(repo || '').slice(0, 32);
      const r = seen.repos[id] ?? { at: now, keys: {} };
      if (!r.keys || typeof r.keys !== 'object') r.keys = {};
      const isNew = keys.some((k) => !Object.prototype.hasOwnProperty.call(r.keys, hash(k).slice(0, 32)));
      for (const k of keys) r.keys[hash(k).slice(0, 32)] = now;
      r.at = now;
      seen.repos[id] = r;
      writeSeen(dataDir, seen);
      return isNew;
    });
    return typeof fresh === 'boolean' ? fresh : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// The flag

/** The call as the rules see it, with its paths resolved. */
export function callOf(input, { projectDir = null, home = os.homedir(), additionalDirectories = [] } = {}) {
  const toolName = String(input?.tool_name ?? '');
  const ti = input?.tool_input && typeof input.tool_input === 'object' ? input.tool_input : {};
  const cwd = input?.cwd || projectDir || null;
  const project = projectDir || cwd;
  const paths = {
    projectDir: project,
    cwd,
    home,
    additionalDirectories: additionalDirectories.map((d) => path.resolve(project || '/', d.replace(/^~(?=$|\/)/, home))),
  };
  let filePath = null;
  if (FILE_EDIT_TOOLS.has(toolName)) {
    const raw = ti.file_path ?? ti.notebook_path ?? ti.path ?? null;
    if (typeof raw === 'string' && raw) filePath = path.resolve(cwd || '/', raw.replace(/^~(?=$|\/)/, home));
  }
  const host = toolName === 'WebFetch' ? hostOfUrl(ti.url) : null;
  return { toolName, input: ti, sessionId: input?.session_id ? String(input.session_id) : null, filePath, host, paths };
}

/**
 * The flag sent with check: {native_prompt: true|false|null, estimated}. True: Claude Code's own
 * default would have stopped to ask the person, and in this session it did not ask itself, so
 * Aimiru stood in. False: it would not have asked. Null: Aimiru cannot say, or Claude Code asked
 * by itself anyway. Never throws.
 */
export function nativePrompt(input, { lists = null, dataDir = null, projectDir = null, home = os.homedir() } = {}) {
  try {
    const mode = typeof input?.permission_mode === 'string' ? input.permission_mode : null;
    const readable = lists && lists.unreadable.length === 0;
    const call = callOf(input, { projectDir, home, additionalDirectories: readable ? lists.additionalDirectories : [] });
    const verdict = manualVerdict(call, readable ? lists : null);
    const estimated = !readable;
    if (verdict.asks === null) return { native_prompt: null, estimated: false };
    if (verdict.asks === false) return { native_prompt: false, estimated };
    // An explicit ask rule prompts in every mode, every time: Claude Code asked by itself.
    if (verdict.askRule) return { native_prompt: null, estimated: false };
    const repo = gitRootOf(call.paths.projectDir || call.paths.cwd) ?? call.paths.projectDir ?? call.paths.cwd ?? '';
    const first = firstTimeAsked(dataDir, repo, verdict.keys ?? []);
    if (first === null) return { native_prompt: null, estimated: false };
    if (!first) return { native_prompt: false, estimated };
    // Asked now in Manual mode. Did Claude Code ask by itself in this session's mode?
    const asksItself =
      mode === 'auto' || mode === 'bypassPermissions'
        ? false
        : mode === 'acceptEdits'
          ? !verdict.acceptEditsCovers
          : mode === 'default'
            ? true
            : null;
    if (asksItself !== false) return { native_prompt: null, estimated: false };
    return { native_prompt: true, estimated };
  } catch {
    return { native_prompt: null, estimated: false };
  }
}

/** Reads the person's settings and returns the flag for this call (pre-tool-use.mjs). */
export function nativePromptFor(input, { env = process.env, dataDir = null, projectDir = null, home = os.homedir(), managed = null } = {}) {
  try {
    const project = projectDir || input?.cwd || null;
    const lists = readPermissionSettings(settingsFiles({ env, projectDir: project, home, managed }));
    return nativePrompt(input, { lists, dataDir, projectDir: project, home });
  } catch {
    return { native_prompt: null, estimated: false };
  }
}
