// The runner (ADR-0161; D1 in design_draft.md, Rohit 29 Oct 20:40 IST): the person gives a job in
// Aimiru, from the web or the phone, and the agent starts on their computer within seconds, with no
// session open. One runner on the computer, installed once, for every agent whose connector carries a
// take path of its own (Claude Code's `claude -p`, Codex's `codex exec`).
//
// What it may do, and nothing more:
// - Ask Aimiru's door for the person's job, with each agent's own key (POST /v1/tasks/take). The door
//   gives only the person's own job, only while that agent's take switch is on, never while paused
//   (423), and never while the person turned this runner off in Aimiru (why runner_off). The runner
//   checks again that it is the person's own job (personsOwnJob) or hands it straight back unread.
// - Start that agent in the one folder the person chose at `runner on`, with the person's own
//   settings and Aimiru's check loaded (each connector's own readiness test and flags).
// - Keep the computer awake only while a job runs and only on power (caffeinate -s -w <job>).
// - Tell Aimiru it is on (a random id made on this computer and a kind of computer, never the
//   computer's name unless the person set one), send short notes and the redacted result.
// - Write down on the computer how it stands (runner.log, status.json), never a job's words or the
//   text of a command the agent ran: those reach Aimiru only, with the job.
//
// Started by a person, never by an agent: `on`, `off` and `run` refuse inside one, `on` needs a
// terminal, and `run` needs a terminal or launchd's own label. Ctrl+C, `runner off` and the off
// switch in Aimiru stop it.

import { spawn as spawnChild, spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { notPersonsJob } from './messages.mjs';
import { redactContacts } from './contacts.mjs';
import { personsOwnJob, redactSecrets, setting, sha256Hex, taskIdOf, truncate } from './aimiru-client.mjs';

/** The LaunchAgent's label, and the name launchd gives the runner it starts (XPC_SERVICE_NAME). */
export const LABEL = 'app.aimiru.runner';
/** How often each agent looks for a job: a send starts within POLL_MS + JITTER_MS plus the agent's own start. */
export const POLL_MS = 5_000;
export const JITTER_MS = 500;
/** While the person turned the runner off in Aimiru: it looks less often, and starts nothing. */
export const OFF_POLL_MS = 15_000;
/** An agent that cannot start yet (its check not ready, jobs not open): looked at again after this. */
export const NOT_READY_MS = 60_000;
/** Aimiru not answering: the wait doubles from POLL_MS up to this. */
export const BACKOFF_MAX_MS = 30_000;
/** While a job runs, the runner tells Aimiru it is still on this often (busy: no second job). */
export const BUSY_PING_MS = 20_000;
/** A key Aimiru refused: looked at again after this, in case the person connected again. */
export const RECONNECT_WAIT_MS = 5 * 60_000;
/** Each take, and the last word when the runner stops. */
export const TAKE_TIMEOUT_MS = 10_000;
export const LEAVE_TIMEOUT_MS = 3_000;
/** How long a readiness answer is kept between jobs (each job's start asks again). */
export const READY_KEEP_MS = 60_000;
/** The runner's log is cut back when it passes this at a start. */
export const LOG_MAX_BYTES = 1024 * 1024;

/** The kinds of computer a runner names itself by, when the person set no name of their own. */
export const DEVICE_KINDS = Object.freeze(['MacBook', 'Mac', 'PC']);

// ---------------------------------------------------------------------------
// Words on the computer (docs/04: plain, no dashes, none of the words the person never reads)
// ---------------------------------------------------------------------------

export const RUNNER_WORDS = Object.freeze({
  on: (device, dir) => `Runner on, ${device}. It starts the jobs you give your agents in Aimiru, in ${dir}.`,
  onAgents: (labels) => (labels.length ? `It can start ${labels.join(' and ')} now.` : 'It cannot start an agent yet. Each one says why below.'),
  offHow: (line) => `Turn it off any time in Aimiru, or here with: ${line}`,
  stays: 'It stays on after a restart, and it keeps the computer awake only while a job runs and only on power.',
  noLaunchAgent: (line) => `This computer has no way to keep it on after a restart. Keep it running in a terminal with: ${line}`,
  off: 'Runner off. Nothing starts on this computer until you turn it on again.',
  offNothing: 'The runner was not on.',
  insideAgent: 'Start the runner yourself, in a terminal of your own. It does not start from inside an agent.',
  notPerson: 'Start the runner yourself, in a terminal of your own.',
  noConfig: (line) => `The runner is not set up on this computer. Turn it on with: ${line}`,
  homeFolder: (dir) => `Pick a project folder, not ${dir}. Jobs run in the folder you choose.`,
  noFolder: (dir) => `There is no folder at ${dir}.`,
  notGit: 'Pick a folder that is in git. Jobs run only in a project folder.',
  started: (device, dir) => `Runner on, ${device}, in ${dir}. Waiting for the jobs you give your agents in Aimiru.`,
  noAgents: 'No agent here can take a job yet. Set up Claude Code or Codex with Aimiru first.',
  ready: (label) => `${label} is ready to take your jobs.`,
  notReady: (label, why) => `${label} cannot take a job yet. ${why}`,
  paused: 'Paused in Aimiru. Nothing starts until you resume.',
  turnedOff: 'Turned off in Aimiru. Nothing starts until you turn it on there.',
  switchOff: (label) => `${label} does not take work yet. Your first job to it in Aimiru turns that on.`,
  notOpen: (label) => `Aimiru does not give ${label} jobs yet. Give it a job on Today first.`,
  tooOld: (label) => `Aimiru gives ${label} jobs only from a newer connector. Update it, then turn the runner on again.`,
  reconnect: (label) => `${label}'s key no longer works with Aimiru. Connect it again.`,
  unreachable: 'Aimiru could not be reached. Trying again.',
  taken: (label, words) => `${label} took a job: ${words}`,
  // What the runner writes down on the computer (its log and status file): never the job's words.
  tookJob: (label) => `${label} took a job you gave it in Aimiru. Aimiru shows its words and each step.`,
  jobEnded: (label, outcome) => (outcome === 'completed' ? `${label} finished the job.` : `${label} did not finish the job. Aimiru says why, with the job.`),
  notYours: (label) => `${label} was offered work you did not give it, and handed it back unrun.`,
  cannotStart: (label, why) => `${label} took a job but cannot start it. ${why}`,
  stopping: 'Stopping. A job that is running is stopped and recorded.',
  stopped: 'Runner stopped.',
  differs: (label) => `Aimiru for ${label} on this computer is another version than this one. Update it, then turn the runner on again.`,
  copyChanged: (line) => `The runner's copy of Aimiru no longer matches the one installed on this computer, so it starts nothing. Turn it on again with: ${line}`,
  status: {
    installed: (on) => (on ? 'Stays on after a restart: yes.' : 'Stays on after a restart: no.'),
    running: (pid) => (pid ? `Running now: yes (process ${pid}).` : 'Running now: no.'),
    device: (device) => `This computer shows in Aimiru as: ${device}.`,
    folder: (dir) => `Jobs run in: ${dir}.`,
    last: (label, text) => `${label}: ${text}`,
  },
});

/** The result recorded when a job was taken but the agent could not start it here. */
export function cannotStartResult(label, why) {
  return truncate(`${label} could not start this job on the computer. ${why}`, 1_000);
}

// ---------------------------------------------------------------------------
// Where things live
// ---------------------------------------------------------------------------

function homeOf(env) {
  return path.resolve(env?.HOME || os.homedir());
}

/**
 * The runner's own folder: its id, settings, copy of the program, log and state. Under Aimiru's own
 * folder (~/.aimiru), which every connector's check of this release protects by name, and by its shape
 * (<home>/.<word>/runner) and by where the LaunchAgent starts it (classify.mjs isProtectedPath,
 * liveCopyFolders): launchd starts the copy at every login with the agents' keys, so an agent may not
 * change, replace or point it elsewhere without an ask, and the change is held when Aimiru cannot be
 * asked (security review of wk/runner). A check of 0.3.0-rc.2 or older protects only the folder of
 * its own time, not this one (ADR-0164): every connector on a computer moves in one sitting, and
 * earlierInstalls names one that has not.
 */
export function runnerHome(env = process.env) {
  return path.join(homeOf(env), '.aimiru', 'runner');
}

export function launchAgentFile(env = process.env) {
  return path.join(homeOf(env), 'Library', 'LaunchAgents', `${LABEL}.plist`);
}

const files = (env) => {
  const home = runnerHome(env);
  return {
    home,
    id: path.join(home, 'id'),
    config: path.join(home, 'config.json'),
    app: path.join(home, 'app'),
    log: path.join(home, 'runner.log'),
    pid: path.join(home, 'runner.pid'),
    status: path.join(home, 'status.json'),
  };
};

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, file);
}

