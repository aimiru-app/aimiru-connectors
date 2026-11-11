// Claude Code's take path for the runner (ADR-0161): the runner on this computer asks Aimiru for the
// job the person gave Claude Code and starts `claude -p` on it in the folder the person chose, with
// the person's own settings, so Aimiru's plugin and its check load as in any session.
//
// Never a job unchecked. ready() refuses unless: Claude Code is 2.1.295 or later (a check that fails
// blocks) and knows --permission-prompts; Aimiru's plugin is installed in Claude Code's own plugins
// folder with its PreToolUse entry intact (onFailure block, pre-tool-use.mjs); the person's settings
// turn it on; and no settings file Claude Code reads for that folder (managed, the person's, the
// folder's own up to its git folder) turns it off, turns all checks off or changes how the check runs
// (turnsAimiruOff); and the key is the one /aimiru:connect saved in the plugin's own data folder, so
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
//
// The yes finishes the job (ADR-0172). Nobody is at the keyboard in a job, so a step Aimiru asks the
// person about is refused at the hold and its question kept, as in any session (ADR-0145). When the
// run ends well with questions of its session still open, the job is not ended: the runner records
// the note "Waiting for your answer", keeps {task_id, session_id, dir, exception_ids, expires_at} in a
// file of its own signed with the Aimiru key (waitingStore), and takes other jobs. Each round it reads
// each kept question's state; once every one is answered or ended, at least one is a yes still usable
// here, Aimiru says nothing is paused and the job is still open, it claims the job by a rename and
// goes on with it once (resumeJob): `claude -p --resume <that session>` with the same flags
// (resumeArgs, the one use of --resume), in the same folder, the plugin-loaded proof again before the
// first step, and a prompt of Aimiru's own descriptions of the steps from this session's kept
// questions and the person's answers (resumePrompt). The same call then meets the same kept question,
// so a yes lets exactly that call through once; a changed call is asked about again and refused at the
// hold. The job then ends as any job does, never going on a second time. No yes, a closed job, or a
// job past its time (WAIT_GRACE_MS after its last question ends) ends without going on.

import { spawn as spawnChild, spawnSync } from 'node:child_process';
import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { jobPrompt } from '../vendor/messages.mjs';
import { redactContacts } from '../vendor/contacts.mjs';
import { claudePluginInstall, createNotes, noteLine, printable, runnerHome } from '../vendor/runner.mjs';
import { redactSecrets, sha256Hex, truncate } from '../vendor/aimiru-client.mjs';
import { settingsFiles } from './native-prompt.mjs';
import { HIJACK_ENV_RE, LATE_YES_MS, MIN_ENFORCED_VERSION, claudeConfigDir, compareVersions, findDataDir, loadSettings, makeClient, stateStore, turnsAimiruOff } from './runtime.mjs';

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

/** A session id as the runner makes one for a job (randomUUID): the only kind it ever goes on with. */
const SESSION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** A job's id as Aimiru gives it (the shape get_task takes). */
const TASK_ID_RE = /^[0-9a-fA-F-]{36}$/;
/** A question's id as Aimiru gives it. */
const QUESTION_ID_RE = /^[0-9A-Za-z-]{1,64}$/;
/** At most this many of one job's questions are kept for it. */
export const WAIT_QUESTIONS_MAX = 20;

/**
 * Everything the runner passes to `claude` to go on with a job that waited for the person's answers
 * (ADR-0172): claudeArgs's flags, with --resume and the session the runner made for that job in place
 * of --session-id. The one use of --resume, which NEVER_FLAGS bans everywhere else (test/runner.test.mjs
 * and test/yes-finishes-the-job.test.mjs pin it); anything but a session id of the runner's shape is
 * refused here.
 */
export function resumeArgs({ sessionId }) {
  if (typeof sessionId !== 'string' || !SESSION_ID_RE.test(sessionId)) throw new Error('Only a session the runner made for a job goes on.');
  return ['-p', '--resume', sessionId, '--output-format', 'stream-json', '--verbose', '--permission-prompts', 'none'];
}

