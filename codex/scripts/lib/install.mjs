// Putting Aimiru's check into Codex, and reading what Codex's own settings say about it (ADR-0091).
//
// Codex reads checks from hooks.json next to its user settings (~/.codex/hooks.json, or CODEX_HOME),
// alongside any inline [hooks] in config.toml; every matching check from every file runs (OpenAI,
// Codex hooks, "Where Codex looks for hooks"). This file adds one entry there, with no matcher so it
// sees every tool call Codex's checks can see, and leaves every other entry as it was.
//
// The check runs from a copy in ~/.sayso/codex/app, not from where npx unpacked this package (npx
// clears its cache), with the Node.js that ran the install, named by the steadiest path PATH has for
// it (stableNodePath). The command line stays the same across updates of the copy, so Codex keeps the
// person's trust in it; a new Node.js path, or a first install, is a new command, which Codex skips
// until the person trusts it again. If that Node.js later moves or is removed, the entry refuses
// every call until the install line runs again (guardCommand), never lets them through.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CODEX_TIMEOUT_S } from './runtime.mjs';
import { NO_ANSWER_REASON, STATUS_MESSAGE } from './words.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
/** This package's scripts folder (scripts/lib/..). */
export const SCRIPTS_DIR = path.resolve(here, '..');

export function hooksFileOf(codexHome) {
  return path.join(codexHome, 'hooks.json');
}

export function appDirOf(dataDir) {
  return path.join(dataDir, 'app');
}

/**
 * Double quotes inside the single-quoted /bin/sh script (guardCommand) for a plain path: no $, `, ",
 * \, ' or line break, so sh reads it as written and the person's own shell (sh, bash, zsh, fish)
 * passes the script through untouched.
 */
