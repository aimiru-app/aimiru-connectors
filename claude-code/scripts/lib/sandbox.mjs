// Is Claude Code's sandbox holding this shell command? (ADR-0090)
//
// With the sandbox on, the commands Claude runs and the programs they start can write only inside
// the working folders and reach only the hosts the person allowed, so a program the agent just wrote
// runs as local work. With it off, Aimiru asks before such a program runs.
//
// Claude Code's hook input carries no sandbox field (hooks reference, read 22 Oct 2026, Claude Code
// 2.1.306), and no environment variable tells a hook. So the connector reads what Claude Code reads
// (sandboxing reference, "Configure the sandboxed Bash tool"):
//   - sandbox.enabled in the settings files: managed first, then local, project and user;
//   - the platform: macOS (built in) or Linux and WSL2 with bubblewrap and socat on PATH, since
//     without them Claude Code runs commands unsandboxed unless failIfUnavailable stops it;
//   - sandbox.filesystem.disabled anywhere: writes are no longer held in, so it counts as off;
//   - this command: Claude's unsandboxed retry (tool_input.dangerouslyDisableSandbox), unless
//     allowUnsandboxedCommands is false in managed or user settings; an excludedCommands entry
//     that could match it;
//   - a session started with --settings (seen in the processes above this one): those settings
//     cannot be read here, so the state is unknown.
// Anything Aimiru cannot read for certain counts as off, and the person is asked. It is never
// counted as on by guessing.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { lexShell } from '../vendor/classify.mjs';
import { settingsFiles } from './native-prompt.mjs';

/** The shell tools the sandbox wraps. */
const SHELL_TOOLS = new Set(['Bash', 'PowerShell', 'Monitor']);

/** Settings scopes, highest precedence first (settings, "Settings precedence"; --settings cannot be read here). */
const PRECEDENCE = ['managed', 'local', 'project', 'user'];