/** The flags resumeArgs passes, and only these: CLAUDE_FLAGS with --resume for --session-id. */
export const RESUME_FLAGS = Object.freeze(['-p', '--resume', '--output-format', '--verbose', '--permission-prompts']);

/**
 * Flags that loosen or bypass Claude Code's permissions, change which settings, plugins or servers
 * load, or continue another session: the runner never passes one (test/runner.test.mjs), except
 * --resume in resumeArgs, for a job's own session, once (ADR-0172).
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
  // ADR-0172: a job whose step needs the person's yes waits for the answer, then goes on once.
  waitNote: 'Waiting for your answer',
  waiting: 'Claude Code is waiting for your answer in Aimiru, and goes on with the job once you answer.',
  notResumed: 'Claude Code could not go on with this job after your answer, so it ended without the steps that waited.',
  newSession: 'Claude Code started a new session instead of going on with this one, so the steps that waited did not run.',
  noYes: 'None of the steps this job waited on got your yes in time, so Claude Code did not go on with it, and they did not run.',
  timedOut: 'The questions this job waited on ended before Claude Code could go on with it, so the steps that waited did not run.',
  stoppedGoingOn: 'The runner stopped while Claude Code went on with this job, so Aimiru cannot say whether the steps that waited ran. Their record is under the job.',
  stillWaiting: (n) => (n === 1 ? 'One step still waited for your answer when the job ended, so it did not run.' : `${n} steps still waited for your answer when the job ended, so they did not run.`),
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
  return env.AIMIRU_CLAUDE_BIN || 'claude';
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
    if (turnsAimiruOff(json)) return { ok: false, why: 'turned_off', file, text: CC_RUNNER_WORDS.turnedOff(printable(file)) };
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
 * A run that ends well with questions of its session still open with the person resolves to
 * {outcome: 'waiting'} instead, the job kept open (ADR-0172). With resume ({prompt, known}: only from
 * resumeJob), it goes on with the job's own session (sessionId) once, and always ends the job.
 * @param {object} o
 */
