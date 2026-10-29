// Putting Aimiru's check into Codex, and reading what Codex's own settings say about it (ADR-0091).
//
// Codex reads checks from hooks.json next to its user settings (~/.codex/hooks.json, or CODEX_HOME),
// alongside any inline [hooks] in config.toml; every matching check from every file runs (OpenAI,
// Codex hooks, "Where Codex looks for hooks"). This file adds two entries there, each with no
// matcher, and leaves every other entry as it was: the check at PreToolUse ("Checking with Aimiru"),
// which sees every tool call Codex's checks can see, and the person's brief at SessionStart
// ("Aimiru's brief", ADR-0157), which gives Codex the brief as a session starts and never takes a job.
// Codex keys the person's trust in each to its place (<hooks.json>:<event>:<group>:<handler>), so an
// install that finds an entry of its own leaves it exactly where it is: unchanged when it is the same,
// rewritten in place when it changed (Codex asks the person to trust it again), never moved.
//
// The check runs from a copy in ~/.sayso/codex/app, not from where npx unpacked this package (npx
// clears its cache), with the Node.js that ran the install, named by the steadiest path PATH has for
// it (stableNodePath). The command line stays the same across updates of the copy, so Codex keeps the
// person's trust in it; a new Node.js path, or a first install, is a new command, which Codex skips
// until the person trusts it again. If that Node.js later moves or is removed, the entry refuses
// every call until the install line runs again (guardCommand), never lets them through.

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CODEX_TIMEOUT_S } from './runtime.mjs';
import { BRIEF_STATUS_MESSAGE, NO_ANSWER_REASON, STATUS_MESSAGE } from './words.mjs';

/** How long Codex lets the brief entry run (ADR-0157): the script itself ends within about 3 s. */
export const BRIEF_TIMEOUT_S = 10;

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

/**
 * The command Codex runs as a session starts (ADR-0157): brief.mjs with this computer's Node.js, both
 * by full path and with NODE_OPTIONS and NODE_PATH cleared, inside /bin/sh, which always ends 0 and
 * keeps the script's own errors from Codex's screen. Whatever happens (no key, Aimiru away, Node.js
 * moved), the session starts as it would have, only without the brief. Single-quoted like the check.
 */
export function briefCommand({ nodePath, appDir }) {
  return `/bin/sh -c '/usr/bin/env -u NODE_OPTIONS -u NODE_PATH ${quote(nodePath)} ${quote(path.join(appDir, 'brief.mjs'))} 2>/dev/null; exit 0'`;
}

/** The hooks.json handler at SessionStart this connector owns ("Aimiru's brief"). */
export function ourBriefHandler({ nodePath, appDir }) {
  return { type: 'command', command: briefCommand({ nodePath, appDir }), timeout: BRIEF_TIMEOUT_S, statusMessage: BRIEF_STATUS_MESSAGE };
}

/** True for a handler that runs the brief from an Aimiru check copy (this one, or another install's). */
export function isOurBrief(handler, appDir) {
  const command = typeof handler?.command === 'string' ? handler.command : '';
  return command.includes(path.join(appDir, 'brief.mjs')) || /[\\/]\.sayso[\\/]codex[\\/]app[\\/]brief\.mjs/.test(command);
}