/** True when a program is on PATH. */
function onPath(name, env) {
  for (const dir of String(env.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    try {
      fs.accessSync(path.join(dir, name), fs.constants.X_OK);
      return true;
    } catch {
      // not here
    }
  }
  return false;
}

/**
 * The sandbox settings from Claude Code's settings files: {known: false} when a file exists but
 * cannot be read (the state is then unknown), else the merged values.
 */
export function readSandboxSettings(files, { readFile = (f) => fs.readFileSync(f, 'utf8') } = {}) {
  const byScope = {};
  for (const { scope, file } of files) {
    let raw;
    try {
      raw = readFile(file);
    } catch (err) {
      if (err && (err.code === 'ENOENT' || err.code === 'ENOTDIR')) continue;
      return { known: false, why: 'a settings file could not be read' };
    }
    let json;
    try {
      json = JSON.parse(String(raw));
    } catch {
      return { known: false, why: 'a settings file could not be read' };
    }
    if (!json || typeof json !== 'object' || Array.isArray(json)) return { known: false, why: 'a settings file could not be read' };
    const sb = json.sandbox && typeof json.sandbox === 'object' && !Array.isArray(json.sandbox) ? json.sandbox : null;
    if (!sb) continue;
    (byScope[scope] ||= []).push(sb);
  }
  const first = (key) => {
    for (const scope of PRECEDENCE) {
      for (const sb of byScope[scope] || []) if (typeof sb[key] === 'boolean') return sb[key];
    }
    return undefined;
  };
  const all = Object.values(byScope).flat();
  return {
    known: true,
    enabled: first('enabled') === true,
    // Any scope turning the filesystem layer off: writes are not held in (stricter reading).
    filesystemOff: all.some((sb) => sb.filesystem && typeof sb.filesystem === 'object' && sb.filesystem.disabled === true),
    // The unsandboxed retry is off only when managed or user settings say so (the only scopes
    // whose false holds whatever a project says).
    retryOff: [...(byScope.managed || []), ...(byScope.user || [])].some((sb) => sb.allowUnsandboxedCommands === false),
    excluded: all.flatMap((sb) => (Array.isArray(sb.excludedCommands) ? sb.excludedCommands.filter((x) => typeof x === 'string') : [])),
  };
}

/** The first word of each simple command in a shell command (best effort; unreadable gives null). */
function programWords(command) {
  try {
    const { segments } = lexShell(String(command ?? ''));
    return segments.map((s) => (s.words && s.words[0] ? String(s.words[0]) : '')).filter(Boolean);
  } catch {
    return null;
  }
}

/** True when an excludedCommands entry could take this command out of the sandbox (stricter reading). */
export function mayBeExcluded(command, patterns) {
  if (!patterns.length) return false;
  const words = programWords(command);
  if (words === null) return true;
  const firsts = new Set(words.map((w) => path.basename(w)));
  return patterns.some((p) => {
    const head = String(p).trim().split(/\s+/)[0] || '';
    return head === '*' || head === '' || firsts.has(head) || firsts.has(path.basename(head));
  });
}

/** The command lines of the processes above this one (up to `depth`), or null when they cannot be read. */
export function ancestorCommandLines({ pid = process.ppid, depth = 6, run = spawnSync } = {}) {
  const lines = [];
  let cur = pid;
  for (let i = 0; i < depth && cur && cur > 1; i += 1) {
    let r;
    try {
      r = run('ps', ['-o', 'ppid=', '-o', 'args=', '-p', String(cur)], { encoding: 'utf8', timeout: 1_000 });
    } catch {
      return null;
    }
    if (!r || r.status !== 0 || typeof r.stdout !== 'string' || !r.stdout.trim()) return lines.length ? lines : null;
    const m = /^\s*(\d+)\s+(.*)$/s.exec(r.stdout.trim());
    if (!m) return null;
    lines.push(m[2]);
    cur = Number(m[1]);
  }
  return lines;
}

/**
 * Whether the sandbox is on for this session at all, from the settings and the platform:
 * {on, why}. `why` is a short sentence for the ADR's states (on, off, unknown).
 */
export function sessionSandbox({ env = process.env, projectDir = null, home = os.homedir(), platform = process.platform, managed = null, readFile, parents = ancestorCommandLines } = {}) {
  if (platform !== 'darwin' && platform !== 'linux') return { on: false, state: 'off', why: 'Claude Code has no sandbox on this system' };
  if (platform === 'linux' && !(onPath('bwrap', env) && onPath('socat', env))) return { on: false, state: 'off', why: 'the sandbox needs bubblewrap and socat here' };
  const settings = readSandboxSettings(settingsFiles({ env, projectDir, home, managed }), readFile ? { readFile } : {});
  if (!settings.known) return { on: false, state: 'unknown', why: settings.why };
  if (!settings.enabled) return { on: false, state: 'off', why: 'the sandbox is off', settings };
  if (settings.filesystemOff) return { on: false, state: 'off', why: 'the sandbox does not hold files in', settings };
  // Settings given on the command line cannot be read here: they may turn the sandbox off.
  const lines = typeof parents === 'function' ? parents() : null;
  if (lines === null) return { on: false, state: 'unknown', why: 'the session could not be read', settings };
  if (lines.some((l) => /(^|\s)--settings(=|\s|$)/.test(l))) return { on: false, state: 'unknown', why: 'the session was started with settings Aimiru cannot read', settings };
  return { on: true, state: 'on', why: "Claude Code's sandbox is on", settings };
}

/**
 * Whether the sandbox holds this one tool call: a shell tool, the session's sandbox on, not Claude's
 * unsandboxed retry (unless managed or user settings turn the retry off), and no excluded command.
 */
export function sandboxFor(input, opts = {}) {
  const tool = String(input?.tool_name ?? '');
  if (!SHELL_TOOLS.has(tool)) return { on: false, state: 'off', why: 'not a shell command' };
  const session = sessionSandbox(opts);
  if (!session.on) return session;
  const ti = input?.tool_input && typeof input.tool_input === 'object' ? input.tool_input : {};
  if (ti.dangerouslyDisableSandbox === true && !session.settings.retryOff) return { on: false, state: 'off', why: 'Claude asked to run this outside the sandbox' };
  if (typeof ti.command === 'string' && mayBeExcluded(ti.command, session.settings.excluded)) return { on: false, state: 'off', why: 'this command may run outside the sandbox' };
  return session;
}
