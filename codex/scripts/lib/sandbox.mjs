// Whether Codex's own sandbox holds a command (CN6; ADR-0090 for Codex; ADR-0146). A program Codex
// wrote runs unasked only while the sandbox holds it: then it cannot reach the network or change
// files outside the project, and the person, not an automatic reviewer, sees any request to leave it.
//
// Codex sends no sandbox field with a check (its PreToolUse input is session_id, transcript_path,
// cwd, model, permission_mode, turn_id, tool_name, tool_use_id and tool_input), so this reads what
// decides it, the way install.mjs codexSettingsFacts reads config.toml: as text, with no TOML
// library. It holds only when every one of these is known:
//   - the system has Codex's sandbox: macOS (Seatbelt) or Linux;
//   - sandbox_mode is workspace-write, read-only or unset, in config.toml, in the profile in use
//     ([profiles.<name>], or $CODEX_HOME/<name>.config.toml), in the project's .codex/config.toml
//     and in what the codex command was started with (-s, --sandbox, -c);
//   - sandbox_workspace_write.network_access is not true anywhere;
//   - the person reviews any request to leave the sandbox (approvals_reviewer unset or "user", no
//     --approve-for-me), or approval_policy is "never", so none is made;
//   - no allow rule in $CODEX_HOME/rules (prefix_rule) matches the command's first words;
//   - permission_mode is not bypassPermissions;
//   - no codex process above this check was started with --sandbox danger-full-access,
//     --dangerously-bypass-approvals-and-sandbox or --yolo;
//   - the model's call does not ask to leave the sandbox (sandbox_permissions "require_escalated",
//     or with_escalated_permissions).
// Anything it cannot read counts as off, and Aimiru asks.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

/** The sandbox modes that hold a command (Codex config reference, sandbox_mode). */
const HOLDING_MODES = new Set(['workspace-write', 'read-only']);

/** One TOML value written on one line, read as text: a string, true or false, or the bare word. */
function tomlScalar(raw) {
  const v = String(raw ?? '').trim();
  const basic = /^"((?:[^"\\]|\\.)*)"/.exec(v);
  if (basic) return basic[1].replace(/\\(.)/g, '$1');
  const literal = /^'([^']*)'/.exec(v);
  if (literal) return literal[1];
  const bare = v.replace(/\s+#.*$/, '').trim();
  if (bare === 'true') return true;
  if (bare === 'false') return false;
  return bare;
}