/** Copies the check (guard, check, its background sender, its library and the shared code) into appDir, replacing an older copy. */
export function copyApp(appDir, { from = SCRIPTS_DIR } = {}) {
  const parent = path.dirname(appDir);
  fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
  const next = `${appDir}.next-${process.pid}`;
  fs.rmSync(next, { recursive: true, force: true });
  fs.mkdirSync(next, { recursive: true, mode: 0o700 });
  for (const name of ['guard.mjs', 'pre-tool-use.mjs', 'background.mjs', 'brief.mjs']) fs.copyFileSync(path.join(from, name), path.join(next, name));
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

/** Groups with every handler `mine` names taken out (a group left empty by that is dropped). */
function withoutOurs(groups, mine) {
  const out = [];
  let removed = 0;
  for (const g of Array.isArray(groups) ? groups : []) {
    if (!g || typeof g !== 'object' || !Array.isArray(g.hooks)) {
      out.push(g);
      continue;
    }
    const kept = g.hooks.filter((h) => !mine(h));
    removed += g.hooks.length - kept.length;
    if (kept.length) out.push({ ...g, hooks: kept });
  }
  return { groups: out, removed };
}

/**
 * `handler` placed among `groups` (ADR-0157): where an entry of ours already is, or in a group of its
 * own at the end when there is none. The first entry of ours keeps its place, so the key Codex keeps
 * the person's trust under (<hooks.json>:<event>:<group>:<handler>) never changes: left as it is when
 * it is the same, rewritten in place when it is not (Codex then asks the person to trust it again). A
 * second copy of ours is taken out. Every other entry keeps its place.
 * @returns {{groups: object[], groupIndex: number, handlerIndex: number, found: boolean}}
 */
function placed(groups, handler, mine) {
  const list = Array.isArray(groups) ? groups : [];
  let at = null;
  for (let g = 0; g < list.length && !at; g += 1) {
    const hooks = Array.isArray(list[g]?.hooks) ? list[g].hooks : [];
    const h = hooks.findIndex((x) => mine(x));
    if (h !== -1) at = { g, h };
  }
  if (!at) return { groups: [...list, { hooks: [handler] }], groupIndex: list.length, handlerIndex: 0, found: false };
  // Kept in place only in a group of its own with no matcher (security review): a matcher, or another
  // handler beside it, would narrow or share what Codex runs it for, so ours moves to its own group.
  const home = list[at.g];
  if ((home.matcher !== undefined && home.matcher !== null) || home.hooks.length !== 1) {
    const left = withoutOurs(list, mine).groups;
    return { groups: [...left, { hooks: [handler] }], groupIndex: left.length, handlerIndex: 0, found: true };
  }
  const out = [];
  list.forEach((grp, g) => {
    if (!grp || typeof grp !== 'object' || !Array.isArray(grp.hooks)) {
      out.push(grp);
      return;
    }
    const hooks = grp.hooks.flatMap((x, h) => (g === at.g && h === at.h ? [JSON.stringify(x) === JSON.stringify(handler) ? x : handler] : mine(x) ? [] : [x]));
    // A group that held only a second copy of ours goes; one the person left empty stays.
    if (hooks.length || !grp.hooks.length) out.push({ ...grp, hooks });
  });
  return { groups: out, groupIndex: at.g, handlerIndex: at.h, found: true };
}

/**
 * Adds Aimiru's two entries to Codex's hooks.json, or brings them up to date where they are: the check
 * at PreToolUse and the brief at SessionStart (ADR-0157). Keeps every other entry where it is, and a
 * dated copy of the file before changing it. An install that changes nothing writes nothing.
 * @returns {{file, changed: boolean, replaced: boolean, backup: string|null, groupIndex: number,
 *   handlerIndex: number, command: string, brief: {groupIndex: number, handlerIndex: number, command: string, replaced: boolean}}}
 */
export function installHook({ codexHome, appDir, nodePath, now = new Date() }) {
  const file = hooksFileOf(codexHome);
  const { exists, data } = readHooksFile(file);
  const handler = ourHandler({ nodePath, appDir });
  const briefHandler = ourBriefHandler({ nodePath, appDir });
  const check = placed(data.hooks.PreToolUse, handler, (h) => isOurs(h, appDir));
  const brief = placed(data.hooks.SessionStart, briefHandler, (h) => isOurBrief(h, appDir));
  const before = JSON.stringify([data.hooks.PreToolUse ?? null, data.hooks.SessionStart ?? null]);
  data.hooks.PreToolUse = check.groups;
  data.hooks.SessionStart = brief.groups;
  const changed = JSON.stringify([data.hooks.PreToolUse, data.hooks.SessionStart]) !== before;
  let backup = null;
  if (changed) {
    if (exists) {
      backup = `${file}.sayso-backup-${now.toISOString().replace(/[:.]/g, '-')}`;
      fs.copyFileSync(file, backup);
    }
    writeAtomic(file, `${JSON.stringify(data, null, 2)}\n`);
  }
  return {
    file,
    changed,
    replaced: check.found,
    backup,
    groupIndex: check.groupIndex,
    handlerIndex: check.handlerIndex,
    command: handler.command,
    brief: { groupIndex: brief.groupIndex, handlerIndex: brief.handlerIndex, command: briefHandler.command, replaced: brief.found },
  };
}

/** Takes Aimiru's entries (the check and the brief) out of Codex's hooks.json; nothing else. */
export function uninstallHook({ codexHome, appDir }) {
  const file = hooksFileOf(codexHome);
  const { exists, data } = readHooksFile(file);
  if (!exists) return { file, removed: 0 };
  const check = withoutOurs(data.hooks.PreToolUse, (h) => isOurs(h, appDir));
  const brief = withoutOurs(data.hooks.SessionStart, (h) => isOurBrief(h, appDir));
  const removed = check.removed + brief.removed;
  if (!removed) return { file, removed: 0 };
  for (const [event, left] of [['PreToolUse', check], ['SessionStart', brief]]) {
    if (!left.removed) continue;
    if (left.groups.length) data.hooks[event] = left.groups;
    else delete data.hooks[event];
  }
  writeAtomic(file, `${JSON.stringify(data, null, 2)}\n`);
  return { file, removed };
}

/** Where the first handler `mine` names sits under `event` in hooks.json now. */
function findIn({ codexHome, event, mine }) {
  const file = hooksFileOf(codexHome);
  let data;
  try {
    data = readHooksFile(file).data;
  } catch {
    return { file, present: false, unreadable: true };
  }
  const groups = Array.isArray(data.hooks[event]) ? data.hooks[event] : [];
  for (let g = 0; g < groups.length; g += 1) {
    const hooks = Array.isArray(groups[g]?.hooks) ? groups[g].hooks : [];
    for (let h = 0; h < hooks.length; h += 1) {
      if (mine(hooks[h])) return { file, present: true, groupIndex: g, handlerIndex: h, command: hooks[h].command, matcher: groups[g].matcher ?? null, timeout: hooks[h].timeout ?? null, handler: hooks[h] };
    }
  }
  return { file, present: false };
}

/** A value with every object's keys sorted, compact, for comparing two entries. */
function canonical(v) {
  return JSON.stringify(sortedDeep(v ?? null));
}

/**
 * True only for the check exactly as install writes it (security review): no matcher, and the handler
 * equal to ourHandler for the Node.js its command names; anything else (a matcher, async, another
 * timeout or name, a command that only mentions the guard) is not ours to rely on.
 */
export function isOurExactCheck(at, appDir) {
  if (!at?.present || at.matcher !== null) return false;
  const paths = commandPaths(at.command);
  if (!paths) return false;
  return canonical(at.handler) === canonical(ourHandler({ nodePath: paths.nodePath, appDir }));
}

/** The node path the brief entry's command names, or null. */
function briefNodePath(command) {
  const m = /NODE_PATH "([^"]+)" "([^"]+)"/.exec(String(command ?? ''));
  return m ? m[1] : null;
}

/** True only for the brief entry exactly as install writes it. */
export function isOurExactBrief(at, appDir) {
  if (!at?.present || at.matcher !== null) return false;
  const nodePath = briefNodePath(at.command);
  if (!nodePath) return false;
  return canonical(at.handler) === canonical(ourBriefHandler({ nodePath, appDir }));
}

/** Where our check sits in hooks.json now: {present, groupIndex, handlerIndex, command, matcher, timeout}. */
export function findOurHook({ codexHome, appDir }) {
  return findIn({ codexHome, event: 'PreToolUse', mine: (h) => isOurs(h, appDir) });
}

/** Where our brief entry sits in hooks.json now (ADR-0157), in the same shape. */
export function findOurBrief({ codexHome, appDir }) {
  return findIn({ codexHome, event: 'SessionStart', mine: (h) => isOurBrief(h, appDir) });
}

// ---------------------------------------------------------------------------
// Reading config.toml as TOML puts keys in tables and strings (no TOML library; security review, C12)
// ---------------------------------------------------------------------------

/** The one-letter escapes of a TOML basic string, and what each stands for. */
const TOML_ESCAPES = Object.freeze({ b: '\b', t: '\t', n: '\n', f: '\f', r: '\r', e: '\x1b', '"': '"', '\\': '\\' });

/** The digits each code point escape takes: \xHH, \uXXXX, \UXXXXXXXX. */
const TOML_HEX_ESCAPES = Object.freeze({ x: 2, u: 4, U: 8 });

/** A control character TOML refuses as it is in any one-line string (every one but tab). */
const isTomlControl = (c) => /[\x00-\x08\x0a-\x1f\x7f]/.test(c);

/**
 * The inside of a TOML basic string ("..." without its quotes) as TOML reads it: \b \t \n \f \r \"
 * \\ and \uXXXX \UXXXXXXXX, and the TOML 1.1 escapes \e and \xHH, which Codex reads too (Codex
 * 0.165.0's own `codex features list`, 29 Oct: "\x68ooks" = false under [features] turned its checks
 * off, and \e read as the escape character). Null for anything TOML refuses, so Codex cannot read the
 * file: any other escape (\/ among them), a code point that is no character, too few digits, or a
 * control character written as it is (security review C12). The one decoder for keys and values.
 */
function basicText(inner) {
  let out = '';
  for (let i = 0; i < inner.length; i += 1) {
    const c = inner[i];
    if (c !== '\\') {
      if (isTomlControl(c)) return null;
      out += c;
      continue;
    }
    const e = inner[i + 1];
    if (Object.hasOwn(TOML_ESCAPES, e)) {
      out += TOML_ESCAPES[e];
      i += 1;
      continue;
    }
    const digits = Object.hasOwn(TOML_HEX_ESCAPES, e) ? TOML_HEX_ESCAPES[e] : 0;
    const hex = inner.slice(i + 2, i + 2 + digits);
    if (!digits || hex.length !== digits || !/^[0-9A-Fa-f]+$/.test(hex)) return null;
    const code = Number.parseInt(hex, 16);
    if (code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return null;
    out += String.fromCodePoint(code);
    i += 1 + digits;
  }
  return out;
}

/** The inside of a TOML literal string ('...' without its quotes): as written, null with a control character. */
function literalText(inner) {
  return [...inner].some(isTomlControl) ? null : inner;
}

/** One TOML key, its quotes taken off and its escapes read as TOML reads them; a bare key as written; null when TOML refuses it. */
function unquotedKey(part) {
  const t = String(part).trim();
  let m = /^"((?:[^"\\]|\\.)*)"$/.exec(t);
  if (m) return basicText(m[1]);
  m = /^'([^']*)'$/.exec(t);
  return m ? literalText(m[1]) : t;
}