/**
 * This runner's id: 32 random hex characters made once on this computer and kept in its folder. It
 * names nothing about the computer or the person; Aimiru keeps the runner's presence under it.
 */
export function runnerIdOf(env = process.env, { random = randomBytes } = {}) {
  const f = files(env).id;
  try {
    const id = fs.readFileSync(f, 'utf8').trim();
    if (/^[0-9a-f]{32}$/.test(id)) return id;
  } catch {
    // made below
  }
  const id = random(16).toString('hex');
  fs.mkdirSync(path.dirname(f), { recursive: true, mode: 0o700 });
  fs.writeFileSync(f, `${id}\n`, { mode: 0o600 });
  return id;
}

export function readConfig(env = process.env) {
  const c = readJson(files(env).config);
  return c && typeof c === 'object' && typeof c.dir === 'string' ? c : null;
}

// ---------------------------------------------------------------------------
// What the runner says about the computer
// ---------------------------------------------------------------------------

/**
 * A name the person gave this computer (`runner on --name`), as Aimiru shows it: letters, digits,
 * spaces and . ' - only, at most 40 characters; null for anything else.
 */
export function cleanName(name) {
  if (typeof name !== 'string') return null;
  const n = name.replace(/\s+/g, ' ').trim();
  if (!n || n.length > 40 || !/^[\p{L}\p{N} .'-]+$/u.test(n)) return null;
  return n;
}

/**
 * The kind of computer this is, for Aimiru: "MacBook" for a Mac with a battery (or a model that says
 * so), "Mac" for any other Mac, "PC" elsewhere. Never the computer's own name.
 * @param {object} [o] @param {string} [o.platform] @param {(cmd: string, args: string[]) => string} [o.run]
 */
export function deviceKind({ platform = process.platform, run = runText } = {}) {
  if (platform !== 'darwin') return 'PC';
  const model = run('/usr/sbin/sysctl', ['-n', 'hw.model']);
  if (/^MacBook/i.test(model)) return 'MacBook';
  const battery = run('/usr/bin/pmset', ['-g', 'batt']);
  if (/InternalBattery/i.test(battery)) return 'MacBook';
  return 'Mac';
}

function runText(cmd, args) {
  try {
    const r = spawnSync(cmd, args, { encoding: 'utf8', timeout: 3_000, stdio: ['ignore', 'pipe', 'ignore'] });
    return r.error ? '' : String(r.stdout || '');
  } catch {
    return '';
  }
}

/** True inside an agent's own session (Claude Code, Codex): the runner never starts from there. */
export function insideAgent(env = process.env) {
  return Boolean(env.CLAUDECODE || env.CODEX_THREAD_ID || env.CLAUDE_CODE_ENTRYPOINT);
}

/** The git folder holding dir, or null. */
export function gitRootOf(dir) {
  let d = path.resolve(dir);
  for (let i = 0; i < 60; i += 1) {
    try {
      if (fs.existsSync(path.join(d, '.git'))) return d;
    } catch {
      return null;
    }
    const up = path.dirname(d);
    if (up === d) return null;
    d = up;
  }
  return null;
}

/**
 * Whether jobs may run in dir: it exists, it is in git, and it is not the home folder or above it.
 * {ok: true, dir} or {ok: false, why: 'home' | 'missing' | 'not_git', dir}.
 */
export function checkFolder(dir, env = process.env) {
  const d = path.resolve(String(dir ?? ''));
  const home = homeOf(env);
  if (d === home || home.startsWith(d.endsWith(path.sep) ? d : d + path.sep)) return { ok: false, why: 'home', dir: d };
  let isDir = false;
  try {
    isDir = fs.statSync(d).isDirectory();
  } catch {
    isDir = false;
  }
  if (!isDir) return { ok: false, why: 'missing', dir: d };
  if (!gitRootOf(d)) return { ok: false, why: 'not_git', dir: d };
  return { ok: true, dir: d };
}

function folderWords(r) {
  if (r.why === 'home') return RUNNER_WORDS.homeFolder(r.dir);
  if (r.why === 'missing') return RUNNER_WORDS.noFolder(r.dir);
  return RUNNER_WORDS.notGit;
}

/** Text from outside (a job's words, an agent's) as a terminal shows it: one line, nothing that moves the cursor. */
export function printable(text, max = 200) {
  return truncate(
    String(text ?? '')
      // eslint-disable-next-line no-control-regex
      .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029\p{Cf}]+/gu, ' ')
      .replace(/\s+/g, ' ')
      .trim(),
    max,
  );
}

// ---------------------------------------------------------------------------
// Short notes while a job runs (the same rule as Codex's, ADR-0157)
// ---------------------------------------------------------------------------

export const NOTE_GAP_MS = 3_000;
export const NOTE_MAX = 120;
export const NOTE_CHARS = 160;

/**
 * One note: one line, secrets taken out, then email addresses and phone numbers (contacts.mjs; legal,
 * 30 Oct, item 7), at most NOTE_CHARS characters, cut only after both.
 */
export function noteLine(text) {
  return truncate(redactContacts(printable(redactSecrets(String(text ?? '')), Infinity)), NOTE_CHARS);
}

/**
 * The notes of one run: note(line) shows and sends a line now, or keeps the latest until NOTE_GAP_MS
 * after the last; close() drops a line still kept and waits for the sends. At most NOTE_MAX a run.
 */
