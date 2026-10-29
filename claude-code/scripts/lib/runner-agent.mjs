// Claude Code's take path for the runner (ADR-0161): the runner on this computer asks Aimiru for the
// job the person gave Claude Code and starts `claude -p` on it in the folder the person chose, with
// the person's own settings, so Aimiru's plugin and its check load as in any session.
//
// Never a job unchecked. ready() refuses unless: Claude Code is 2.1.295 or later (a check that fails
// blocks) and knows --permission-prompts; Aimiru's plugin is installed in Claude Code's own plugins
// folder with its PreToolUse entry intact (onFailure block, pre-tool-use.mjs); the person's settings
// turn it on; and no settings file Claude Code reads for that folder (managed, the person's, the
// folder's own up to its git folder) turns it off, turns all checks off or changes how the check runs
// (turnsSaysoOff); and the key is the one /aimiru:connect saved in the plugin's own data folder, so
// the job record below is signed with the key the session's checks use.
//
// Nor from the environment (security review of wk/runner): Claude Code reads CLAUDE_CODE_SIMPLE as
// --bare and CLAUDE_CODE_SAFE_MODE as --safe-mode, under which no plugin's check runs, and NODE_OPTIONS
// can load code into the check. ready() refuses while the runner's own environment (a terminal's, or
// what launchd gives every program at login) holds one of those or a setting that changes how the
// check runs (envProblem), and Claude Code is given only the settings it needs (childEnvOf), whatever
// the runner's environment holds.
//
// The run: `claude -p --output-format stream-json --verbose --permission-prompts none --session-id
// <new id>` (CLAUDE_FLAGS, nothing else; NEVER_FLAGS is pinned by a test), the job on its input,
// AIMIRU_TASK_ID in its environment. Before it starts, the session's job record that Claude Code's
// check already reads is written for that session id (putSessionTask, signed), so every check names
// the job. Then proof, before the first step: Claude Code's own system/init event must list Aimiru's
// plugin at the folder it is installed in, with no error about it (pluginLoaded), or the run is
// stopped at once and recorded as not done; a step asked for before that event stops it too. A
// settings file that fails Claude Code's own validation is skipped silently in -p, so reading the
// files beforehand is not proof. --permission-prompts none only tightens: with nobody at the
// keyboard, anything that would ask is refused by Claude Code itself, and the result says so. Short
// notes from Claude Code's own events (never output, file contents or reasoning) and the redacted
// result go to Aimiru with the job's id. Ctrl+C or the runner stopping ends the run, recorded as not
// done.