/** A dotted TOML key (a."b.c".'d') in its parts, quotes taken off; null when it cannot be read. */
function keyPath(raw) {
  const s = String(raw).trim();
  const parts = [];
  let i = 0;
  while (i < s.length) {
    const m = /^\s*("(?:[^"\\]|\\.)*"|'[^']*'|[A-Za-z0-9_-]+)\s*/.exec(s.slice(i));
    if (!m) return null;
    const part = unquotedKey(m[1]);
    if (part === null) return null;
    parts.push(part);
    i += m[0].length;
    if (i >= s.length) break;
    if (s[i] !== '.') return null;
    i += 1;
  }
  return parts.length ? parts : null;
}

/** Where a character outside quotes first appears in a line, or -1. */
function outsideQuotes(line, ch) {
  let q = null;
  for (let i = 0; i < line.length; i += 1) {
    const c = line[i];
    if (q === '"' && c === '\\') {
      i += 1;
      continue;
    }
    if (q) {
      if (c === q) q = null;
      continue;
    }
    if (c === '"' || c === "'") q = c;
    else if (c === ch) return i;
  }
  return -1;
}

/**
 * Where the TOML string that opens at s[i] ends: {end, broken}, end just past its closing quotes.
 * Basic strings ("...") take backslash escapes, literal ones ('...') none. A multi-line string (three
 * quotes, which TOML allows only as a value) runs over lines and ends at the first three quotes that
 * close it, any one or two quotes just inside them being its content, as TOML reads it; a one-line
 * string ends by its line's end. broken: never closed, which TOML refuses.
 */