export function createNotes({ send, print, gapMs = NOTE_GAP_MS, max = NOTE_MAX, now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  let last = -Infinity;
  let pending = null;
  let timer = null;
  let sent = 0;
  const inflight = new Set();
  const emit = (line) => {
    if (sent >= max) return;
    sent += 1;
    last = now();
    try {
      print(line);
    } catch {
      // the terminal went away; the note still goes to Aimiru
    }
    const p = Promise.resolve()
      .then(() => send(line))
      .catch(() => null);
    inflight.add(p);
    p.finally(() => inflight.delete(p));
  };
  return {
    note(line) {
      if (typeof line !== 'string' || !line || sent >= max) return;
      const wait = last + gapMs - now();
      if (wait <= 0 && !timer) {
        emit(line);
        return;
      }
      pending = line;
      if (!timer) {
        timer = setTimer(() => {
          timer = null;
          const l = pending;
          pending = null;
          if (l) emit(l);
        }, Math.max(0, wait));
      }
    },
    async close() {
      if (timer) clearTimer(timer);
      timer = null;
      pending = null;
      await Promise.all([...inflight]);
    },
    get sent() {
      return sent;
    },
  };
}

// ---------------------------------------------------------------------------
// Keep-awake: only while a job runs, only on power
// ---------------------------------------------------------------------------

/**
 * Holds the computer awake while the process pid runs, on a Mac on AC power only: `caffeinate -s`
 * holds only on AC power, and `-w pid` ends with the job. release() ends it at once. Nothing elsewhere.
 */
export function keepAwake(pid, { platform = process.platform, spawn = spawnChild } = {}) {
  if (platform !== 'darwin' || !Number.isInteger(pid) || pid <= 0) return { held: false, release() {} };
  let child = null;
  try {
    child = spawn('/usr/bin/caffeinate', ['-s', '-w', String(pid)], { stdio: 'ignore' });
    child.on?.('error', () => {});
    child.unref?.();
  } catch {
    child = null;
  }
  return {
    held: child !== null,
    release() {
      try {
        child?.kill('SIGTERM');
      } catch {
        // already gone with the job
      }
      child = null;
    },
  };
}

/** A spawn that holds keep-awake for each child it starts, until that child ends. */
export function spawnKeepingAwake({ spawn = spawnChild, awake = keepAwake } = {}) {
  return (bin, args, opts) => {
    const child = spawn(bin, args, opts);
    const hold = awake(child?.pid);
    child?.on?.('close', () => hold.release());
    child?.on?.('error', () => hold.release());
    return child;
  };
}

// ---------------------------------------------------------------------------
// The loop
// ---------------------------------------------------------------------------

/** Resolves after ms, or as soon as stop fires. */
export function waitFor(ms, stop, sleep) {
  if (sleep) return sleep(ms, stop);
  if (!stop) return new Promise((r) => setTimeout(r, Math.max(0, ms)));
  if (stop.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const t = setTimeout(done, Math.max(0, ms));
    function done() {
      clearTimeout(t);
      stop.removeEventListener('abort', done);
      resolve();
    }
    stop.addEventListener('abort', done, { once: true });
  });
}

/**
 * The runner: one loop per agent, each looking for that agent's job every POLL_MS, at most one job
 * at a time per agent. Each agent is a connector's own take path (scripts/lib/runner-agent.mjs):
 *   {connector, label, ready(dir) -> {ok, text?}, client -> {takeTask, record}, run({task, dir, print, stop, spawn})}
 * @param {object} o
 * @param {object[]} o.agents @param {string} o.dir @param {string} o.runnerId @param {string} o.device
 * @param {(line: string) => void} [o.print] @param {AbortSignal} [o.stop]
 * @param {() => number} [o.now] @param {(ms: number, stop?: AbortSignal) => Promise<void>} [o.sleep]
 * @param {() => number} [o.random] @param {Function} [o.spawn] the job's spawn (keep-awake wraps it)
 * @param {(state: object) => void} [o.onState] each agent's state as it changes (status.json)
 * @param {boolean} [o.toLog] print goes to the runner's log on the computer (launchd's runner): a
 *   job's words and everything the agent's run prints (its notes, which name commands and files, and
 *   its result) stay out of it; Aimiru has them, with the job. The status file never holds them.
 */