function quote(p) {
  const s = String(p);
  if (/["'`$\\\n!]/.test(s)) throw new Error(`a path Codex's shell would read differently: ${s}`);
  return `"${s}"`;
}

/**
 * The command Codex runs. Inside: this computer's Node.js and the guard, both by full path, with
 * Node's own NODE_OPTIONS and NODE_PATH cleared, so nothing in Codex's environment can load code into
 * the check or stop the guard from starting. Around it: /bin/sh, which passes the guard's answer on
 * (exit 0 goes ahead, exit 2 refuses with the guard's reason) and turns any other end into a refusal,
 * because Codex runs a call whose check ends any other way: a Node.js that moved or was removed (env
 * exits 127), or the guard killed with SIGKILL. The guard's own stderr (its refusal) goes through
 * fd 3; sh's own notices while it runs ("Killed: 9") go nowhere, so they never join a reason. The
 * script is in single quotes, which sh, bash, zsh and fish all pass through as written, and holds no
 * quote or backslash of its own.
 */
export function guardCommand({ nodePath, appDir }) {
  const run = `/usr/bin/env -u NODE_OPTIONS -u NODE_PATH ${quote(nodePath)} ${quote(path.join(appDir, 'guard.mjs'))}`;
  return `/bin/sh -c '{ ${run} 2>&3 3>&-; } 3>&2 2>/dev/null; s=$?; if [ $s -eq 0 ] || [ $s -eq 2 ]; then exit $s; fi; echo "${NO_ANSWER_REASON}" >&2; exit 2'`;
}

/** The Node.js and guard paths an entry's command names (for doctor), or null. */
export function commandPaths(command) {
  const m = /NODE_PATH "([^"]+)" "([^"]+)"/.exec(String(command ?? ''));
  return m ? { nodePath: m[1], guardPath: m[2] } : null;
}

/**
 * The steadiest path for the Node.js running now: the first `node` on PATH that is a link to this
 * same program (Homebrew's /opt/homebrew/bin/node, for one), else this program's own path.
 * process.execPath is the versioned folder an upgrade deletes (/opt/homebrew/Cellar/node/<version>).
 */
export function stableNodePath(execPath = process.execPath, envPath = process.env.PATH) {
  let real;
  try {
    real = fs.realpathSync(execPath);
  } catch {
    return execPath;
  }
  for (const dir of String(envPath ?? '').split(path.delimiter)) {
    if (!dir || !path.isAbsolute(dir)) continue;
    const candidate = path.join(dir, 'node');
    if (/["'`$\\\n!]/.test(candidate)) continue;
    try {
      if (fs.lstatSync(candidate).isSymbolicLink() && fs.realpathSync(candidate) === real) return candidate;
    } catch {
      // not there
    }
  }
  return execPath;
}

/** The hooks.json handler this connector owns. */
export function ourHandler({ nodePath, appDir }) {
  return { type: 'command', command: guardCommand({ nodePath, appDir }), timeout: CODEX_TIMEOUT_S, statusMessage: STATUS_MESSAGE };
}

/** True for a handler that runs a guard from an Aimiru check copy (this one, or an older install's). */
export function isOurs(handler, appDir) {
  const command = typeof handler?.command === 'string' ? handler.command : '';
  return command.includes(path.join(appDir, 'guard.mjs')) || /[\\/]\.sayso[\\/]codex[\\/]app[\\/]guard\.mjs/.test(command);
}

/** Copies the check (guard, check, its background sender, its library and the shared code) into appDir, replacing an older copy. */
export function copyApp(appDir, { from = SCRIPTS_DIR } = {}) {
  const parent = path.dirname(appDir);
  fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
  const next = `${appDir}.next-${process.pid}`;
  fs.rmSync(next, { recursive: true, force: true });
  fs.mkdirSync(next, { recursive: true, mode: 0o700 });
  for (const name of ['guard.mjs', 'pre-tool-use.mjs', 'background.mjs']) fs.copyFileSync(path.join(from, name), path.join(next, name));
  for (const dir of ['lib', 'vendor']) {
    fs.mkdirSync(path.join(next, dir), { recursive: true, mode: 0o700 });
    for (const f of fs.readdirSync(path.join(from, dir))) {
      if (f.endsWith('.mjs')) fs.copyFileSync(path.join(from, dir, f), path.join(next, dir, f));
    }
  }
  // The copy is an ES module folder like the package (package.json "type": "module").
  fs.writeFileSync(path.join(next, 'package.json'), `${JSON.stringify({ type: 'module', private: true }, null, 2)}\n`, { mode: 0o600 });
  const old = `${appDir}.old-${process.pid}`;
  if (fs.existsSync(appDir)) fs.renameSync(appDir, old);
  fs.renameSync(next, appDir);
  fs.rmSync(old, { recursive: true, force: true });
  return appDir;
}

function readHooksFile(file) {
  if (!fs.existsSync(file)) return { exists: false, data: { hooks: {} } };
  const text = fs.readFileSync(file, 'utf8');
  if (!text.trim()) return { exists: true, data: { hooks: {} } };
  const data = JSON.parse(text);
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('not an object');
  if (data.hooks !== undefined && (typeof data.hooks !== 'object' || Array.isArray(data.hooks) || data.hooks === null)) throw new Error('hooks is not an object');
  return { exists: true, data: { ...data, hooks: { ...(data.hooks || {}) } } };
}

function writeAtomic(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
}

/** PreToolUse groups with every handler of ours taken out (a group left empty is dropped). */
function withoutOurs(groups, appDir) {
  const out = [];
  let removed = 0;
  for (const g of Array.isArray(groups) ? groups : []) {
    if (!g || typeof g !== 'object' || !Array.isArray(g.hooks)) {
      out.push(g);
      continue;
    }
    const kept = g.hooks.filter((h) => !isOurs(h, appDir));
    removed += g.hooks.length - kept.length;
    if (kept.length) out.push({ ...g, hooks: kept });
  }
  return { groups: out, removed };
}

/**
 * Adds (or replaces) Aimiru's PreToolUse entry in Codex's hooks.json. Keeps every other entry and a
 * dated copy of the file before changing it.
 * @returns {{file, changed: boolean, replaced: boolean, backup: string|null, groupIndex: number, command: string}}
 */
export function installHook({ codexHome, appDir, nodePath, now = new Date() }) {
  const file = hooksFileOf(codexHome);
  const { exists, data } = readHooksFile(file);
  const { groups, removed } = withoutOurs(data.hooks.PreToolUse, appDir);
  const handler = ourHandler({ nodePath, appDir });
  const before = JSON.stringify(data.hooks.PreToolUse ?? null);
  data.hooks.PreToolUse = [...groups, { hooks: [handler] }];
  const changed = JSON.stringify(data.hooks.PreToolUse) !== before;
  let backup = null;
  if (changed) {
    if (exists) {
      backup = `${file}.sayso-backup-${now.toISOString().replace(/[:.]/g, '-')}`;
      fs.copyFileSync(file, backup);
    }
    writeAtomic(file, `${JSON.stringify(data, null, 2)}\n`);
  }
  return { file, changed, replaced: removed > 0, backup, groupIndex: groups.length, command: handler.command };
}

/** Takes Aimiru's entry out of Codex's hooks.json. */
export function uninstallHook({ codexHome, appDir }) {
  const file = hooksFileOf(codexHome);
  const { exists, data } = readHooksFile(file);
  if (!exists) return { file, removed: 0 };
  const { groups, removed } = withoutOurs(data.hooks.PreToolUse, appDir);
  if (!removed) return { file, removed: 0 };
  if (groups.length) data.hooks.PreToolUse = groups;
  else delete data.hooks.PreToolUse;
  writeAtomic(file, `${JSON.stringify(data, null, 2)}\n`);
  return { file, removed };
}

/** Where our entry sits in hooks.json now: {present, groupIndex, handlerIndex, command, matcher, timeout}. */
export function findOurHook({ codexHome, appDir }) {
  const file = hooksFileOf(codexHome);
  let data;
  try {
    data = readHooksFile(file).data;
  } catch {
    return { file, present: false, unreadable: true };
  }
  const groups = Array.isArray(data.hooks.PreToolUse) ? data.hooks.PreToolUse : [];
  for (let g = 0; g < groups.length; g += 1) {
    const hooks = Array.isArray(groups[g]?.hooks) ? groups[g].hooks : [];
    for (let h = 0; h < hooks.length; h += 1) {
      if (isOurs(hooks[h], appDir)) return { file, present: true, groupIndex: g, handlerIndex: h, command: hooks[h].command, matcher: groups[g].matcher ?? null, timeout: hooks[h].timeout ?? null };
    }
  }
  return { file, present: false };
}

/**
 * What Codex's config.toml says, read as text (no TOML library): whether checks are turned off
 * ([features] hooks = false, or the older codex_hooks), and whether the person turned this one off
 * ([hooks.state."<hooks.json>:pre_tool_use:<group>:<handler>"] enabled = false). Codex keeps the
 * person's trust there too, as a hash of the entry this file cannot recompute, so trust itself is
 * known only once the check runs inside Codex.
 */
export function codexSettingsFacts({ codexHome, hookKey = null }) {
  const file = path.join(codexHome, 'config.toml');
  let text = '';
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return { file, read: false, checksOff: false, turnedOff: false };
  }
  let section = '';
  let checksOff = false;
  let turnedOff = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/\s+#.*$/, '').trim();
    const header = /^\[\s*([^\]]+?)\s*\]$/.exec(line);
    if (header) {
      section = header[1];
      continue;
    }
    if (section === 'features' && /^(hooks|codex_hooks)\s*=\s*false$/.test(line)) checksOff = true;
    if (/^features\.(hooks|codex_hooks)\s*=\s*false$/.test(line) && section === '') checksOff = true;
    if (hookKey && /^enabled\s*=\s*false$/.test(line)) {
      const key = /^hooks\.state\.(?:"((?:[^"\\]|\\.)*)"|'([^']*)')$/.exec(section);
      const name = key ? (key[1] !== undefined ? key[1].replace(/\\(.)/g, '$1') : key[2]) : null;
      if (name === hookKey) turnedOff = true;
    }
  }
  return { file, read: true, checksOff, turnedOff };
}

/** Codex's key for our entry's trust and on/off state (openai/codex codex-rs/hooks/src/lib.rs hook_key). */
export function hookKeyOf(hooksFile, groupIndex, handlerIndex = 0) {
  return `${hooksFile}:pre_tool_use:${groupIndex}:${handlerIndex}`;
}