function tomlStringEnd(s, i, multi) {
  const q = s[i];
  let j = i + (multi ? 3 : 1);
  while (j < s.length) {
    const c = s[j];
    if (!multi && c === '\n') return { end: j, broken: true };
    if (q === '"' && c === '\\') {
      if (!multi && s[j + 1] === '\n') return { end: j + 1, broken: true };
      j += 2;
      continue;
    }
    if (c === q && (!multi || (s[j + 1] === q && s[j + 2] === q))) {
      if (!multi) return { end: j + 1, broken: false };
      let k = j + 3;
      while (k < s.length && k < j + 5 && s[k] === q) k += 1;
      return { end: k, broken: false };
    }
    j += 1;
  }
  return { end: s.length, broken: true };
}

/**
 * config.toml statement by statement, as TOML splits it (security review C12): {header, array, raw}
 * for a header (header: a [table]'s key parts; array: an [[array of tables]]'s), {path, table, key,
 * value, raw} for `key = value` (the table's parts and the key's; path null under an array of
 * tables). Keys read as TOML reads them, escapes and all. unreadable: a header or key that cannot be
 * read (a bad escape, no `=`), which TOML refuses. A value runs over as many lines as its multi-line
 * string ("""...""" or '''...'''), array or inline table takes, so every line inside a string is the
 * string's content, never a header or a key of its own. Comments are taken off outside strings.
 * broken: a string, array or inline table never closed, which TOML refuses. Either way Codex cannot
 * read the file.
 */