export async function runJob({ task, dir, env, settings, client, print, spawn = spawnChild, stop = null, limitMs = RUN_LIMIT_MS, sessionId = randomUUID(), resume = null }) {
  // The plugin Claude Code must say it loaded (pluginLoaded). None installed: nothing is started.
  const install = claudePluginInstall(env);
  // Each check in this session names the job (ADR-0157): the record Claude Code's check reads. A
  // session that goes on (ADR-0172) keeps the record it was given at its start.
  const store = stateStore(settings.dataDir, { secret: settings.token });
  if (install && !resume) store.putSessionTask(sessionId, task.id);
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
  // A job that was to go on (ADR-0172), started by Claude Code under another session's id instead.
  let otherSession = false;
  let child = null;
  if (install) {
    try {
      child = spawn(claudeBinOf(env), resume ? resumeArgs({ sessionId }) : claudeArgs({ sessionId }), { cwd: dir, env: childEnv, stdio: ['pipe', 'pipe', 'pipe'] });
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
    child.stdin.end(resume ? resume.prompt : jobPrompt(task));
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
        // Proof before the first step: the init event names Aimiru's plugin where it is installed. A
        // job that goes on (ADR-0172) must be its own session, under the id the runner gave it, so
        // its kept questions are the ones its steps meet.
        if (ev?.type === 'system' && ev.subtype === 'init') {
          const loaded = pluginLoaded(ev, install);
          if (loaded && (!resume || ev.session_id === sessionId)) checked = true;
          else {
            otherSession = loaded && Boolean(resume);
            refuse();
          }
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
  // ADR-0172: a run that ended well while questions of its session are still open with the person is
  // not the job's end. The job waits for the answers, and goes on once when they are in (resumeJob).
  // A job that already went on once is never kept waiting again.
  if (finished && !resume && install) {
    const kept = await keepWaiting({ task, sessionId, dir, env, settings, client, store });
    if (kept) {
      print(CC_RUNNER_WORDS.waiting);
      return { outcome: 'waiting', result: null, recorded: kept.noted, stopped: false, checked: true, sessionId };
    }
  }
  let result;
  if (finished) result = said || 'Claude Code finished without a summary.';
  else if (unchecked) result = otherSession ? CC_RUNNER_WORDS.newSession : CC_RUNNER_WORDS.notLoaded;
  else if (tooLong) result = `Claude Code was still working after ${Math.round(limitMs / 60_000)} minutes, so the run was stopped.`;
  else if (stopped) result = 'The person stopped Claude Code before it finished.';
  else if (end.error) result = 'Claude Code could not start.';
  else result = said ? `Claude Code ended before it finished.\n\n${said}` : 'Claude Code ended before it finished.';
  // A step asked about anew on the turn that went on (a changed call): refused at the hold, and the
  // job ends without it, never going on a second time (ADR-0172).
  let left = 0;
  if (resume && install && !unchecked) {
    try {
      left = openQuestions(store, sessionId, { except: resume.known }).length;
    } catch {
      left = 0;
    }
  }
  if (left > 0) result += `\n\n${CC_RUNNER_WORDS.stillWaiting(left)}`;
  else if (denied > 0 && !unchecked) {
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

// ---------------------------------------------------------------------------
// The yes finishes the job (ADR-0172)
// ---------------------------------------------------------------------------

/**
 * How long a job waits at most: until the last of its questions ends (or, with no end known,
 * LATE_YES_MS after it began to wait, when its kept questions leave the plugin's index), and this
 * much longer. Then it ends without the steps that waited, whatever Aimiru could or could not say.
 */
export const WAIT_GRACE_MS = 60 * 60_000;
/**
 * A job claimed to go on longer ago than this was left by a runner that stopped halfway: a run that
 * goes on is stopped at RUN_LIMIT_MS. A younger claim belongs to a runner still going on with it.
 */
export const CLAIM_STALE_MS = RUN_LIMIT_MS + 10 * 60_000;

/** A MAC over a waiting job, keyed by the Aimiru key, as a kept question is (runtime.mjs pendingMac). */
function waitingMac(secret, w) {
  return createHmac('sha256', `aimiru-waiting-job:${secret}`)
    .update(JSON.stringify([w.task_id, w.session_id, w.dir, w.exception_ids, w.expires_at, w.ts, w.resumed]))
    .digest('hex');
}

function macOk(a, b) {
  const x = Buffer.from(String(a ?? ''), 'utf8');
  const y = Buffer.from(String(b ?? ''), 'utf8');
  return x.length === y.length && x.length > 0 && timingSafeEqual(x, y);
}

/** A waiting job in its one shape, or null for anything else. */
function waitShape(v) {
  if (!v || typeof v !== 'object') return null;
  const ids = Array.isArray(v.exception_ids) ? v.exception_ids : null;
  const expires = v.expires_at ?? null;
  if (typeof v.task_id !== 'string' || !TASK_ID_RE.test(v.task_id)) return null;
  if (typeof v.session_id !== 'string' || !SESSION_ID_RE.test(v.session_id)) return null;
  if (typeof v.dir !== 'string' || !path.isAbsolute(v.dir)) return null;
  if (!ids || !ids.length || ids.length > WAIT_QUESTIONS_MAX || new Set(ids).size !== ids.length) return null;
  if (!ids.every((x) => typeof x === 'string' && QUESTION_ID_RE.test(x))) return null;
  if (expires !== null && !(typeof expires === 'string' && Number.isFinite(Date.parse(expires)))) return null;
  if (!Number.isFinite(v.ts)) return null;
  return { task_id: v.task_id, session_id: v.session_id, dir: v.dir, exception_ids: [...ids], expires_at: expires, ts: v.ts, resumed: v.resumed === true };
}

/**
 * The jobs this runner keeps open while their questions wait for the person (ADR-0172), in the
 * runner's own folder (~/.aimiru/runner/waiting, which every connector's check protects by name).
 * Each job is one file written once, `<id>.json`, holding the job's id, the session the runner made
 * for it, the folder it ran in, its questions' ids and when the last of them ends: never a job's words
 * or a step's, which stay with Aimiru and in the plugin's own signed questions. It is signed with the
 * Aimiru key, as a kept question is (putPending), and bound to its name: one changed, copied under
 * another name or written by anything else does not verify, and is removed unread.
 * Going on is claimed by renaming it to `<id>.claimed` (claim): a rename happens once, so of two
 * runners, or two looks, exactly one goes on, and the claimed file says the job already went on.
 * `<id>.noted` says its note reached Aimiru; it changes nothing but whether the note is sent again.
 */
export function waitingStore({ env = process.env, secret = '' } = {}) {
  const dir = path.join(runnerHome(env), 'waiting');
  const nameOf = (taskId) => path.join(dir, sha256Hex(`waiting:${taskId}`).slice(0, 40));
  const fileOf = (taskId) => `${nameOf(taskId)}.json`;
  const claimedOf = (taskId) => `${nameOf(taskId)}.claimed`;
  const notedOf = (taskId) => `${nameOf(taskId)}.noted`;
  const read = (file, claimed) => {
    if (!secret) return null;
    let v = null;
    let at = null;
    try {
      v = JSON.parse(fs.readFileSync(file, 'utf8'));
      at = fs.statSync(file).mtimeMs;
    } catch (e) {
      if (e && e.code === 'ENOENT') return null;
      v = null;
    }
    const w = waitShape(v);
    if (!w || (claimed ? claimedOf(w.task_id) : fileOf(w.task_id)) !== file || !macOk(v.mac, waitingMac(secret, w))) {
      // Refused: nothing goes on from a file Aimiru's key did not sign for this job.
      try {
        fs.rmSync(file, { force: true });
      } catch {
        // looked at again, and refused again, next round
      }
      return null;
    }
    return { ...w, resumed: w.resumed || claimed, claimed, claimedAt: claimed ? at : null, noted: fs.existsSync(notedOf(w.task_id)) };
  };
  return {
    dir,
    /** Keeps a waiting job, signed. Throws when it cannot be kept. */
    put(w) {
      const body = waitShape(w);
      if (!secret || !body) throw new Error('A waiting job is kept only whole and signed.');
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      const file = fileOf(body.task_id);
      const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({ ...body, mac: waitingMac(secret, body) }), { mode: 0o600 });
      fs.renameSync(tmp, file);
      return body;
    },
    /** The waiting job with this id, not yet claimed, when its file is there and verifies; else null. */
    get(taskId) {
      return typeof taskId === 'string' && TASK_ID_RE.test(taskId) ? read(fileOf(taskId), false) : null;
    },
    /** Every job kept here whose file verifies, waiting or claimed, oldest first. */
    list() {
      let names = [];
      try {
        names = fs.readdirSync(dir).filter((n) => n.endsWith('.json') || n.endsWith('.claimed'));
      } catch {
        return [];
      }
      return names
        .map((n) => read(path.join(dir, n), n.endsWith('.claimed')))
        .filter(Boolean)
        .sort((a, b) => a.ts - b.ts);
    },
    /**
     * Claims the job to go on with it: renames its file, which only one caller can do. The claimed
     * job when this caller won and its file verifies; null when another got there first, or for
     * anything else. The claim's time is now.
     */
    claim(taskId) {
      if (!secret || typeof taskId !== 'string' || !TASK_ID_RE.test(taskId)) return null;
      try {
        fs.renameSync(fileOf(taskId), claimedOf(taskId));
        const now = new Date();
        fs.utimesSync(claimedOf(taskId), now, now);
      } catch {
        return null;
      }
      return read(claimedOf(taskId), true);
    },
    /** Its note reached Aimiru. */
    markNoted(taskId) {
      try {
        fs.writeFileSync(notedOf(taskId), String(Date.now()), { mode: 0o600 });
      } catch {
        // sent again next round, under the same key
      }
    },
    remove(taskId) {
      if (typeof taskId !== 'string' || !TASK_ID_RE.test(taskId)) return;
      for (const f of [fileOf(taskId), claimedOf(taskId), notedOf(taskId)]) {
        try {
          fs.rmSync(f, { force: true });
        } catch {
          // looked at again next round
        }
      }
    },
  };
}

/**
 * This session's questions still open on this computer (ADR-0172): the ones its check kept
 * (putPending) for a call of this same session, by their signed call, newest first, at most
 * WAIT_QUESTIONS_MAX, leaving out the ids in `except`: [{exceptionId, expiresAt, description}].
 */
export function openQuestions(store, sessionId, { except = [] } = {}) {
  const out = [];
  const seen = new Set(Array.isArray(except) ? except : []);
  for (const e of store.pendingIndex({ session: sessionId })) {
    if (seen.has(e.exceptionId)) continue;
    const p = store.pendingFor(e.exceptionId);
    if (!p || p.call?.session_id !== String(sessionId) || typeof p.exceptionId !== 'string' || !QUESTION_ID_RE.test(p.exceptionId)) continue;
    seen.add(p.exceptionId);
    out.push({ exceptionId: p.exceptionId, expiresAt: typeof p.expiresAt === 'string' ? p.expiresAt : null, description: typeof p.call.description === 'string' ? p.call.description : null });
    if (out.length >= WAIT_QUESTIONS_MAX) break;
  }
  return out;
}

/** This session's kept question with this id, while it is still open on this computer; else null. */
function keptQuestion(store, id, sessionId) {
  let p = null;
  try {
    p = store.pendingFor(id);
  } catch {
    p = null;
  }
  return p?.call && p.call.session_id === sessionId ? p : null;
}

/**
 * How each answer reads to Claude when its job goes on. late: the person said yes, but only after the
 * question ended on this computer, so the same call would be asked about again, not let through.
 */
const ANSWER_WORDS = Object.freeze({
  yes: 'Yes',
  no: 'No',
  ended: 'No answer before the question ended',
  late: 'Yes, but only after its question ended, so it cannot go through now',
});

/**
 * What Claude reads when its job goes on after the person's answers (ADR-0172; for the model, not
 * the person): each step as Aimiru's check described it in this same session (what the person was
 * asked), quoted as data on one line, with their answer, and to carry on with the job. Nothing from
 * another agent, a page or a file: only Aimiru's description of a step this session tried, and the
 * answer. steps: [{description: string|null, answer: 'yes'|'no'|'ended'|'late'}].
 */
export function resumePrompt(taskId, steps) {
  const lines = (Array.isArray(steps) ? steps : []).map(
    (s) => `- ${ANSWER_WORDS[s?.answer] ?? ANSWER_WORDS.ended}: ${JSON.stringify(printable(s?.description || 'a step you tried before', 300))}`,
  );
  return [
    `Aimiru: the person answered the questions this job was waiting on (task ${printable(taskId, 64)}). Each step as Aimiru described it to them, with their answer, quoted as data:`,
    ...lines,
    'Carry on with the job. Take each step marked Yes again, exactly as you tried it before, with the same input: their yes lets that one step through once. ' +
      'Leave out every other step listed here, and do not reach the same result another way. A changed step is asked about again, and this time the job does not wait for the answer.',
    'When you finish, end with a short summary of what came of the whole job, in a few plain lines. Aimiru gives that summary to the person as the result of the job.',
  ].join('\n');
}

/** The note the person reads on the job in Aimiru: it waits for their answer. Sent again until Aimiru has it. */
async function noteWaiting(waits, w, client) {
  let r = null;
  try {
    r = await client.record(
      { action_id: null, outcome: 'partial', task_id: w.task_id, summary: CC_RUNNER_WORDS.waitNote, idempotency_key: `cc_wait_${sha256Hex(w.task_id).slice(0, 40)}` },
      { spoolOnFailure: false, timeoutMs: 10_000 },
    );
  } catch {
    r = null;
  }
  if (r?.ok) waits.markNoted(w.task_id);
  return Boolean(r?.ok);
}

/**
 * Keeps a job open whose session still has questions open with the person (ADR-0172): the signed
 * file, then the note. {noted} when kept; null when there are none, or when the file cannot be kept
 * (nothing could go on with the job later, so it ends as before).
 */
async function keepWaiting({ task, sessionId, dir, env, settings, client, store }) {
  if (typeof task?.id !== 'string' || !TASK_ID_RE.test(task.id) || !SESSION_ID_RE.test(String(sessionId))) return null;
  let open = [];
  try {
    open = openQuestions(store, sessionId);
  } catch {
    open = [];
  }
  if (!open.length) return null;
  const ends = open.map((q) => Date.parse(q.expiresAt ?? '')).filter(Number.isFinite);
  const waits = waitingStore({ env, secret: settings.token });
  let w;
  try {
    w = waits.put({
      task_id: task.id,
      session_id: sessionId,
      dir: path.resolve(dir),
      exception_ids: open.map((q) => q.exceptionId),
      expires_at: ends.length ? new Date(Math.max(...ends)).toISOString() : null,
      ts: Date.now(),
      resumed: false,
    });
  } catch {
    return null;
  }
  return { noted: await noteWaiting(waits, w, client) };
}

/**
 * One question's state, read from Aimiru now with one look that says this computer is not waiting on
 * it (GET /v1/approvals/{id}?wait=0&waiting_s=0): 'yes', 'no', 'ended', 'paused' (423), or null while
 * it waits or cannot be read. Read by its status: Aimiru sends an ended question with decision deny,
 * which the client's own reading (approvalNow) takes for a no, and the person did not say no.
 */
async function answerOf(client, id) {
  let r = null;
  try {
    r = await client.approvalsWait(id, 0, { timeoutMs: 3_000, waitingS: 0 });
  } catch {
    return null;
  }
  if (r?.ok) {
    const d = r.data || {};
    if (d.status === 'expired') return 'ended';
    if (d.status === 'denied' || (d.status == null && d.decision === 'deny')) return 'no';
    if (d.status === 'allowed' || (d.status == null && d.decision === 'allow')) return 'yes';
    return null;
  }
  if (r?.kind === 'http' && r.fromAimiru !== false) {
    if (r.status === 423) return 'paused';
    // Gone, or no longer this agent's: it ended without an answer this job can use.
    if (r.status === 403 || r.status === 404 || r.status === 410) return 'ended';
  }
  return null;
}

/**
 * Each question's state, in order: ['yes' | 'no' | 'ended', ...] once every one is answered or ended;
 * 'paused' when Aimiru answers that this agent is paused; null while any still waits or cannot be read.
 */
async function answersOf(client, ids) {
  const out = [];
  for (const id of ids) {
    const a = await answerOf(client, id);
    if (a === 'paused') return 'paused';
    if (a === null) return null;
    out.push(a);
  }
  return out;
}

/** A yes whose kept question has ended on this computer cannot let its call through: it reads as late. */
function withLateYes(answers, w, store) {
  return answers.map((a, i) => (a === 'yes' && !keptQuestion(store, w.exception_ids[i], w.session_id) ? 'late' : a));
}

/**
 * True only when Aimiru says now that this agent is not paused. Read every time, never taken from
 * this computer's memory of a Pause: that read is also what clears the memory after a Resume (the
 * runner's own 423s write it, and nothing else in the runner reads the Pause). No answer: false.
 */
async function notPausedNow(client) {
  try {
    const p = await client.pause({ timeoutMs: 5_000 });
    return Boolean(p?.ok) && p.data?.paused === false;
  } catch {
    return false;
  }
}

/**
 * Where the job stands in Aimiru now (GET /v1/tasks/{id}): 'open' only while it is taken and not
 * ended; 'closed' when it ended (completed, failed, cancelled) or Aimiru has no such job of this
 * agent's (404); null for anything else (a 403 for a switch turned off, 423, 429, 5xx, no answer, an
 * older Aimiru that does not say), so nothing goes on and nothing is ended on a guess.
 */
async function jobState(client, taskId) {
  let r = null;
  try {
    r = await client.getTask(taskId, { timeoutMs: 5_000 });
  } catch {
    return null;
  }
  if (r?.ok) {
    const s = r.data?.task?.status;
    if (s === 'taken') return 'open';
    return s === 'completed' || s === 'failed' || s === 'cancelled' ? 'closed' : null;
  }
  if (r?.kind === 'http' && r.fromAimiru !== false && r.status === 404) return 'closed';
  return null;
}

/**
 * Ends a waiting job without going on (ADR-0172): its end recorded with the job's one key (never over
 * a job that already ended in Aimiru), its session's job record cleared, its files removed.
 */
async function endWithout(w, { client, store, waits }, result) {
  if ((await jobState(client, w.task_id)) !== 'closed') {
    try {
      await client.record(
        { action_id: null, outcome: 'failed', task_id: w.task_id, result, summary: `Claude Code did not finish the job: ${result}`, idempotency_key: `cc_run_${sha256Hex(w.task_id).slice(0, 40)}` },
        { timeoutMs: 10_000 },
      );
    } catch {
      // spooled by the client when Aimiru could not take it
    }
  }
  try {
    store.clearSessionTask(w.session_id, w.task_id);
  } catch {
    // the record lapses on its own
  }
  waits.remove(w.task_id);
}

/** When a waiting job stops waiting: the last question's end (or LATE_YES_MS after it began), and WAIT_GRACE_MS. */
function waitLimitOf(w) {
  const end = w.expires_at ? Date.parse(w.expires_at) : w.ts + LATE_YES_MS;
  return end + WAIT_GRACE_MS;
}

/**
 * The first job this runner keeps waiting whose questions have all been answered or ended (ADR-0172),
 * read from Aimiru now: {task_id, answers} or null. Nothing while any answer reads paused, or unless
 * Aimiru says now that this agent is not paused (notPausedNow). A yes whose kept question has ended on
 * this computer reads as late. Ended here without going on: a job past its time (waitLimitOf), and a
 * job claimed to go on by a runner that stopped halfway (CLAIM_STALE_MS), never gone on with again.
 * A note that did not reach Aimiru is sent again.
 */
export async function dueToResume({ env, settings, client }) {
  if (!settings?.token) return null;
  const waits = waitingStore({ env, secret: settings.token });
  const store = stateStore(settings.dataDir, { secret: settings.token });
  const ctx = { client, store, waits };
  for (const w of waits.list()) {
    if (w.claimed) {
      // Another runner (or this one, before it stopped) went on with it: never a second time.
      if (Date.now() - w.claimedAt > CLAIM_STALE_MS) await endWithout(w, ctx, CC_RUNNER_WORDS.stoppedGoingOn);
      continue;
    }
    if (w.resumed) {
      await endWithout(w, ctx, CC_RUNNER_WORDS.stoppedGoingOn);
      continue;
    }
    if (Date.now() > waitLimitOf(w)) {
      await endWithout(w, ctx, CC_RUNNER_WORDS.timedOut);
      continue;
    }
    if (!w.noted) await noteWaiting(waits, w, client);
    const answers = await answersOf(client, w.exception_ids);
    if (answers === 'paused') return null;
    if (!answers) continue;
    if (!(await notPausedNow(client))) return null;
    return { task_id: w.task_id, answers: withLateYes(answers, w, store) };
  }
  return null;
}

/**
 * Goes on with a job that waited for the person's answers, once (ADR-0172): `claude -p --resume` on
 * the session the runner made for that job (resumeArgs: the same flags, nothing else), in the folder
 * it ran in, with resumePrompt. Only for a job in the runner's own signed file, with at least one yes
 * whose kept question is still open here, whose session's signed job record (the one the check reads)
 * names that same job, never while paused, and only while Aimiru says the job is still open (taken).
 * Going on is claimed by a rename (waitingStore.claim), so of two runners or two looks exactly one
 * goes on, and never a second time. started() is called once every check has passed, just before
 * Claude Code starts. The job then ends as any job does (runJob). Resolves like runJob, or to
 * {outcome: 'skipped'} when it does not go on now and still waits.
 */
export async function resumeJob({ due, dir, env, settings, client, print, spawn, stop, limitMs, started = null }) {
  const skipped = { outcome: 'skipped' };
  if (!settings?.token || !due || typeof due.task_id !== 'string') return skipped;
  const waits = waitingStore({ env, secret: settings.token });
  const w = waits.get(due.task_id);
  if (!w) return skipped;
  const given = Array.isArray(due.answers) && due.answers.length === w.exception_ids.length && due.answers.every((a) => Object.hasOwn(ANSWER_WORDS, a)) ? due.answers : null;
  if (!given || !claudePluginInstall(env)) return skipped;
  const store = stateStore(settings.dataDir, { secret: settings.token });
  const ctx = { client, store, waits };
  const ended = async (words) => {
    await endWithout(w, ctx, words);
    print(CC_RUNNER_WORDS.notDone);
    return { outcome: 'failed', result: words, stopped: false, checked: false, sessionId: w.session_id };
  };
  if (w.resumed) return ended(CC_RUNNER_WORDS.stoppedGoingOn);
  // Only the session whose own record names this job, in the folder it ran in.
  if (w.dir !== path.resolve(dir) || store.sessionTask(w.session_id) !== w.task_id) return ended(CC_RUNNER_WORDS.notResumed);
  // Read again here: a yes is used only while its kept question is still open on this computer.
  const answers = withLateYes(given, w, store);
  // Nothing the person allowed: nothing to go on with, and nothing runs unattended.
  if (!answers.includes('yes')) return ended(CC_RUNNER_WORDS.noYes);
  // While paused, nothing goes on.
  if (!(await notPausedNow(client))) return skipped;
  // Only a job still open in Aimiru: one the person closed meanwhile, or that already ended, never.
  const state = await jobState(client, w.task_id);
  if (state === 'closed') return ended(CC_RUNNER_WORDS.notResumed);
  if (state !== 'open') return skipped;
  const claimed = waits.claim(w.task_id);
  if (!claimed) return skipped;
  // Aimiru's own description of each step, from this session's signed questions on this computer.
  const steps = claimed.exception_ids.map((id, i) => ({ description: keptQuestion(store, id, claimed.session_id)?.call?.description ?? null, answer: answers[i] }));
  try {
    started?.();
  } catch {
    // only words on the computer
  }
  const run = await runJob({
    task: { id: claimed.task_id },
    dir,
    env,
    settings,
    client,
    print,
    spawn,
    stop,
    limitMs,
    sessionId: claimed.session_id,
    resume: { prompt: resumePrompt(claimed.task_id, steps), known: claimed.exception_ids },
  });
  waits.remove(claimed.task_id);
  return run;
}

/**
 * Claude Code for the runner: {connector, label, ready(dir), client, run({task, dir, print, stop,
 * spawn}), nextResume(), resume({due, dir, print, stop, spawn, started})}. Settings are read again at each
 * look, so a key connected again is used without a restart.
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
    /** A job that waited for the person's answers and may go on now (ADR-0172), or null. */
    async nextResume() {
      const settings = pluginSettings(env);
      if (!settings.token || !settings.baseUrl) return null;
      return dueToResume({ env, settings, client: clientFor(settings) });
    },
    /** Goes on with that job once (ADR-0172); started() once every check has passed. */
    async resume({ due, dir, print, stop, spawn, started }) {
      const settings = pluginSettings(env);
      return resumeJob({ due, dir, env, settings, client: clientFor(settings), print, stop, started, ...(spawn ? { spawn } : {}) });
    },
  };
}