/** A dotted TOML key with its quotes and spaces taken out: profiles."work".sandbox_mode -> profiles.work.sandbox_mode. */
const keyOf = (k) =>
  String(k)
    .trim()
    .replace(/\s*\.\s*/g, '.')
    .replace(/["']/g, '');

/**
 * The settings one Codex config file holds, as text: {read, values: Map(key -> [values])}, keys
 * with their section ("profiles.work.sandbox_mode", "sandbox_workspace_write.network_access"),
 * inline tables too. A file that is not there reads as empty; one that is there but cannot be
 * read is read: false.
 */
export function tomlFacts(file, readFile = (f) => fs.readFileSync(f, 'utf8')) {
  let text;
  try {
    text = readFile(file);
  } catch (e) {
    return { read: e?.code === 'ENOENT', values: new Map() };
  }
  const values = new Map();
  const put = (key, value) => {
    if (!values.has(key)) values.set(key, []);
    values.get(key).push(value);
  };
  let section = '';
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const header = /^\[\[?\s*([^\]]+?)\s*\]\]?\s*(#.*)?$/.exec(line);
    if (header) {
      section = keyOf(header[1]);
      continue;
    }
    const kv = /^((?:[A-Za-z0-9_-]+|"[^"]*"|'[^']*')(?:\s*\.\s*(?:[A-Za-z0-9_-]+|"[^"]*"|'[^']*'))*)\s*=\s*(.*)$/.exec(line);
    if (!kv) continue;
    const key = (section ? `${section}.` : '') + keyOf(kv[1]);
    const value = kv[2].trim();
    if (value.startsWith('{')) {
      for (const pair of value.replace(/^\{|\}\s*(#.*)?$/g, '').split(',')) {
        const inner = /^\s*([^=]+?)\s*=\s*(.*)$/.exec(pair);
        if (inner) put(`${key}.${keyOf(inner[1])}`, tomlScalar(inner[2]));
      }
    } else put(key, tomlScalar(value));
  }
  return { read: true, values };
}

/** ps's elapsed time ([[dd-]hh:]mm:ss, on macOS and Linux) in seconds, or null when it cannot be read. */
export function elapsedSeconds(etime) {
  const m = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/.exec(String(etime ?? '').trim());
  if (!m) return null;
  return ((Number(m[1] ?? 0) * 24 + Number(m[2] ?? 0)) * 60 + Number(m[3])) * 60 + Number(m[4]);
}

/**
 * The processes above this one (up to `depth`): [{args, startedMs}], startedMs when ps says how long
 * it has run (else null), or null when they cannot be read.
 */
export function ancestorProcesses({ pid = process.ppid, depth = 8, run = spawnSync, now = Date.now() } = {}) {
  const procs = [];
  let cur = pid;
  for (let i = 0; i < depth && cur && cur > 1; i += 1) {
    let r;
    try {
      r = run('ps', ['-o', 'ppid=', '-o', 'etime=', '-o', 'args=', '-p', String(cur)], { encoding: 'utf8', timeout: 1_000, env: { ...process.env, LC_ALL: 'C' } });
    } catch {
      return null;
    }
    if (!r || r.status !== 0 || typeof r.stdout !== 'string' || !r.stdout.trim()) return procs.length ? procs : null;
    const m = /^\s*(\d+)\s+(\S+)\s+(.*)$/s.exec(r.stdout.trim());
    if (!m) return null;
    const secs = elapsedSeconds(m[2]);
    procs.push({ args: m[3], startedMs: secs === null ? null : now - secs * 1000 });
    cur = Number(m[1]);
  }
  return procs;
}

/** The command lines of the processes above this one (up to `depth`), or null when they cannot be read. */
export function ancestorCommandLines(opts = {}) {
  return ancestorProcesses(opts)?.map((p) => p.args) ?? null;
}

/**
 * True when a settings file changed after the codex process started (review of wk/connectors-flow,
 * 28 Oct): Codex read it as it was at its start, so what it says now is not what Codex runs with.
 * Within a second of the start counts as after (ps gives whole seconds). A file that is not there
 * never changed; one that cannot be read did, as far as Aimiru knows.
 */
function changedSinceStart(file, startedMs, statFile) {
  let mtimeMs;
  try {
    mtimeMs = statFile(file).mtimeMs;
  } catch (e) {
    return e?.code !== 'ENOENT';
  }
  return !Number.isFinite(mtimeMs) || mtimeMs > startedMs - 1_000;
}

/**
 * What the codex commands above this check were started with: {found, profile, overrides: [[key,
 * value]], off: why | null, at: [index]}. found is false when no codex process is among them; at
 * lists where in `lines` each codex process is.
 */
export function codexStartFlags(lines) {
  const out = { found: false, profile: null, overrides: [], off: null, at: [] };
  for (const [index, raw] of (lines || []).entries()) {
    // ps joins a command's words with spaces, so a path with a space in it reads as several: the
    // program is a word ending in "codex" (a path's last part) before the command's first option.
    const line = String(raw).trim();
    const m = /(?:^|\/)codex(?:\.js|\.exe)?(?=\s|$)/i.exec(line);
    if (!m || /(^|\s)-/.test(line.slice(0, m.index))) continue;
    out.found = true;
    out.at.push(index);
    const rest = line.slice(m.index + m[0].length).trim().split(/\s+/).filter(Boolean);
    for (let k = 0; k < rest.length; k += 1) {
      const w = rest[k];
      const value = (long, short) => {
        if (w === long || (short && w === short)) return rest[(k += 1)] ?? '';
        return w.startsWith(`${long}=`) ? w.slice(long.length + 1) : null;
      };
      if (w === '--dangerously-bypass-approvals-and-sandbox' || w === '--yolo') out.off ||= `codex was started with ${w}`;
      else if (w === '--approve-for-me') out.overrides.push(['approvals_reviewer', 'auto']);
      else if (w === '--full-auto') out.overrides.push(['sandbox_mode', 'workspace-write']);
      let v;
      if ((v = value('--sandbox', '-s')) !== null) out.overrides.push(['sandbox_mode', v]);
      else if ((v = value('--ask-for-approval', '-a')) !== null) out.overrides.push(['approval_policy', v]);
      else if ((v = value('--profile', '-p')) !== null) out.profile = v;
      else if ((v = value('--config', '-c')) !== null) {
        const eq = v.indexOf('=');
        if (eq > 0) out.overrides.push([keyOf(v.slice(0, eq)), tomlScalar(v.slice(eq + 1))]);
      }
    }
  }
  return out;
}

/** One rule's pattern from a rules file: a list of words, each a word or a list of words it may be. Null when it cannot be read. */
function patternOf(text) {
  const m = /\bpattern\s*=\s*\[/.exec(text);
  if (!m) return null;
  const pattern = [];
  let i = m.index + m[0].length;
  let group = null;
  while (i < text.length) {
    const c = text[i];
    if (/[\s,]/.test(c)) i += 1;
    else if (c === '"' || c === "'") {
      const end = text.indexOf(c, i + 1);
      if (end === -1) return null;
      const word = text.slice(i + 1, end);
      if (group) group.push(word);
      else pattern.push(word);
      i = end + 1;
    } else if (c === '[' && !group) {
      group = [];
      i += 1;
    } else if (c === ']') {
      if (!group) return pattern.length ? pattern : null;
      pattern.push(group);
      group = null;
      i += 1;
    } else return null;
  }
  return null;
}

/**
 * The allow rules in Codex's rules files ($CODEX_HOME/rules/*.rules, prefix_rule): {read, rules:
 * [pattern]}. A rule with no decision is read as allow. read: false when a file or an allow rule in
 * it cannot be read.
 */
export function allowRules(rulesDir, { readDir = (d) => fs.readdirSync(d), readFile = (f) => fs.readFileSync(f, 'utf8') } = {}) {
  let names;
  try {
    names = readDir(rulesDir);
  } catch (e) {
    return { read: e?.code === 'ENOENT', rules: [] };
  }
  const rules = [];
  for (const name of names.filter((n) => n.endsWith('.rules'))) {
    let text;
    try {
      text = readFile(path.join(rulesDir, name));
    } catch {
      return { read: false, rules };
    }
    for (const m of text.matchAll(/prefix_rule\s*\(/g)) {
      // The rule's own text: to its closing parenthesis, quotes respected.
      let depth = 1;
      let end = m.index + m[0].length;
      let quote = null;
      for (; end < text.length && depth > 0; end += 1) {
        const c = text[end];
        if (quote) {
          if (c === '\\') end += 1;
          else if (c === quote) quote = null;
        } else if (c === '"' || c === "'") quote = c;
        else if (c === '(') depth += 1;
        else if (c === ')') depth -= 1;
      }
      const body = text.slice(m.index + m[0].length, end - 1);
      const decision = /\bdecision\s*=\s*["']([a-z_-]+)["']/i.exec(body)?.[1]?.toLowerCase() ?? 'allow';
      if (decision !== 'allow') continue;
      const pattern = patternOf(body);
      if (!pattern) return { read: false, rules };
      rules.push(pattern);
    }
  }
  return { read: true, rules };
}

/** True when an allow rule's pattern starts one of the command's simple commands. */
export function ruleMatches(rules, command) {
  const steps = String(command ?? '').split(/&&|\|\||[;|\n]/);
  return steps.some((step) => {
    const words = step.trim().split(/\s+/).filter(Boolean);
    while (words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0])) words.shift();
    const plain = words.map((w) => w.replace(/^["']|["']$/g, ''));
    return rules.some((pattern) => pattern.length <= plain.length && pattern.every((p, i) => (Array.isArray(p) ? p.includes(plain[i]) : p === plain[i])));
  });
}

/**
 * Whether Codex's sandbox holds this command: {on, state: "on" | "off" | "unknown", why}.
 * @param {object} o
 *   codexHome   Codex's folder (CODEX_HOME)
 *   projectDir  the project, for its .codex/config.toml (null: none)
 *   platform    process.platform
 *   input       the check's input (permission_mode, tool_input)
 *   callArgs    the model's own arguments for this call, from the session's transcript (null: not read)
 *   command     the command the call runs
 *   parents     the command lines above this check (undefined: read them; null: they could not be read)
 *   codexStartedMs when the codex process above started (undefined: from ps with the command lines,
 *               and not judged when the lines are given; null: not known)
 *   statFile    fs.statSync, for when a settings file last changed
 */
export function codexSandbox({ codexHome, projectDir = null, platform = process.platform, input = {}, callArgs = null, command = '', parents = undefined, codexStartedMs = undefined, readFile, readDir, statFile = (f) => fs.statSync(f) } = {}) {
  const off = (why) => ({ on: false, state: 'off', why });
  const unknown = (why) => ({ on: false, state: 'unknown', why });
  if (platform !== 'darwin' && platform !== 'linux') return off('Codex has no sandbox on this system');
  if (!codexHome) return unknown("Codex's folder is not known");
  if (String(input?.permission_mode ?? '') === 'bypassPermissions') return off('Codex runs with every permission (bypassPermissions)');
  let lines = parents;
  let starts = null;
  if (parents === undefined) {
    const procs = ancestorProcesses();
    lines = procs ? procs.map((p) => p.args) : null;
    starts = procs ? procs.map((p) => p.startedMs) : null;
  }
  if (!lines) return unknown('the codex command this check runs under could not be read');
  const started = codexStartFlags(lines);
  if (!started.found) return unknown('no codex command was found above this check');
  if (started.off) return off(started.off);
  // When Codex read its settings: the earliest start of the codex processes above. A project's or a
  // profile's settings changed since then are not what the running Codex has (an agent's edit, asked
  // about, that Codex never loads), so they read as unknown, never as what they say now.
  let codexStart = codexStartedMs;
  if (codexStart === undefined && starts) {
    const at = started.at.map((i) => starts[i]);
    codexStart = at.some((s) => typeof s !== 'number') ? null : Math.min(...at);
  }
  const changedSince = (file) => {
    if (codexStart === undefined) return false;
    // Not known: any such file that is there may have changed.
    if (codexStart === null) return changedSinceStart(file, -Infinity, statFile);
    return changedSinceStart(file, codexStart, statFile);
  };

  // The settings, from every place they can come from; one that turns the sandbox off is enough.
  const files = [tomlFacts(path.join(codexHome, 'config.toml'), readFile)];
  if (!files[0].read) return unknown("Codex's config.toml could not be read");
  const lastOf = (facts, key) => facts.values.get(key)?.at(-1);
  const profile = started.profile || lastOf(files[0], 'profile') || null;
  const scopes = [''];
  if (profile) {
    scopes.push(`profiles.${keyOf(profile)}.`);
    const ownFile = path.join(codexHome, `${path.basename(String(profile))}.config.toml`);
    if (changedSince(ownFile)) return unknown(`the profile ${profile} changed after Codex started`);
    const own = tomlFacts(ownFile, readFile);
    if (!own.read) return unknown(`the profile ${profile} could not be read`);
    files.push(own);
  }
  if (projectDir) {
    const projectFile = path.join(projectDir, '.codex', 'config.toml');
    // The folder too: removing or renaming the file changes the folder, not the file.
    if (changedSince(projectFile) || changedSince(path.dirname(projectFile))) return unknown("the project's Codex settings changed after Codex started");
    const project = tomlFacts(projectFile, readFile);
    if (!project.read) return unknown("the project's Codex settings could not be read");
    files.push(project);
  }
  const all = (key) => [...files.flatMap((f) => scopes.flatMap((s) => f.values.get(`${s}${key}`) ?? [])), ...started.overrides.filter(([k]) => k === key).map(([, v]) => v)];

  const modes = all('sandbox_mode').map((v) => String(v));
  const loose = modes.find((m) => !HOLDING_MODES.has(m));
  if (loose !== undefined) return off(`Codex's sandbox_mode is ${loose}`);
  if (all('sandbox_workspace_write.network_access').some((v) => v === true || String(v) === 'true')) return off("Codex's sandbox lets commands reach the network");
  const policies = all('approval_policy').map((v) => String(v));
  const reviewers = all('approvals_reviewer').map((v) => String(v));
  const personReviews = reviewers.every((r) => r === 'user');
  const neverAsks = policies.length > 0 && policies.every((p) => p === 'never');
  if (!personReviews && !neverAsks) return off('requests to leave the sandbox are reviewed automatically, not by you');

  const escalation = [callArgs, input?.tool_input].some((a) => a && typeof a === 'object' && (a.sandbox_permissions === 'require_escalated' || a.with_escalated_permissions === true));
  if (escalation) return off('Codex asked to run this command outside its sandbox');
  if (!callArgs) return unknown("the model's call could not be read from the session");

  const rules = allowRules(path.join(codexHome, 'rules'), { readFile, readDir });
  if (!rules.read) return unknown("Codex's rules could not be read");
  if (ruleMatches(rules.rules, command)) return off('a rule in Codex lets this command run outside its sandbox');
  return { on: true, state: 'on', why: "Codex's sandbox holds this command" };
}