function tomlEntries(text) {
  const s = String(text);
  const out = [];
  let table = [];
  let i = 0;
  while (i < s.length) {
    const start = i;
    let body = '';
    // header or pair, from the statement's first character; eq: where its key ends in body; depth:
    // the arrays and inline tables its value has open.
    let kind = null;
    let eq = -1;
    let depth = 0;
    let broken = false;
    while (i < s.length) {
      const c = s[i];
      if (c === '\n') {
        if (eq === -1 || depth === 0) break;
        body += c;
        i += 1;
        continue;
      }
      if (c === '#') {
        while (i < s.length && s[i] !== '\n') i += 1;
        continue;
      }
      if (kind === null && !/[ \t\r﻿]/.test(c)) kind = c === '[' ? 'header' : 'pair';
      if (c === '"' || c === "'") {
        const r = tomlStringEnd(s, i, eq !== -1 && s.startsWith(c.repeat(3), i));
        body += s.slice(i, r.end);
        i = r.end;
        if (r.broken) broken = true;
        continue;
      }
      if (kind === 'pair' && eq === -1 && c === '=') eq = body.length;
      else if (eq !== -1 && (c === '[' || c === '{')) depth += 1;
      else if (eq !== -1 && (c === ']' || c === '}') && depth > 0) depth -= 1;
      body += c;
      i += 1;
    }
    if (depth > 0) broken = true;
    const raw = s.slice(start, i);
    i += 1;
    const line = body.trim();
    if (!line) continue;
    if (kind === 'header') {
      const isArray = line.startsWith('[[');
      const close = isArray ? ']]' : ']';
      const parts = !broken && line.endsWith(close) ? keyPath(line.slice(close.length, -close.length)) : null;
      table = isArray ? null : parts;
      out.push({ header: isArray ? null : parts, array: isArray ? parts : null, raw, broken, unreadable: parts === null });
      continue;
    }
    const key = eq === -1 || broken ? null : keyPath(body.slice(0, eq));
    out.push({ path: table && key ? [...table, ...key] : null, table, key, value: eq === -1 ? '' : body.slice(eq + 1).trim(), raw, broken, unreadable: key === null });
  }
  return out;
}

/** The feature names that turn Codex's checks on and off. */
const HOOK_FEATURES = new Set(['hooks', 'codex_hooks']);

/** An inline table's keys and values ({ a = 1, "b" = false }), one level; null when it is not one. */
function inlineTable(value) {
  const v = String(value).trim();
  if (!v.startsWith('{') || !v.endsWith('}')) return null;
  const out = [];
  for (const part of v.slice(1, -1).split(',')) {
    if (!part.trim()) continue;
    const eq = outsideQuotes(part, '=');
    const key = eq === -1 ? null : keyPath(part.slice(0, eq));
    out.push({ path: key, value: eq === -1 ? '' : part.slice(eq + 1).trim() });
  }
  return out;
}