export function createRunner(o) {
  const print = o.print || ((s) => process.stdout.write(`${s}\n`));
  const toLog = o.toLog === true;
  const now = o.now || Date.now;
  const random = o.random || Math.random;
  const stop = o.stop || new AbortController().signal;
  const runner = { id: o.runnerId, device: o.device };
  const spawn = o.spawn || spawnKeepingAwake();
  const states = {};
  // Whether Aimiru's door has answered with this runner (it knows runners): only then does the
  // runner send busy and leaving, which an older door would read as a plain take.
  const knows = new Set();
  const noteDoor = (agent, data) => {
    if (data?.runner && typeof data.runner === 'object' && data.runner.id === runner.id) knows.add(agent.connector);
  };
  const setState = (agent, state, text) => {
    states[agent.connector] = { label: agent.label, state, text, at: new Date(now()).toISOString() };
    try {
      o.onState?.({ ...states });
    } catch {
      // the status file is a convenience
    }
  };

  async function loop(agent) {
    let said = null;
    const say = (kind, text) => {
      if (said === kind) return;
      said = kind;
      print(text);
      setState(agent, kind, text);
    };
    let readyAt = -Infinity;
    let ready = null;
    let backoff = POLL_MS;
    const checkReady = () => {
      try {
        ready = agent.ready(o.dir) || { ok: false, text: '' };
      } catch {
        ready = { ok: false, text: '' };
      }
      readyAt = now();
      return ready;
    };
    while (!stop.aborted) {
      if (!ready || now() - readyAt >= READY_KEEP_MS) checkReady();
      if (!ready.ok) {
        say(`not_ready:${ready.why ?? ''}`, RUNNER_WORDS.notReady(agent.label, ready.text || ''));
        await waitFor(NOT_READY_MS, stop, o.sleep);
        ready = null;
        continue;
      }
      const client = agent.client;
      const taken = await client.takeTask({ timeoutMs: TAKE_TIMEOUT_MS, withBudget: false, runner });
      if (stop.aborted) break;
      const pace = POLL_MS + Math.floor(random() * JITTER_MS);
      if (!taken.ok) {
        const fromAimiru = taken.kind === 'http' && taken.fromAimiru !== false;
        if (fromAimiru && taken.status === 423) {
          backoff = POLL_MS;
          say('paused', RUNNER_WORDS.paused);
          await waitFor(pace, stop, o.sleep);
          continue;
        }
        if (fromAimiru && taken.status === 401) {
          // Said once; looked at again later, with the key the person may have connected since.
          say('reconnect', taken.code === 'demo_ended' && taken.data?.error?.message ? printable(taken.data.error.message) : RUNNER_WORDS.reconnect(agent.label));
          knows.delete(agent.connector);
          await waitFor(RECONNECT_WAIT_MS, stop, o.sleep);
          ready = null;
          continue;
        }
        if (fromAimiru && (taken.status === 403 || taken.status === 404)) {
          say('not_open', RUNNER_WORDS.notOpen(agent.label));
          await waitFor(NOT_READY_MS, stop, o.sleep);
          continue;
        }
        say('unreachable', RUNNER_WORDS.unreachable);
        await waitFor(backoff, stop, o.sleep);
        backoff = Math.min(BACKOFF_MAX_MS, backoff * 2);
        continue;
      }
      backoff = POLL_MS;
      const data = taken.data && typeof taken.data === 'object' ? taken.data : {};
      noteDoor(agent, data);
      const task = data.task && typeof data.task === 'object' ? data.task : null;
      if (!task) {
        if (data.why === 'runner_off' || data.runner?.off === true) {
          say('turned_off', RUNNER_WORDS.turnedOff);
          await waitFor(OFF_POLL_MS, stop, o.sleep);
          continue;
        }
        if (data.why === 'off') say('switch_off', RUNNER_WORDS.switchOff(agent.label));
        else if (data.why === 'connector' || data.why === 'version') {
          say('too_old', RUNNER_WORDS.tooOld(agent.label));
          await waitFor(NOT_READY_MS, stop, o.sleep);
          continue;
        } else say('waiting', RUNNER_WORDS.ready(agent.label));
        await waitFor(pace, stop, o.sleep);
        continue;
      }
      said = null;
      await runOne(agent, task);
      ready = null;
    }
  }

  async function runOne(agent, task) {
    const key = `rn_take_${sha256Hex(`${agent.connector}:${task.id}`).slice(0, 40)}`;
    // Only the person's own job, whole, runs here; anything else goes back unrun, its words never
    // given to the agent (ADR-0157, beside Aimiru's own filter).
    if (!personsOwnJob(task)) {
      await agent.client.record({ action_id: null, outcome: 'failed', task_id: taskIdOf(task.id) ?? task.id, result: notPersonsJob(agent.label), idempotency_key: key }, { timeoutMs: TAKE_TIMEOUT_MS });
      print(RUNNER_WORDS.notYours(agent.label));
      setState(agent, 'handed_back', RUNNER_WORDS.notYours(agent.label));
      return;
    }
    // Asked again at the start of every job: the check may have changed since the last look.
    let fresh;
    try {
      fresh = agent.ready(o.dir) || { ok: false, text: '' };
    } catch {
      fresh = { ok: false, text: '' };
    }
    if (!fresh.ok) {
      await agent.client.record(
        { action_id: null, outcome: 'failed', task_id: task.id, result: cannotStartResult(agent.label, fresh.text || ''), summary: printable(RUNNER_WORDS.cannotStart(agent.label, fresh.text || ''), 240), idempotency_key: key },
        { timeoutMs: TAKE_TIMEOUT_MS },
      );
      print(RUNNER_WORDS.cannotStart(agent.label, fresh.text || ''));
      setState(agent, 'cannot_start', RUNNER_WORDS.cannotStart(agent.label, fresh.text || ''));
      return;
    }
    // The job's words go to a terminal only; the log and the status file say that a job was taken
    // (runner security review: nothing on the computer keeps a job's words or a command's text).
    print(toLog ? RUNNER_WORDS.tookJob(agent.label) : RUNNER_WORDS.taken(agent.label, printable(task.description)));
    setState(agent, 'running', RUNNER_WORDS.tookJob(agent.label));
    // While it runs, Aimiru still shows the runner on: a busy word every BUSY_PING_MS, which takes
    // nothing (only to a door that knows runners; an older door would read it as a take).
    const ended = new AbortController();
    // The job starts first; the pings follow it. Into the log, nothing the run prints: its notes
    // name commands and files, and its last lines are the result.
    let running;
    try {
      running = Promise.resolve(agent.run({ task, dir: o.dir, print: toLog ? () => {} : print, stop, spawn })).catch(() => {});
    } catch {
      // The connector's run records its own end; a throw here means it could not even start.
      running = Promise.resolve();
    }
    const pings = (async () => {
      while (!ended.signal.aborted && knows.has(agent.connector)) {
        await waitFor(BUSY_PING_MS, ended.signal, o.sleep);
        if (ended.signal.aborted) break;
        try {
          await agent.client.takeTask({ timeoutMs: TAKE_TIMEOUT_MS, withBudget: false, runner: { ...runner, busy: true } });
        } catch {
          // the next one, or the next poll, says it
        }
      }
    })();
    const done = await running;
    ended.abort();
    await pings;
    // How it ended, in the runner's own words: never the result's.
    const ending = RUNNER_WORDS.jobEnded(agent.label, done?.outcome);
    if (toLog) print(ending);
    setState(agent, done?.outcome === 'completed' ? 'finished' : 'not_finished', ending);
  }

  /** Tells Aimiru this runner is going, so Today says it at once (best effort, short). */
  async function leave(agents) {
    await Promise.all(
      agents
        .filter((agent) => knows.has(agent.connector))
        .map(async (agent) => {
          try {
            await agent.client?.takeTask({ timeoutMs: LEAVE_TIMEOUT_MS, withBudget: false, runner: { ...runner, leaving: true } });
          } catch {
            // its presence lapses on its own
          }
        }),
    );
  }

  return {
    states,
    async run() {
      const agents = Array.isArray(o.agents) ? o.agents.filter(Boolean) : [];
      if (!agents.length) {
        print(RUNNER_WORDS.noAgents);
        return 1;
      }
      print(RUNNER_WORDS.started(runner.device, o.dir));
      await Promise.all(agents.map((a) => loop(a)));
      await leave(agents.filter((a) => a.client));
      print(RUNNER_WORDS.stopped);
      return 0;
    },
  };
}

// ---------------------------------------------------------------------------
// Finding each agent's take path
// ---------------------------------------------------------------------------

/** What each connector's runner-agent.mjs exports as RUNNER_AGENT: the shape createRunner reads. */
export const RUNNER_AGENT_VERSION = 1;

/** Claude Code's own settings folder (CLAUDE_CONFIG_DIR, else ~/.claude). */
function claudeConfigDir(env) {
  return env.CLAUDE_CONFIG_DIR ? path.resolve(env.CLAUDE_CONFIG_DIR) : path.join(homeOf(env), '.claude');
}

function realOrNull(p) {
  try {
    return fs.realpathSync(p);
  } catch {
    return null;
  }
}

function inside(child, parent) {
  const rel = path.relative(parent, child);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/**
 * Where Claude Code installed Aimiru's plugin (its own installed_plugins.json, the plugin under its
 * published name first): {id, root, file} for the plugin's folder and its take path, only when both
 * lie inside Claude Code's plugins folder. Null when there is none.
 */
export function claudePluginInstall(env = process.env) {
  const plugins = path.join(claudeConfigDir(env), 'plugins');
  const record = readJson(path.join(plugins, 'installed_plugins.json'));
  const all = record && typeof record === 'object' ? (record.plugins ?? record) : null;
  if (!all || typeof all !== 'object') return null;
  const ids = Object.keys(all)
    .filter((id) => /^aimiru(@|$)/i.test(id))
    .sort((a, b) => (a.startsWith('aimiru@aimiru') ? -1 : b.startsWith('aimiru@aimiru') ? 1 : a.localeCompare(b)));
  const realPlugins = realOrNull(plugins);
  for (const id of ids) {
    const entries = Array.isArray(all[id]) ? all[id] : [all[id]];
    for (const e of entries) {
      const root = typeof e?.installPath === 'string' ? realOrNull(e.installPath) : null;
      if (!root) continue;
      const file = realOrNull(path.join(root, 'scripts', 'lib', 'runner-agent.mjs'));
      if (file && realPlugins && inside(root, realPlugins) && inside(file, realPlugins)) return { id, root, file };
    }
  }
  return null;
}

/** The plugin's take path (claudePluginInstall), or null. */
export function claudePluginAgentFile(env = process.env) {
  return claudePluginInstall(env)?.file ?? null;
}

/** The plugin's own folder, where Claude Code runs Aimiru's check from (claudePluginInstall), or null. */
export function claudePluginRoot(env = process.env) {
  return claudePluginInstall(env)?.root ?? null;
}

/** Codex's own copy of Aimiru's check, as `aimiru-codex init` writes it (under ~/.aimiru/codex). */
function codexAppDir(env) {
  return path.join(setting(env, 'CODEX_DATA') || path.join(homeOf(env), '.aimiru', 'codex'), 'app');
}

/** Codex's own copy of Aimiru's check (`aimiru-codex init` writes it): its take path, or null. */
export function codexAppAgentFile(env = process.env) {
  const app = codexAppDir(env);
  const file = realOrNull(path.join(app, 'lib', 'runner-agent.mjs'));
  const realApp = realOrNull(app);
  return file && realApp && inside(file, realApp) ? file : null;
}

/** The first release whose files are all under ~/.aimiru, and whose checks protect them (ADR-0164). */
export const MOVED_IN = '0.3.0-rc.3';

/** -1, 0 or 1 for two versions like 0.3.0-rc.2, as semver orders them: a pre-release comes before its release. */
export function compareReleases(a, b) {
  const parse = (v) => {
    const m = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/.exec(String(v ?? '').trim());
    return m ? { nums: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4] ? m[4].split('.') : null } : null;
  };
  const x = parse(a);
  const y = parse(b);
  if (!x || !y) return 0;
  for (let i = 0; i < 3; i += 1) if (x.nums[i] !== y.nums[i]) return x.nums[i] < y.nums[i] ? -1 : 1;
  if (!x.pre || !y.pre) return x.pre === y.pre ? 0 : x.pre ? -1 : 1;
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i += 1) {
    const p = x.pre[i];
    const q = y.pre[i];
    if (p === undefined || q === undefined) return p === undefined ? -1 : 1;
    const np = /^\d+$/.test(p);
    const nq = /^\d+$/.test(q);
    if (np && nq && Number(p) !== Number(q)) return Number(p) < Number(q) ? -1 : 1;
    if (np !== nq) return np ? -1 : 1;
    if (!np && p !== q) return p < q ? -1 : 1;
  }
  return 0;
}