import { spawn as spawnChild, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { jobPrompt } from '../vendor/messages.mjs';
import { redactContacts } from '../vendor/contacts.mjs';
import { claudePluginInstall, createNotes, noteLine, printable } from '../vendor/runner.mjs';
import { redactSecrets, sha256Hex, truncate } from '../vendor/sayso-client.mjs';
import { settingsFiles } from './native-prompt.mjs';
import { HIJACK_ENV_RE, MIN_ENFORCED_VERSION, claudeConfigDir, compareVersions, findDataDir, loadSettings, makeClient, stateStore, turnsSaysoOff } from './runtime.mjs';

/** The shape the shared runner reads (vendor/runner.mjs RUNNER_AGENT_VERSION). */
export const RUNNER_AGENT = 1;
/** The longest one job may run before it is stopped and recorded as not finished. */
export const RUN_LIMIT_MS = 60 * 60_000;
/** The longest result Aimiru takes (CONTRACT.md, POST /v1/receipts result). */
export const RESULT_MAX = 4_000;
/** How long what `claude --version` and `--help` said is kept. */
const PROGRAM_KEEP_MS = 10 * 60_000;
/** The one script Aimiru's check runs before each step, as the plugin's hooks.json names it. */
const CHECK_SCRIPT = '${CLAUDE_PLUGIN_ROOT}/scripts/pre-tool-use.mjs';

/** Everything the runner passes to `claude`, besides the new session's id. */
export function claudeArgs({ sessionId }) {
  return ['-p', '--output-format', 'stream-json', '--verbose', '--permission-prompts', 'none', '--session-id', sessionId];
}

/** The flags claudeArgs passes, and only these. */
export const CLAUDE_FLAGS = Object.freeze(['-p', '--output-format', '--verbose', '--permission-prompts', '--session-id']);

/**
 * Flags that loosen or bypass Claude Code's permissions, change which settings, plugins or servers
 * load, or continue another session: the runner never passes one (test/runner.test.mjs).
 */
export const NEVER_FLAGS = Object.freeze([
  '--dangerously-skip-permissions',
  '--allow-dangerously-skip-permissions',
  '--permission-mode',
  '--allowedTools',
  '--allowed-tools',
  '--disallowedTools',
  '--disallowed-tools',
  '--tools',
  '--add-dir',
  '--settings',
  '--setting-sources',
  '--plugin-dir',
  '--plugin-url',
  '--mcp-config',
  '--strict-mcp-config',
  '--bare',
  '--safe-mode',
  '--restricted',
  '--permission-prompt-tool',
  '--resume',
  '-r',
  '--continue',
  '-c',
  '--fork-session',
  '--agents',
  '--agent',
  '--system-prompt',
  '--append-system-prompt',
  '--disable-slash-commands',
  '--bg',
  '--background',
  '--cloud',
  '--remote-control',
]);

/** The words the person reads about Claude Code on the computer (docs/04). */
export const CC_RUNNER_WORDS = Object.freeze({
  noClaude: 'Claude Code is not on this computer, so the runner cannot start it.',
  tooOld: (min) => `Claude Code needs updating to ${min} or later before the runner can start it. Run: claude update`,
  noPlugin: "Aimiru's plugin is not installed in Claude Code. Add it, then turn the runner on again.",
  changed: "Aimiru's plugin files in Claude Code are changed, so a failed check might not stop a step. Reinstall the plugin.",
  pluginOff: "Aimiru's plugin is off in your Claude Code settings. Turn it on with: claude plugin enable aimiru@aimiru",
  turnedOff: (file) => `A Claude Code settings file turns Aimiru's check off or changes how it runs: ${file}. Change it there.`,
  unreadable: (file) => `A Claude Code settings file here cannot be read, so the runner cannot tell that Aimiru's check is on: ${file}.`,
  noKey: 'Connect Claude Code once with /aimiru:connect in Claude Code, so the runner can use the key it saves on this computer.',
  env: (variable) => `Your environment sets ${variable}, which would turn Aimiru's check off in Claude Code or change how it runs, so the runner starts nothing. Remove it where it is set (for programs started at login: launchctl unsetenv ${variable}), then turn the runner on again.`,
  notLoaded: "Claude Code could not start this job: Aimiru's check did not load, so the runner stopped it before its first step.",
  done: 'Claude Code finished the job.',
  notDone: 'Claude Code did not finish the job.',
});

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

/**
 * The only settings Claude Code gets from the runner's environment: where the person's files and
 * programs are, their language and time zone, Claude Code's own folder when the person set one, Claude
 * Code's own sign-in, a network's own proxy, and the job's id. Anything else Claude Code should have
 * (a gateway, a cloud provider) goes in its own settings file's env, which Claude Code applies itself
 * and Aimiru's check protects. Never CLAUDE_CODE_SIMPLE, CLAUDE_CODE_SAFE_MODE, NODE_OPTIONS,
 * NODE_PATH or a setting of Aimiru's or the plugin's.
 */
export const CHILD_ENV_KEYS = Object.freeze([
  'HOME',
  'USER',
  'LOGNAME',
  'PATH',
  'SHELL',
  'TMPDIR',
  'LANG',
  'TERM',
  'TZ',
  'CLAUDE_CONFIG_DIR',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'HTTPS_PROXY',
  'HTTP_PROXY',
  'NO_PROXY',
  'https_proxy',
  'http_proxy',
  'no_proxy',
  'AIMIRU_TASK_ID',
]);
/** The language settings (LC_ALL, LC_CTYPE and the rest). */
const CHILD_ENV_LC = /^LC_[A-Z_]+$/;

/** Claude Code's environment for one job: CHILD_ENV_KEYS and LC_* from env, only when set, and the job's id. */
export function childEnvOf(env, taskId = null) {
  const out = {};
  for (const [k, v] of Object.entries(env || {})) {
    if (v === undefined || v === null || String(v) === '') continue;
    if (CHILD_ENV_KEYS.includes(k) || CHILD_ENV_LC.test(k)) out[k] = String(v);
  }
  delete out.AIMIRU_TASK_ID;
  if (taskId) out.AIMIRU_TASK_ID = String(taskId);
  return out;
}

/** Settings that switch Claude Code's checks off (--bare, --safe-mode) or load code into node. */
const OFF_ENV = Object.freeze(['CLAUDE_CODE_SIMPLE', 'CLAUDE_CODE_SAFE_MODE', 'NODE_OPTIONS', 'NODE_PATH']);
/** The runner's own choice of program, and the person's own Claude Code folder, which it keeps. */
const RUNNER_OWN_ENV = new Set(['AIMIRU_CLAUDE_BIN', 'CLAUDE_CONFIG_DIR']);

/**
 * The first setting in the runner's environment that would turn Aimiru's check off or change how it
 * runs (OFF_ENV, and the settings a settings file may not set either: HIJACK_ENV_RE), or null. An
 * empty setting is no setting.
 */
export function envProblem(env = process.env) {
  for (const [k, v] of Object.entries(env || {})) {
    if (v === undefined || v === null || String(v) === '' || RUNNER_OWN_ENV.has(k)) continue;
    if (OFF_ENV.includes(k.toUpperCase()) || HIJACK_ENV_RE.test(k)) return k;
  }
  return null;
}

function realOrSelf(p) {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

/**
 * True when Claude Code's system/init event says it loaded Aimiru's plugin from the folder it is
 * installed in (install: claudePluginInstall), with no plugin error naming it. Claude Code 2.1.312
 * lists each loaded plugin as {name, path, source, version?}; under --bare or --safe-mode, by flag or
 * by setting, it loads none.
 */
export function pluginLoaded(ev, install) {
  if (!ev || typeof ev !== 'object' || ev.type !== 'system' || ev.subtype !== 'init' || !install?.root) return false;
  const root = realOrSelf(install.root);
  const plugins = Array.isArray(ev.plugins) ? ev.plugins : [];
  if (!plugins.some((p) => p && typeof p.path === 'string' && p.path && realOrSelf(p.path) === root)) return false;
  const marks = [root, install.root, install.id, String(install.id ?? '').split('@')[0]].filter(Boolean).map((s) => JSON.stringify(String(s)).slice(1, -1));
  const errors = Array.isArray(ev.plugin_errors) ? ev.plugin_errors : [];
  return !errors.some((e) => {
    const s = JSON.stringify(e ?? null);
    return marks.some((m) => s.includes(m));
  });
}

/** What `<bin> --version` and `<bin> --help` say, kept a while. */
function programFacts(bin, cache, env, now = Date.now()) {
  const hit = cache.get(bin);
  if (hit && now - hit.at < PROGRAM_KEEP_MS) return hit;
  const run = (args) => {
    try {
      const r = spawnSync(bin, args, { encoding: 'utf8', timeout: 10_000, stdio: ['ignore', 'pipe', 'ignore'], env });
      return r.error || r.status !== 0 ? null : String(r.stdout || '');
    } catch {
      return null;
    }
  };
  const v = run(['--version']);
  const version = v ? (/(\d+\.\d+\.\d+)/.exec(v)?.[1] ?? null) : null;
  const help = version ? run(['--help']) : null;
  const facts = { at: now, found: v !== null, version, prompts: Boolean(help && /--permission-prompts\b/.test(help)) };
  cache.set(bin, facts);
  return facts;
}

/** The Claude Code program: AIMIRU_CLAUDE_BIN (the runner sets it from `runner on`), else claude on PATH. */
export function claudeBinOf(env = process.env) {
  return env.AIMIRU_CLAUDE_BIN || env.SAYSO_CLAUDE_BIN || 'claude';
}

/** The plugin's own settings, as its hooks read them, from the data folder Claude Code keeps for it. */
export function pluginSettings(env = process.env) {
  const dataDir = findDataDir({ ...env, CLAUDE_PLUGIN_DATA: '' });
  return { ...loadSettings({ ...env, CLAUDE_PLUGIN_DATA: dataDir }), dataDir };
}

/**
 * Whether a job may run in dir now: {ok: true} or {ok: false, why, text, file?}, failing closed.
 * @param {object} o @param {object} o.env @param {string} o.dir @param {Map} [o.cache]
 */
export function readyToRun({ env, dir, cache = new Map(), managed = null }) {
  const variable = envProblem(env);
  if (variable) return { ok: false, why: 'env', variable, text: CC_RUNNER_WORDS.env(printable(variable, 60)) };
  // Asked with the same environment the job's run gets, never the runner's own.
  const facts = programFacts(claudeBinOf(env), cache, childEnvOf(env));
  if (!facts.found) return { ok: false, why: 'no_claude', text: CC_RUNNER_WORDS.noClaude };
  if (!facts.version || compareVersions(facts.version, MIN_ENFORCED_VERSION) < 0 || !facts.prompts) {
    return { ok: false, why: 'too_old', text: CC_RUNNER_WORDS.tooOld(MIN_ENFORCED_VERSION) };
  }
  const install = claudePluginInstall(env);
  if (!install) return { ok: false, why: 'no_plugin', text: CC_RUNNER_WORDS.noPlugin };
  try {
    const hooks = readJson(path.join(install.root, 'hooks', 'hooks.json'));
    const groups = Array.isArray(hooks?.hooks?.PreToolUse) ? hooks.hooks.PreToolUse : [];
    const intact = groups.some((g) => (Array.isArray(g?.hooks) ? g.hooks : []).some((h) => h?.onFailure === 'block' && Array.isArray(h.args) && h.args.includes(CHECK_SCRIPT)));
    if (!intact) return { ok: false, why: 'changed', text: CC_RUNNER_WORDS.changed };
  } catch {
    return { ok: false, why: 'changed', text: CC_RUNNER_WORDS.changed };
  }
  // The person's settings turn the plugin on; no file Claude Code reads for this folder turns it off.
  const userFile = path.join(claudeConfigDir(env), 'settings.json');
  let user = null;
  try {
    user = readJson(userFile);
  } catch {
    user = null;
  }
  if (user?.enabledPlugins?.[install.id] !== true) return { ok: false, why: 'plugin_off', text: CC_RUNNER_WORDS.pluginOff };
  const home = env.HOME || '/';
  for (const { file } of settingsFiles({ env, projectDir: dir, home, ...(managed ? { managed } : {}) })) {
    let raw;
    try {
      raw = fs.readFileSync(file, 'utf8');
    } catch (e) {
      if (e && (e.code === 'ENOENT' || e.code === 'ENOTDIR')) continue;
      return { ok: false, why: 'unreadable', file, text: CC_RUNNER_WORDS.unreadable(printable(file)) };
    }
    let json;
    try {
      json = JSON.parse(raw);
    } catch {
      return { ok: false, why: 'unreadable', file, text: CC_RUNNER_WORDS.unreadable(printable(file)) };
    }
    if (turnsSaysoOff(json)) return { ok: false, why: 'turned_off', file, text: CC_RUNNER_WORDS.turnedOff(printable(file)) };
  }
  // The key /aimiru:connect saved, in the data folder the plugin's hooks use.
  const settings = pluginSettings(env);
  const pluginData = path.join(claudeConfigDir(env), 'plugins', 'data') + path.sep;
  if (!settings.token || !settings.baseUrl || settings.keySource !== 'file' || !path.resolve(settings.dataDir).startsWith(pluginData)) {
    return { ok: false, why: 'no_key', text: CC_RUNNER_WORDS.noKey };
  }
  return { ok: true };
}

/** A file Claude Code changed, as the person knows it: relative to the job's folder when inside it. */
function shownFile(p, dir) {
  const f = String(p ?? '');
  if (dir && path.isAbsolute(f)) {
    const rel = path.relative(dir, f);
    if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) return rel;
  }
  return path.basename(f);
}

/** Untrusted words cut to max: keys, cards, email addresses and phone numbers taken out first, so none is left half there. */
function cutClean(text, max) {
  return truncate(redactContacts(redactSecrets(String(text))), max);
}

/**
 * The note one stream-json event makes, or null: what Claude Code is doing, from the step it takes
 * (never its output, a file's contents or its reasoning). dir: the job's folder.
 */
export function noteForEvent(ev, { dir = null } = {}) {
  if (!ev || typeof ev !== 'object' || ev.type !== 'assistant') return null;
  const content = Array.isArray(ev.message?.content) ? ev.message.content : [];
  const use = content.find((c) => c?.type === 'tool_use');
  if (!use) return null;
  const input = use.input && typeof use.input === 'object' ? use.input : {};
  switch (use.name) {
    case 'Bash':
      return input.command ? noteLine(`Running ${cutClean(input.command, 100)}`) : null;
    case 'Edit':
    case 'MultiEdit':
    case 'Write':
    case 'NotebookEdit': {
      const f = input.file_path ?? input.notebook_path;
      return f ? noteLine(`Changing ${shownFile(f, dir)}`) : null;
    }
    case 'WebSearch':
      return noteLine(input.query ? `Searching the web for ${cutClean(input.query, 80)}` : 'Searching the web');
    case 'WebFetch': {
      let host = '';
      try {
        host = new URL(String(input.url)).host;
      } catch {
        host = '';
      }
      return noteLine(host ? `Reading a page on ${host}` : 'Reading a web page');
    }
    case 'Task':
    case 'Agent':
      return noteLine('Working on part of the job');
    default:
      return null;
  }
}

/**
 * Runs one job with `claude -p` and records its end. Resolves to {outcome, result, recorded, stopped}.
 * @param {object} o
 */
export async function runJob({ task, dir, env, settings, client, print, spawn = spawnChild, stop = null, limitMs = RUN_LIMIT_MS, sessionId = randomUUID() }) {
  // The plugin Claude Code must say it loaded (pluginLoaded). None installed: nothing is started.
  const install = claudePluginInstall(env);
  // Each check in this session names the job (ADR-0157): the record Claude Code's check reads.
  const store = stateStore(settings.dataDir, { secret: settings.token });
  if (install) store.putSessionTask(sessionId, task.id);
  const notes = createNotes({
    print: (line) => print(line),
    // A note is never kept for later: one sent late tells the person nothing.
    send: (summary) => client.record({ action_id: null, outcome: 'partial', task_id: task.id, summary }, { spoolOnFailure: false, timeoutMs: 3_000 }),
  });
  // Only what Claude Code needs, with the job's id (childEnvOf): nothing in the runner's environment
  // can turn the check off, load code into it or name another program, key or address.
  const childEnv = childEnvOf(env, task.id);
  let final = null;
  let stopped = false;
  let tooLong = false;
  // checked: Claude Code's init listed Aimiru's plugin. unchecked: it did not, or a step came first.
  let checked = false;
  let unchecked = !install;
  let child = null;
  if (install) {
    try {
      child = spawn(claudeBinOf(env), claudeArgs({ sessionId }), { cwd: dir, env: childEnv, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch {
      child = null;
    }
  }
  const refuse = () => {
    if (unchecked) return;
    unchecked = true;
    try {
      // At once, with no time to take a step.
      child?.kill('SIGKILL');
    } catch {
      // already gone
    }
  };
  const ended = new Promise((resolve) => {
    if (!child) {
      resolve({ code: null, error: Boolean(install) });
      return;
    }
    child.on('error', () => resolve({ code: null, error: true }));
    child.on('close', (code) => resolve({ code, error: false }));
  });
  if (child) {
    child.stdin.on('error', () => {});
    child.stdin.end(jobPrompt(task));
    child.stderr.on('data', () => {});
    const lines = readline.createInterface({ input: child.stdout });
    lines.on('line', (line) => {
      if (unchecked) return;
      let ev;
      try {
        ev = JSON.parse(line);
      } catch {
        return;
      }
      if (!checked) {
        // Proof before the first step: the init event names Aimiru's plugin where it is installed.
        if (ev?.type === 'system' && ev.subtype === 'init') {
          if (pluginLoaded(ev, install)) checked = true;
          else refuse();
          return;
        }
        // Anything but Claude Code's own start-up events before init: a step, a turn or an end.
        if (ev?.type !== 'system') refuse();
        return;
      }
      if (ev?.type === 'result') final = ev;
      const note = noteForEvent(ev, { dir });
      if (note) notes.note(note);
    });
  }
  const onStop = () => {
    stopped = true;
    try {
      child?.kill('SIGINT');
    } catch {
      // already gone
    }
  };
  if (stop) {
    if (stop.aborted) onStop();
    else stop.addEventListener('abort', onStop, { once: true });
  }
  const limit = setTimeout(() => {
    tooLong = true;
    try {
      child?.kill('SIGTERM');
    } catch {
      // already gone
    }
    setTimeout(() => {
      try {
        child?.kill('SIGKILL');
      } catch {
        // already gone
      }
    }, 10_000).unref();
  }, limitMs);
  const end = await ended;
  clearTimeout(limit);
  stop?.removeEventListener?.('abort', onStop);
  await notes.close();

  const said = typeof final?.result === 'string' ? final.result.trim() : '';
  const denied = Array.isArray(final?.permission_denials) ? final.permission_denials.length : 0;
  const finished = checked && !unchecked && !end.error && end.code === 0 && final !== null && final.is_error !== true && !stopped && !tooLong;
  let result;
  if (finished) result = said || 'Claude Code finished without a summary.';
  else if (unchecked) result = CC_RUNNER_WORDS.notLoaded;
  else if (tooLong) result = `Claude Code was still working after ${Math.round(limitMs / 60_000)} minutes, so the run was stopped.`;
  else if (stopped) result = 'The person stopped Claude Code before it finished.';
  else if (end.error) result = 'Claude Code could not start.';
  else result = said ? `Claude Code ended before it finished.\n\n${said}` : 'Claude Code ended before it finished.';
  if (denied > 0 && !unchecked) {
    result += `\n\nClaude Code was not allowed ${denied === 1 ? 'one step' : `${denied} steps`} here, since nobody was there to say yes. Your Claude Code settings decide what it may do on its own.`;
  }
  // Keys and cards out, then email addresses and phone numbers (legal, 30 Oct, item 7), before it is sent or kept to send.
  result = truncate(redactContacts(redactSecrets(result)), RESULT_MAX);
  const firstLine = noteLine(result.split('\n').find((l) => l.trim()) ?? '');
  const r = await client.record(
    {
      action_id: null,
      outcome: finished ? 'completed' : 'failed',
      task_id: task.id,
      result,
      summary: `${finished ? 'Claude Code finished the job' : 'Claude Code did not finish the job'}: ${firstLine}`,
      // One key per job: a record sent again from the spool never ends the job twice.
      idempotency_key: `cc_run_${sha256Hex(task.id).slice(0, 40)}`,
    },
    { timeoutMs: 10_000 },
  );
  if (install) store.clearSessionTask(sessionId, task.id);
  print(finished ? CC_RUNNER_WORDS.done : CC_RUNNER_WORDS.notDone);
  if (firstLine) print(firstLine);
  return { outcome: finished ? 'completed' : 'failed', result, recorded: r.ok, stopped, checked: checked && !unchecked, sessionId };
}

/**
 * Claude Code for the runner: {connector, label, ready(dir), client, run({task, dir, print, stop, spawn})}.
 * Settings are read again at each look, so a key connected again is used without a restart.
 */
export function runnerAgent({ env = process.env } = {}) {
  const cache = new Map();
  let cached = null;
  const clientFor = (settings) => {
    if (!cached || cached.token !== settings.token || cached.baseUrl !== settings.baseUrl) {
      cached = { token: settings.token, baseUrl: settings.baseUrl, client: makeClient(settings) };
    }
    return cached.client;
  };
  return {
    connector: 'claude-code',
    label: 'Claude Code',
    ready(dir) {
      return readyToRun({ env, dir, cache });
    },
    get client() {
      return clientFor(pluginSettings(env));
    },
    async run({ task, dir, print, stop, spawn }) {
      const settings = pluginSettings(env);
      return runJob({ task, dir, env, settings, client: clientFor(settings), print, stop, ...(spawn ? { spawn } : {}) });
    },
  };
}