/**
 * What Codex's config.toml says about its checks: whether they are turned off ([features] hooks, or
 * the older codex_hooks, set to anything but true, in any TOML form: dotted, quoted, with escapes,
 * an inline table, or a [features.hooks] table), and whether the person turned this entry off
 * ([hooks.state."<key>"] enabled set to anything but true). Codex keeps the person's trust there too
 * (hookState, entryTrust).
 */
export function codexSettingsFacts({ codexHome, hookKey = null }) {
  const file = path.join(codexHome, 'config.toml');
  let text = '';
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return { file, read: false, checksOff: false, turnedOff: false };
  }
  let checksOff = false;
  let turnedOff = false;
  for (const e of tomlEntries(text)) {
    // A [features.hooks] table is read by its lines (features.hooks.enabled) below.
    const p = e.path;
    if (!p) continue;
    if (p[0] === 'features' && HOOK_FEATURES.has(p[1])) {
      if (p.length === 2 && e.value !== 'true') checksOff = true;
      if (p.length === 3 && p[2] === 'enabled' && e.value !== 'true') checksOff = true;
      if (p.length > 3) checksOff = true;
    }
    if (p.length === 1 && p[0] === 'features') {
      // features = { hooks = false }, or { hooks.enabled = false }
      const t = inlineTable(e.value);
      if (t && t.some((x) => x.path && HOOK_FEATURES.has(x.path[0]) && x.value !== 'true')) checksOff = true;
    }
    if (hookKey && p.length === 4 && p[0] === 'hooks' && p[1] === 'state' && p[2] === hookKey && p[3] === 'enabled' && e.value !== 'true') turnedOff = true;
  }
  return { file, read: true, checksOff, turnedOff };
}

/** Codex's names for the two events in its settings keys (openai/codex codex-rs/hooks/src/lib.rs hook_event_key_label). */
export const EVENT_KEYS = Object.freeze({ PreToolUse: 'pre_tool_use', SessionStart: 'session_start' });

/** Codex's key for an entry's trust and on/off state (openai/codex codex-rs/hooks/src/lib.rs hook_key). */
export function hookKeyOf(hooksFile, groupIndex, handlerIndex = 0, event = 'PreToolUse') {
  return `${hooksFile}:${EVENT_KEYS[event] ?? 'pre_tool_use'}:${groupIndex}:${handlerIndex}`;
}

/** Codex's default for a hook's additionalContextLimit, which it leaves out of the hash. */
const DEFAULT_CONTEXT_LIMIT = 2500;

/** A value with every object's keys sorted, as serde_json's sort_all_objects leaves it. */
function sortedDeep(v) {
  if (Array.isArray(v)) return v.map(sortedDeep);
  if (v && typeof v === 'object') return Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortedDeep(v[k])]));
  return v;
}

/**
 * The hash Codex keeps the person's trust under for one command entry (ADR-0157): "sha256:" and the
 * hex SHA-256 of the compact JSON, with every object's keys sorted, of {event_name, matcher (only when
 * the group has one), hooks: [the handler as Codex normalises it]}: type "command", the command, its
 * timeout (600 when unset), async (false when unset), statusMessage when set, and additionalContextLimit
 * only when set to anything but 2,500 (openai/codex rust-v0.165.0: codex-rs/hooks/src/engine/discovery.rs
 * hook_hash and normalize_command_hook, codex-rs/config/src/fingerprint.rs version_for_toml). It matched
 * the hashes Codex 0.165.0 wrote when the person trusted two entries on 28 Oct (test/brief.test.mjs).
 * Null for a handler that is not a command.
 */
export function codexHookHash(event, handler, matcher = null) {
  if (!handler || handler.type !== 'command' || typeof handler.command !== 'string') return null;
  const timeout = Number.isInteger(handler.timeout) && handler.timeout > 0 ? handler.timeout : Number.isInteger(handler.timeout) ? 1 : 600;
  const normal = { type: 'command', command: handler.command, timeout, async: handler.async === true };
  if (typeof handler.statusMessage === 'string') normal.statusMessage = handler.statusMessage;
  if (Number.isInteger(handler.additionalContextLimit) && handler.additionalContextLimit >= 0 && handler.additionalContextLimit !== DEFAULT_CONTEXT_LIMIT) {
    normal.additionalContextLimit = handler.additionalContextLimit;
  }
  const identity = { event_name: EVENT_KEYS[event] ?? event, hooks: [normal] };
  if (typeof matcher === 'string') identity.matcher = matcher;
  return `sha256:${createHash('sha256').update(JSON.stringify(sortedDeep(identity)), 'utf8').digest('hex')}`;
}