/** The version of Aimiru's plugin that Claude Code installed (installed_plugins.json, else its plugin.json), or null. */
function claudePluginVersions(env) {
  const record = readJson(path.join(claudeConfigDir(env), 'plugins', 'installed_plugins.json'));
  const all = record && typeof record === 'object' ? (record.plugins ?? record) : null;
  if (!all || typeof all !== 'object') return [];
  const out = [];
  for (const id of Object.keys(all).filter((k) => /^aimiru(@|$)/i.test(k))) {
    for (const e of Array.isArray(all[id]) ? all[id] : [all[id]]) {
      const own = typeof e?.installPath === 'string' ? readJson(path.join(e.installPath, '.claude-plugin', 'plugin.json'))?.version : null;
      const v = typeof e?.version === 'string' ? e.version : own;
      if (typeof v === 'string') out.push(v);
    }
  }
  return out;
}

/** The <dot folder>/codex of each check copy Codex's hooks.json runs in the installer's own shape. */
function codexCopyFolders(env) {
  const codexHome = env.CODEX_HOME || path.join(homeOf(env), '.codex');
  const data = readJson(path.join(codexHome, 'hooks.json'));
  const out = [];
  for (const groups of Object.values(data?.hooks && typeof data.hooks === 'object' ? data.hooks : {})) {
    for (const g of Array.isArray(groups) ? groups : []) {
      for (const h of Array.isArray(g?.hooks) ? g.hooks : []) {
        const m = /-u NODE_OPTIONS -u NODE_PATH "[^"]+" "([^"]+)"/.exec(String(h?.command ?? ''));
        const parts = m ? m[1].split('/') : [];
        const n = parts.length;
        if (n >= 5 && parts[n - 2] === 'app' && parts[n - 3] === 'codex' && /^\.[A-Za-z0-9_-]+$/.test(parts[n - 4])) out.push(parts.slice(0, n - 2).join('/'));
      }
    }
  }
  return out;
}

/** The runner folder the LaunchAgent starts its copy from (<folder>/app/runner.mjs), or null. */
function launchedRunnerHome(env) {
  let text = '';
  try {
    text = fs.readFileSync(launchAgentFile(env), 'utf8');
  } catch {
    return null;
  }
  for (const m of text.matchAll(/<string>([^<]*)<\/string>/g)) {
    const s = m[1].replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
    const at = /^(\/.+)\/app\/runner\.mjs$/.exec(s);
    if (at) return at[1];
  }
  return null;
}

/** What each earlier install says, with the line that updates it (docs/04 words). */
export const EARLIER_WORDS = Object.freeze({
  'claude-code': (line) => `Aimiru for Claude Code on this computer is an earlier version, so it and your other agents do not guard each other's Aimiru files until it is updated: ${line}`,
  codex: (line) => `Aimiru for Codex on this computer is an earlier version, so it and your other agents do not guard each other's Aimiru files until it is updated: ${line}`,
  runner: (line) => `The runner on this computer still starts an earlier version of Aimiru. Turn it on again to update it: ${line}`,
});

/** The lines that update each one: Claude Code's plugin, Codex's check (no tag, no version). */
const UPDATE_LINES = Object.freeze({
  'claude-code': 'claude plugin marketplace update aimiru, then claude plugin update aimiru@aimiru, then restart Claude Code',
  codex: 'npx aimiru-codex init',
});

/**
 * The connectors on this computer still on an Aimiru from before its files moved to ~/.aimiru
 * (ADR-0164), read from where each is started: Claude Code's installed plugin by its version, Codex's
 * hooks.json by the folder its check runs from, and the runner's LaunchAgent by the folder its copy
 * is in. A check of 0.3.0-rc.2 or older protects only the folder of its own time, and one of this
 * release protects the earlier one only by shape, so until every connector here is updated, one
 * agent may change another's Aimiru files without an ask (security review of the rename). Each with
 * what to tell the person. Empty when there is none.
 * @param {Record<string, string|undefined>} [env]
 * @param {{runnerLine?: string}} [o] how the person turns the runner on again with this connector
 * @returns {{connector: 'claude-code'|'codex'|'runner', text: string}[]}
 */
export function earlierInstalls(env = process.env, { runnerLine = 'npx aimiru-codex runner on' } = {}) {
  const out = [];
  if (claudePluginVersions(env).some((v) => compareReleases(v, MOVED_IN) < 0)) out.push({ connector: 'claude-code', text: EARLIER_WORDS['claude-code'](UPDATE_LINES['claude-code']) });
  const codexData = path.resolve(setting(env, 'CODEX_DATA') || path.join(homeOf(env), '.aimiru', 'codex'));
  if (codexCopyFolders(env).some((d) => path.resolve(d) !== codexData)) out.push({ connector: 'codex', text: EARLIER_WORDS.codex(UPDATE_LINES.codex) });
  const launched = launchedRunnerHome(env);
  if (launched && path.resolve(launched) !== path.resolve(runnerHome(env))) out.push({ connector: 'runner', text: EARLIER_WORDS.runner(runnerLine) });
  return out;
}

/** The person-facing name of each connector that can turn the runner on. */
const CONNECTOR_LABELS = Object.freeze({ 'claude-code': 'Claude Code', codex: 'Codex' });

/**
 * The scripts of the connector that turns the runner on, as that connector is installed on this
 * computer now, in the folder its check runs from (both protected by name): Claude Code's plugin
 * folder (claudePluginInstall) or Codex's own copy (~/.aimiru/codex/app). Null when there is none.
 */
export function installedScriptsOf(connector, env = process.env) {
  if (connector === 'claude-code') {
    const root = claudePluginRoot(env);
    return root ? realOrNull(path.join(root, 'scripts')) : null;
  }
  if (connector === 'codex') return realOrNull(codexAppDir(env));
  return null;
}

/** A file's bytes as sha256 hex. */
function fileHash(file) {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

/** Each .mjs file in lib and vendor, and runner.mjs at the top when asked, by name, as its sha256; null when unreadable. */
function scriptHashes(dir, { entry }) {
  const out = {};
  try {
    for (const sub of ['lib', 'vendor']) {
      const d = path.join(dir, sub);
      if (!fs.existsSync(d)) continue;
      for (const f of fs.readdirSync(d).sort()) {
        if (f.endsWith('.mjs') && fs.statSync(path.join(d, f)).isFile()) out[`${sub}/${f}`] = fileHash(path.join(d, f));
      }
    }
    if (entry) out['runner.mjs'] = fileHash(path.join(dir, 'runner.mjs'));
  } catch {
    return null;
  }
  return out;
}

/**
 * Whether a copy of a connector's scripts (the runner's own, or the folder `on` copies from) is that
 * connector as installed on this computer now: the same lib and vendor files, byte for byte, and the
 * same runner.mjs where the installed folder has one (Claude Code's plugin does; Codex's own copy
 * holds the check, not the runner's entry). The runner's copy lives in a folder the checks protect;
 * this also catches a copy changed in part, or one left behind by an update (security review of
 * wk/runner). {ok: true} or {ok: false, why: 'not_installed' | 'changed'}.
 */
export function copyMatchesInstalled({ copy, connector, env = process.env }) {
  const installed = installedScriptsOf(connector, env);
  if (!installed) return { ok: false, why: 'not_installed' };
  const entry = fs.existsSync(path.join(installed, 'runner.mjs'));
  const want = scriptHashes(installed, { entry });
  const have = scriptHashes(copy, { entry });
  if (!want || !have || !Object.keys(want).length) return { ok: false, why: 'changed' };
  const names = new Set([...Object.keys(want), ...Object.keys(have)]);
  for (const n of names) if (want[n] !== have[n]) return { ok: false, why: 'changed' };
  return { ok: true };
}

/**
 * Every agent this computer's connectors can start: Claude Code's plugin and Codex's own copy, as
 * installed, first; the runner's own copy (the connector that turned it on) only for a connector
 * neither has. One per connector, so the runner's copy never shadows an installed take path.
 */
export async function loadAgents({ env = process.env, own = null, importer = (p) => import(pathToFileURL(p).href), print = () => {} } = {}) {
  const out = [];
  const seen = new Set();
  const candidates = [claudePluginAgentFile(env), codexAppAgentFile(env), own].filter(Boolean);
  for (const file of candidates) {
    let mod;
    try {
      mod = await importer(file);
    } catch {
      continue;
    }
    if (mod?.RUNNER_AGENT !== RUNNER_AGENT_VERSION || typeof mod.runnerAgent !== 'function') continue;
    let agent;
    try {
      agent = mod.runnerAgent({ env, print });
    } catch {
      continue;
    }
    if (!agent || seen.has(agent.connector)) continue;
    seen.add(agent.connector);
    out.push(agent);
  }
  return out;
}

// ---------------------------------------------------------------------------
// The LaunchAgent (macOS): on after a restart, until `runner off`
// ---------------------------------------------------------------------------

function xml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** Each setting Aimiru reads, by its name in the environment (AIMIRU_<name>). */
const settingNames = (names) => names.map((n) => `AIMIRU_${n}`);

/**
 * What the LaunchAgent sets to empty, so nothing launchd hands every program at login (`launchctl
 * setenv`) reaches the runner (security review of wk/runner): what turns Claude Code's checks off
 * (CLAUDE_CODE_SIMPLE is --bare, CLAUDE_CODE_SAFE_MODE is --safe-mode), what loads code into node
 * (NODE_OPTIONS, NODE_PATH), and what points a check or the runner at another key, address, project,
 * program or folder (the plugin's own, Aimiru's, and the folders KEPT_ENV keeps only when the person
 * had them at `on`). An empty setting is no setting: the runner drops it before any agent sees it.
 */
export const BLANKED_ENV = Object.freeze([
  'CLAUDE_CODE_SIMPLE',
  'CLAUDE_CODE_SAFE_MODE',
  'NODE_OPTIONS',
  'NODE_PATH',
  'CLAUDE_PLUGIN_ROOT',
  'CLAUDE_PLUGIN_DATA',
  'CLAUDE_PLUGIN_OPTION_AGENT_KEY',
  'CLAUDE_PLUGIN_OPTION_AIMIRU_URL',
  ...settingNames(['AGENT_TOKEN', 'BASE_URL', 'URL', 'PROJECT', 'CLAUDE_VERSION', 'CLAUDE_BIN', 'CODEX_BIN']),
  'CLAUDE_CONFIG_DIR',
  'CODEX_HOME',
  ...settingNames(['CODEX_DATA']),
]);

/**
 * The LaunchAgent: `node <the runner's copy>/runner.mjs run` at login and whenever it stops with an
 * error (not after a clean stop), its log in the runner's folder, PATH so it finds node, Claude Code
 * and Codex. Its environment holds folders only: never a key, an address or a job's words; each
 * setting in BLANKED_ENV is set empty unless the person's own folder setting replaces it (extraEnv).
 */
export function launchAgentPlist({ node, script, home, logFile, pathDirs = [], extraEnv = {} }) {
  const blanks = Object.fromEntries(BLANKED_ENV.map((k) => [k, '']));
  const envPairs = { PATH: [...new Set([...pathDirs, '/usr/bin', '/bin', '/usr/sbin', '/sbin'])].join(':'), HOME: home, ...blanks, ...extraEnv };
  const envXml = Object.entries(envPairs)
    .map(([k, v]) => `      <key>${xml(k)}</key>\n      <string>${xml(v)}</string>`)
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key>
    <string>${LABEL}</string>
    <key>ProgramArguments</key>
    <array>
      <string>${xml(node)}</string>
      <string>${xml(script)}</string>
      <string>run</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <dict>
      <key>SuccessfulExit</key>
      <false/>
    </dict>
    <key>ThrottleInterval</key>
    <integer>10</integer>
    <key>WorkingDirectory</key>
    <string>${xml(path.dirname(logFile))}</string>
    <key>StandardOutPath</key>
    <string>${xml(logFile)}</string>
    <key>StandardErrorPath</key>
    <string>${xml(logFile)}</string>
    <key>EnvironmentVariables</key>
    <dict>
${envXml}
    </dict>
  </dict>
</plist>
`;
}

/** The environment a runner keeps from the person's own at `on`: folders only (never a key or an address). */
export const KEPT_ENV = Object.freeze(['CODEX_HOME', 'CLAUDE_CONFIG_DIR', 'AIMIRU_CODEX_DATA']);

/**
 * True when launchctl may be used for this plist: on a Mac, and only for the LaunchAgents folder of
 * the person running it (a test's own HOME never reaches the real launchd).
 */
export function realLaunchd(env = process.env, { platform = process.platform, userHome = safeUserHome() } = {}) {
  return platform === 'darwin' && userHome !== null && homeOf(env) === path.resolve(userHome);
}

function safeUserHome() {
  try {
    return os.userInfo().homedir;
  } catch {
    return null;
  }
}

function defaultLaunchctl(args) {
  const r = spawnSync('/bin/launchctl', args, { encoding: 'utf8', timeout: 10_000, stdio: ['ignore', 'pipe', 'pipe'] });
  return { ok: !r.error && r.status === 0, status: r.status, out: `${r.stdout || ''}${r.stderr || ''}` };
}

function uidOf() {
  try {
    return typeof process.getuid === 'function' ? process.getuid() : os.userInfo().uid;
  } catch {
    return null;
  }
}

/** Writes the LaunchAgent and starts it (bootout first, then bootstrap). {written, started}. */
export function installLaunchAgent({ env = process.env, plist, launchctl = defaultLaunchctl, platform = process.platform, userHome } = {}) {
  const file = launchAgentFile(env);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, plist, { mode: 0o644 });
  if (!realLaunchd(env, { platform, ...(userHome !== undefined ? { userHome } : {}) })) return { written: file, started: false };
  const uid = uidOf();
  launchctl(['bootout', `gui/${uid}/${LABEL}`]);
  const r = launchctl(['bootstrap', `gui/${uid}`, file]);
  return { written: file, started: r.ok };
}

/** Stops the LaunchAgent and removes its file. {removed}. */
export function removeLaunchAgent({ env = process.env, launchctl = defaultLaunchctl, platform = process.platform, userHome } = {}) {
  const file = launchAgentFile(env);
  const had = fs.existsSync(file);
  if (realLaunchd(env, { platform, ...(userHome !== undefined ? { userHome } : {}) })) launchctl(['bootout', `gui/${uidOf()}/${LABEL}`]);
  fs.rmSync(file, { force: true });
  return { removed: had };
}

// ---------------------------------------------------------------------------
// The commands: runner on | off | status | run
// ---------------------------------------------------------------------------

/** Where a program is on PATH, or null. */
export function whichOf(name, env = process.env) {
  for (const dir of String(env.PATH || '').split(path.delimiter).filter(Boolean)) {
    const p = path.join(dir, name);
    try {
      fs.accessSync(p, fs.constants.X_OK);
      if (fs.statSync(p).isFile()) return p;
    } catch {
      // not here
    }
  }
  return null;
}

/** Copies a connector's scripts (top level, lib, vendor) into the runner's own folder, replacing an older copy. */
export function copyScripts(from, to) {
  fs.mkdirSync(path.dirname(to), { recursive: true, mode: 0o700 });
  const next = `${to}.next-${process.pid}`;
  fs.rmSync(next, { recursive: true, force: true });
  fs.mkdirSync(next, { recursive: true, mode: 0o700 });
  for (const sub of ['', 'lib', 'vendor']) {
    const src = path.join(from, sub);
    if (!fs.existsSync(src)) continue;
    fs.mkdirSync(path.join(next, sub), { recursive: true, mode: 0o700 });
    for (const f of fs.readdirSync(src)) {
      if (/\.(mjs|sh)$/.test(f) && fs.statSync(path.join(src, f)).isFile()) fs.copyFileSync(path.join(src, f), path.join(next, sub, f));
    }
  }
  fs.writeFileSync(path.join(next, 'package.json'), `${JSON.stringify({ type: 'module', private: true }, null, 2)}\n`, { mode: 0o600 });
  const old = `${to}.old-${process.pid}`;
  if (fs.existsSync(to)) fs.renameSync(to, old);
  fs.renameSync(next, to);
  fs.rmSync(old, { recursive: true, force: true });
  return to;
}

function parseFlags(argv) {
  const flags = {};
  const args = [];
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const [k, v] = a.slice(2).split('=', 2);
      if (v !== undefined) flags[k] = v;
      else if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) flags[k] = argv[++i];
      else flags[k] = true;
    } else args.push(a);
  }
  return { flags, args };
}

function alive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e?.code === 'EPERM';
  }
}

/**
 * The command line of process pid, as ps shows it (full width), or null when there is no such
 * process or no ps to ask (Windows): then nothing is taken to be the runner.
 */
export function commandLineOf(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try {
    const r = spawnSync('/bin/ps', ['-ww', '-o', 'command=', '-p', String(pid)], { encoding: 'utf8', timeout: 3_000, stdio: ['ignore', 'pipe', 'ignore'] });
    if (r.error || r.status !== 0) return null;
    const line = String(r.stdout ?? '').trim();
    return line || null;
  } catch {
    return null;
  }
}

/**
 * Whether a command line is the runner's own loop: a runner.mjs started with run (launchd's copy,
 * or Claude Code's `node "<plugin>/scripts/runner.mjs" run`), or a connector's command with
 * `runner run` (`npx aimiru-codex runner run`). Anything else is never the runner.
 */
export function isRunnerCommand(line) {
  if (typeof line !== 'string' || !line) return false;
  return /(?:^|[\s/"'])runner\.mjs["']?\s+run(?:\s|$)/.test(line) || /(?:^|\s)runner\s+run(?:\s|$)/.test(line);
}

/**
 * The runner's process, from its process file, only while that process is alive and its command
 * line is the runner's (runner security review): a process file left from a runner that ended, or
 * one that names another program, is never the runner, so `runner off` never stops another program.
 */
function runningPid(env, commandLine = commandLineOf) {
  const v = readJson(files(env).pid);
  if (!v || !alive(v.pid)) return null;
  return isRunnerCommand(commandLine(v.pid)) ? v.pid : null;
}

function trimLog(file) {
  try {
    if (fs.statSync(file).size > LOG_MAX_BYTES) fs.renameSync(file, `${file}.1`);
  } catch {
    // no log yet
  }
}

/**
 * `runner <on|off|status|run>` for a connector. o.connector names it, o.scriptsDir is its scripts
 * folder (copied at `on`), o.ownAgent is its runner-agent.mjs, o.line is how the person types it.
 * Resolves to the exit code.
 */
export async function runnerMain(argv, o) {
  const env = o.env || process.env;
  const print = o.print || ((s) => process.stdout.write(`${s}\n`));
  const { flags, args } = parseFlags(argv);
  const command = args[0] || 'status';
  const f = files(env);
  const line = (sub) => `${o.line} ${sub}`;
  const terminal = o.terminal ?? Boolean(process.stdin.isTTY && process.stdout.isTTY);
  const platform = o.platform || process.platform;

  if ((command === 'on' || command === 'off' || command === 'run') && insideAgent(env)) {
    print(RUNNER_WORDS.insideAgent);
    return 1;
  }

  if (command === 'on') {
    if (!terminal) {
      print(RUNNER_WORDS.notPerson);
      return 1;
    }
    const folder = checkFolder(typeof flags.dir === 'string' ? flags.dir : process.cwd(), env);
    if (!folder.ok) {
      print(folderWords(folder));
      return 1;
    }
    // Only a copy of the connector exactly as it is installed here, where its check runs from.
    if (!copyMatchesInstalled({ copy: o.scriptsDir, connector: o.connector, env: withoutEmpty(env) }).ok) {
      print(RUNNER_WORDS.differs(CONNECTOR_LABELS[o.connector] ?? 'this agent'));
      return 1;
    }
    const name = flags.name === undefined ? null : cleanName(flags.name);
    const node = o.node || process.execPath;
    // The programs the person names here (their own terminal), else the ones on PATH; kept in the
    // runner's settings, which launchd's own environment cannot replace (BLANKED_ENV).
    const claudeBin = setting(env, 'CLAUDE_BIN') || whichOf('claude', env);
    const codexBin = setting(env, 'CODEX_BIN') || whichOf('codex', env);
    const extraEnv = {};
    for (const k of KEPT_ENV) if (typeof env[k] === 'string' && env[k]) extraEnv[k] = env[k];
    copyScripts(o.scriptsDir, f.app);
    writeJson(f.config, { dir: folder.dir, name, node, claude: claudeBin, codex: codexBin, connector: o.connector, at: new Date().toISOString() });
    runnerIdOf(env);
    const device = name || (o.device ?? deviceKind({ platform }));
    // Readiness as the runner will see it: on a Mac, with what the LaunchAgent empties left out.
    const readyEnv = withoutEmpty(platform === 'darwin' ? { ...env, ...Object.fromEntries(BLANKED_ENV.map((k) => [k, ''])), ...extraEnv } : env);
    if (claudeBin && !setting(readyEnv, 'CLAUDE_BIN')) readyEnv.AIMIRU_CLAUDE_BIN = claudeBin;
    if (codexBin && !setting(readyEnv, 'CODEX_BIN')) readyEnv.AIMIRU_CODEX_BIN = codexBin;
    const agents = await loadAgents({ env: readyEnv, own: path.join(f.app, 'lib', 'runner-agent.mjs'), importer: o.importer });
    print(RUNNER_WORDS.on(device, folder.dir));
    const readyLabels = [];
    for (const a of agents) {
      const r = safeReady(a, folder.dir);
      if (r.ok) readyLabels.push(a.label);
      print(r.ok ? RUNNER_WORDS.ready(a.label) : RUNNER_WORDS.notReady(a.label, r.text || ''));
    }
    print(RUNNER_WORDS.onAgents(readyLabels));
    if (platform === 'darwin') {
      const plist = launchAgentPlist({
        node,
        script: path.join(f.app, 'runner.mjs'),
        home: homeOf(env),
        logFile: f.log,
        pathDirs: [node, claudeBin, codexBin].filter(Boolean).map((p) => path.dirname(p)),
        extraEnv,
      });
      installLaunchAgent({ env, plist, launchctl: o.launchctl, platform, userHome: o.userHome });
      print(RUNNER_WORDS.stays);
    } else {
      print(RUNNER_WORDS.noLaunchAgent(line('run')));
    }
    print(RUNNER_WORDS.offHow(line('off')));
    return 0;
  }

  if (command === 'off') {
    const had = fs.existsSync(launchAgentFile(env));
    removeLaunchAgent({ env, launchctl: o.launchctl, platform, userHome: o.userHome });
    // Only a process whose command line is the runner's is stopped; a process file that names
    // another program (one that ended long ago, its number now another program's) is cleared.
    const pid = runningPid(env, o.commandLineOf || commandLineOf);
    if (pid && pid !== process.pid) {
      try {
        process.kill(pid, 'SIGTERM');
      } catch {
        // already gone
      }
    } else if (!pid) {
      try {
        fs.rmSync(f.pid, { force: true });
      } catch {
        // nothing to clear
      }
    }
    print(had || pid ? RUNNER_WORDS.off : RUNNER_WORDS.offNothing);
    return 0;
  }

  if (command === 'status') {
    const config = readConfig(env);
    if (!config) {
      print(RUNNER_WORDS.noConfig(line('on')));
      return 1;
    }
    print(RUNNER_WORDS.status.installed(fs.existsSync(launchAgentFile(env))));
    print(RUNNER_WORDS.status.running(runningPid(env, o.commandLineOf || commandLineOf)));
    print(RUNNER_WORDS.status.device(config.name || o.device || deviceKind({ platform })));
    print(RUNNER_WORDS.status.folder(config.dir));
    const st = readJson(f.status);
    if (typeof st?.note === 'string' && st.note) print(printable(st.note, 300));
    for (const s of Object.values(st?.agents ?? {})) {
      if (s && typeof s.label === 'string' && typeof s.text === 'string') print(RUNNER_WORDS.status.last(printable(s.label, 40), printable(s.text, 300)));
    }
    return 0;
  }

  if (command === 'run') {
    const launched = env.XPC_SERVICE_NAME === LABEL;
    if (!terminal && !launched) {
      print(RUNNER_WORDS.notPerson);
      return 1;
    }
    const config = readConfig(env);
    if (!config) {
      print(RUNNER_WORDS.noConfig(line('on')));
      // A clean exit: launchd does not start it again until the person turns it on.
      return 0;
    }
    const folder = checkFolder(config.dir, env);
    if (!folder.ok) {
      print(folderWords(folder));
      return 0;
    }
    trimLog(f.log);
    // A setting the LaunchAgent emptied is no setting: no agent sees it (BLANKED_ENV).
    const runEnv = withoutEmpty(env);
    // The copy launchd starts must be the installed connector's, byte for byte, or nothing starts.
    if (!copyMatchesInstalled({ copy: f.app, connector: config.connector, env: runEnv }).ok) {
      const note = RUNNER_WORDS.copyChanged(line('on'));
      print(note);
      try {
        writeJson(f.status, { pid: process.pid, at: new Date().toISOString(), note, agents: {} });
      } catch {
        // a convenience for `runner status`
      }
      return 0;
    }
    if (config.claude && !setting(runEnv, 'CLAUDE_BIN')) runEnv.AIMIRU_CLAUDE_BIN = config.claude;
    if (config.codex && !setting(runEnv, 'CODEX_BIN')) runEnv.AIMIRU_CODEX_BIN = config.codex;
    const stopper = new AbortController();
    const outer = o.stop;
    if (outer) {
      if (outer.aborted) stopper.abort();
      else outer.addEventListener('abort', () => stopper.abort(), { once: true });
    }
    const signals = o.signals === false ? [] : ['SIGINT', 'SIGTERM', 'SIGHUP'];
    const onSignal = () => {
      if (stopper.signal.aborted) process.exit(130);
      print(RUNNER_WORDS.stopping);
      stopper.abort();
    };
    for (const s of signals) process.on(s, onSignal);
    writeJson(f.pid, { pid: process.pid, at: new Date().toISOString() });
    try {
      const agents = await loadAgents({ env: runEnv, own: o.ownAgent, importer: o.importer, print });
      const r = createRunner({
        agents,
        dir: folder.dir,
        runnerId: runnerIdOf(env),
        device: config.name || o.device || deviceKind({ platform }),
        print,
        // launchd's runner prints into its log file (the LaunchAgent's StandardOutPath).
        toLog: launched || !terminal,
        stop: stopper.signal,
        sleep: o.sleep,
        now: o.now,
        spawn: o.spawn,
        onState: (agentsState) => {
          try {
            writeJson(f.status, { pid: process.pid, at: new Date().toISOString(), agents: agentsState });
          } catch {
            // a convenience for `runner status`
          }
        },
      });
      const code = await r.run();
      // No agent at all: a clean exit, so launchd does not start it again and again.
      return code === 1 ? 0 : code;
    } finally {
      for (const s of signals) process.off(s, onSignal);
      try {
        if (readJson(f.pid)?.pid === process.pid) fs.rmSync(f.pid, { force: true });
      } catch {
        // ignore
      }
    }
  }

  print(`Unknown runner command "${printable(command, 40)}". Use on, off, status or run.`);
  return 2;
}

/** The environment without the settings that are empty. */
function withoutEmpty(env) {
  const out = {};
  for (const [k, v] of Object.entries(env || {})) if (v !== undefined && v !== null && v !== '') out[k] = v;
  return out;
}

function safeReady(agent, dir) {
  try {
    return agent.ready(dir) || { ok: false, text: '' };
  } catch {
    return { ok: false, text: '' };
  }
}