/** One TOML basic or literal string ("a\"b" or 'a'), its value read as keys are (basicText); null for anything else. */
function tomlString(raw) {
  const s = String(raw ?? '').trim();
  let m = /^"((?:[^"\\]|\\.)*)"$/.exec(s);
  if (m) return basicText(m[1]);
  m = /^'([^']*)'$/.exec(s);
  return m ? literalText(m[1]) : null;
}

/**
 * What Codex's config.toml keeps about one entry (ADR-0157): {trustedHash, enabled} from its own
 * table, [hooks.state."<key>"] trusted_hash = "sha256:..." and enabled, as Codex writes them when the
 * person trusts or turns off an entry in /hooks, keys read as TOML reads them. enabled is false unless
 * exactly true. Any other mention of the key (an inline table, a dotted key, another field, a value
 * naming it, a string of one line or several, an array table) makes it unknown: never read as trusted
 * (security review), and so does anything Codex cannot read (C12): a string, array or inline table
 * never closed, or a header or key that cannot be read, such as an escape TOML refuses. {read: false}
 * when the file cannot be read; a missing file reads as no trust.
 */
export function hookState({ codexHome, hookKey }) {
  const file = path.join(codexHome, 'config.toml');
  let text = '';
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (e) {
    return { file, read: e?.code === 'ENOENT', trustedHash: null, enabled: true, unknown: false };
  }
  let trustedHash = null;
  let enabled = true;
  let unknown = false;
  const ours = (p) => Array.isArray(p) && p.length >= 3 && p[0] === 'hooks' && p[1] === 'state' && p[2] === hookKey;
  for (const e of tomlEntries(text)) {
    if (e.broken || e.unreadable) {
      unknown = true;
      continue;
    }
    if ('header' in e) {
      // An array of tables naming the key is never Codex's trust; a table only as Codex writes it.
      if (e.array ? e.array.includes(hookKey) : e.header.includes(hookKey) && !(ours(e.header) && e.header.length === 3)) unknown = true;
      continue;
    }
    const p = e.path;
    if (!p) {
      if (e.raw.includes(hookKey)) unknown = true;
      continue;
    }
    if (!p.includes(hookKey)) {
      if (e.value.includes(hookKey)) unknown = true;
      continue;
    }
    if (!ours(e.table)) {
      unknown = true;
      continue;
    }
    // Only inside the entry's own table, as Codex writes it: [hooks.state."<key>"], then one-part keys.
    const inOwnTable = ours(e.table) && e.table.length === 3 && e.key?.length === 1;
    if (inOwnTable && e.key[0] === 'trusted_hash') {
      const v = tomlString(e.value);
      if (v === null) unknown = true;
      else trustedHash = v;
      continue;
    }
    if (inOwnTable && e.key[0] === 'enabled') {
      enabled = e.value === 'true';
      continue;
    }
    unknown = true;
  }
  return { file, read: true, trustedHash, enabled, unknown };
}

/**
 * Whether Codex trusts one of our entries now (ADR-0157), from Codex's own files only: the entry as
 * hooks.json has it and its place, and what config.toml keeps for that place. state: trusted (the
 * hash Codex kept is this entry's), changed (Codex kept a hash, but the entry changed since, so Codex
 * skips it until the person trusts it again), untrusted (no trust kept), unknown (config.toml could
 * not be read), missing (no such entry). off: the person turned it off in /hooks.
 */
export function entryTrust({ codexHome, at, event }) {
  if (!at?.present) return { state: 'missing', off: false, key: null };
  const key = hookKeyOf(at.file, at.groupIndex, at.handlerIndex, event);
  const kept = hookState({ codexHome, hookKey: key });
  if (!kept.read || kept.unknown) return { state: 'unknown', off: kept.enabled === false, key };
  const hash = codexHookHash(event, at.handler, at.matcher);
  const state = !kept.trustedHash ? 'untrusted' : kept.trustedHash === hash ? 'trusted' : 'changed';
  return { state, off: kept.enabled === false, key };
}
