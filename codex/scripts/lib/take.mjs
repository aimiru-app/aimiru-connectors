// aimiru-codex take [--watch] [--dir <folder>] (ADR-0157): Codex takes the next job the person gave it
// in Aimiru and runs it with `codex exec` in that folder, under Aimiru's check, and Aimiru gets the
// result with the job's id. Codex's only way to take the person's work: its SessionStart entry gives
// the brief and never takes a job.
//
// Never runs a job unchecked. Codex skips a check it has not trusted, or one that moved, without a
// word, so nothing is taken until Aimiru's check has run inside Codex at the place it is now since the
// last install (the doctor's signal: status.json hook_reported_at after installed_at, at group_index and
// handler_index), Codex's checks are on and the person did not turn the check off. Never a flag that
// changes Codex's sandbox, its approvals or its checks (EXEC_FLAGS is all it passes; NEVER_FLAGS is
// pinned by a test): the person's own Codex settings decide those.
//
// One run: GET /v1/pause (paused: nothing is taken), POST /v1/tasks/take, then `codex exec --json --cd
// <folder> --output-last-message <file> -` with the job on its input and AIMIRU_TASK_ID in its
// environment, so every step's check names the job (pre-tool-use.mjs). While it works, the person
// sees on the terminal, and Aimiru gets with the job's id, short notes made from Codex's own events
// (lib/progress.mjs), and every refusal exactly as Codex surfaces it (lib/refusals.mjs). At the end,
// POST /v1/receipts with task_id, outcome completed or failed, and Codex's last message as the result
// (kept and sent later when Aimiru cannot take it). --watch looks every 30 s, never while paused, and
// stops cleanly on Ctrl+C.

import { spawn as spawnChild, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { jobPrompt, notPersonsJob } from '../vendor/messages.mjs';
import { redactContacts } from '../vendor/contacts.mjs';
import { personsOwnJob, redactSecrets, setting, sha256Hex, sleep, taskIdOf, truncate } from '../vendor/sayso-client.mjs';
import { appDirOf, codexSettingsFacts, entryTrust, findOurHook, hookKeyOf, isOurExactCheck } from './install.mjs';
import { createProgress, noteForEvent } from './progress.mjs';
import { followRefusals } from './refusals.mjs';
import { PACKAGE_NAME, loadSettings, makeClient, ranSinceInstall, stateStore } from './runtime.mjs';
import { JOB_WORDS } from './words.mjs';

/** How often --watch looks for a job. */
export const WATCH_EVERY_MS = 30_000;
/** The longest one job may run before it is stopped and recorded as not finished. */
export const RUN_LIMIT_MS = 60 * 60_000;
/** The longest result Aimiru takes (CONTRACT.md, POST /v1/receipts result). */
export const RESULT_MAX = 4_000;
/** The line that installs or updates Codex's check: no tag and no version (Rohit, 29 Oct 23:50). */
const INSTALL = `npx ${PACKAGE_NAME} init`;
export const INSTALL_LINE = INSTALL;

/**
 * Everything `take` passes to `codex exec`, besides the folder and the file for its last message: JSON
 * events on stdout, the job on stdin. Nothing about Codex's sandbox, approvals or checks.
 */
export function execArgs({ dir, lastMessageFile }) {
  return ['exec', '--json', '--cd', dir, '--output-last-message', lastMessageFile, '-'];
}

/** The flags execArgs passes, and only these (with "-": the job on stdin). */
export const EXEC_FLAGS = Object.freeze(['--json', '--cd', '--output-last-message']);

/**
 * Flags that weaken Codex's own sandbox, approvals or checks, or keep no transcript: `take` never
 * passes one (test/take.test.mjs). --sandbox is among them, so it can never meet --approve-for-me,
 * which Codex refuses together with it (Mac run, 28 Oct).
 */
export const NEVER_FLAGS = Object.freeze([
  '--sandbox',
  '-s',
  '--approve-for-me',
  '--dangerously-bypass-approvals-and-sandbox',
  '--yolo',
  '--dangerously-bypass-hook-trust',
  '--skip-git-repo-check',
  '--ignore-user-config',
  '--ignore-rules',
  '--ephemeral',
  '--disable',
  '-c',
  '--config',
  '--add-dir',
  '--full-auto',
]);

/** The git folder holding dir (Codex runs `exec` only inside one), or null. */
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

/** The Codex program to run: AIMIRU_CODEX_BIN (or SAYSO_CODEX_BIN), else codex on PATH. */
export function codexBinOf(env = process.env) {
  return setting(env, 'CODEX_BIN') || 'codex';
}

/** Codex's own word on its checks in the job's folder: `codex features list` says hooks ... true. */
export function codexChecksOn(env, dir) {
  try {
    const r = spawnSync(codexBinOf(env), ['features', 'list'], { cwd: dir, env, timeout: 5_000, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    return !r.error && /^hooks\s+\S+\s+true$/m.test(r.stdout || '');
  } catch {
    return false;
  }
}

/**
 * The project's own Codex settings file, from dir up to its git folder, that says anything about
 * checks (the nearest one), or null.
 */
export function projectSaysHooks(dir) {
  const root = gitRootOf(dir);
  if (!root) return null;
  let d = path.resolve(dir);
  for (let i = 0; i < 60; i += 1) {
    const file = path.join(d, '.codex', 'config.toml');
    try {
      if (/hooks/i.test(fs.readFileSync(file, 'utf8'))) return file;
    } catch {
      // none here
    }
    if (d === root) return null;
    const up = path.dirname(d);
    if (up === d) return null;
    d = up;
  }
  return null;
}

/**
 * Whether a job may run here now (ADR-0157), failing closed (security review): Aimiru's check is in
 * Codex's settings exactly as install writes it (no matcher, nothing changed), Codex's checks are on
 * (its settings, and with dir, Codex's own `features list` there and no project setting about checks
 * from the git folder down), the person did not turn the check off, Codex's own settings say they
 * trust it as it is now (the hash it keeps; anything unreadable counts as not trusted), and it has run
 * inside Codex at the place it is now since the last install. {ok: true} or {ok: false, why}, with
 * the settings file to change where one is the reason (file).
 */
export function readyToTake(settings, { dir = null, env = process.env } = {}) {
  const appDir = appDirOf(settings.dataDir);
  const at = findOurHook({ codexHome: settings.codexHome, appDir });
  if (!at.present) return { ok: false, why: 'not_checked' };
  if (!isOurExactCheck(at, appDir)) return { ok: false, why: 'changed' };
  const facts = codexSettingsFacts({ codexHome: settings.codexHome, hookKey: hookKeyOf(at.file, at.groupIndex, at.handlerIndex) });
  // Codex's own settings file, where its checks are turned on or off.
  const codexSettings = path.join(settings.codexHome, 'config.toml');
  if (facts.checksOff) return { ok: false, why: 'checks_off', file: codexSettings };
  if (facts.turnedOff) return { ok: false, why: 'turned_off' };
  if (dir !== null) {
    const project = projectSaysHooks(dir);
    if (project) return { ok: false, why: 'project_checks', file: project };
    if (!codexChecksOn(env, dir)) return { ok: false, why: 'checks_off', file: codexSettings };
  }
  const trust = entryTrust({ codexHome: settings.codexHome, at, event: 'PreToolUse' });
  if (trust.off) return { ok: false, why: 'turned_off' };
  if (trust.state !== 'trusted') return { ok: false, why: 'not_checked' };
  const status = stateStore(settings.dataDir).readStatus();
  const here = Number.isInteger(status.group_index) && status.group_index === at.groupIndex && (status.handler_index ?? 0) === at.handlerIndex;
  if (!ranSinceInstall(status) || !here) return { ok: false, why: 'not_checked' };
  return { ok: true };
}

const NOT_READY = {
  not_checked: () => JOB_WORDS.takeNotChecked('/hooks'),
  changed: () => JOB_WORDS.checkChanged('/hooks'),
  checks_off: (r) => JOB_WORDS.takeChecksOff(printable(r.file)),
  project_checks: (r) => JOB_WORDS.takeProjectChecks(printable(r.file)),
  turned_off: () => JOB_WORDS.takeTurnedOff('/hooks'),
};

/** What the person reads when readyToTake says no (the runner says it too, ADR-0161). */
export function notReadyText(r) {
  return (NOT_READY[r?.why] ?? NOT_READY.not_checked)(r ?? {});
}

/**
 * Text from outside this program (Codex's session file, Codex's own words, the person's job) as the
 * terminal shows it: no control characters, so nothing in it can move the cursor or change the
 * screen, and line breaks become spaces. Never cut.
 */
export function printable(text) {
  return String(text ?? '')
    // Control characters, line and paragraph separators, and format characters such as the
    // right-to-left override (security review).
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029\p{Cf}]+/gu, ' ')
    .trim();
}

/** One line of the person's words, for the terminal. */
function oneLine(text, max = 200) {
  return truncate(
    String(text ?? '')
      // eslint-disable-next-line no-control-regex
      .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029\p{Cf}]+/gu, ' ')
      .replace(/\s+/g, ' ')
      .trim(),
    max,
  );
}

/**
 * Runs one job with `codex exec` and records its end. Resolves to {outcome, result, recorded}.
 * @param {object} o
 */
export async function runJob({ task, dir, settings, env, client, print, spawn = spawnChild, stop = null, limitMs = RUN_LIMIT_MS }) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aimiru-take-'));
  const lastFile = path.join(tmp, 'last-message.txt');
  const progress = createProgress({
    print: (line) => print(printable(line)),
    // A note is never kept for later: one sent late tells the person nothing.
    send: (summary) => client.record({ action_id: null, outcome: 'partial', task_id: task.id, summary }, { spoolOnFailure: false, timeoutMs: 3_000 }),
  });
  let refusals = null;
  let failure = null;
  let stopped = false;
  let tooLong = false;
  let stderrTail = '';
  let child;
  try {
    child = spawn(codexBinOf(env), execArgs({ dir, lastMessageFile: lastFile }), {
      cwd: dir,
      // Each check in this run names the job (ADR-0157); nothing else changes for Codex.
      env: { ...env, AIMIRU_TASK_ID: task.id },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch {
    child = null;
  }
  const ended = new Promise((resolve) => {
    if (!child) {
      resolve({ code: null, signal: null, error: true });
      return;
    }
    child.on('error', () => resolve({ code: null, signal: null, error: true }));
    child.on('close', (code, signal) => resolve({ code, signal, error: false }));
  });
  if (child) {
    child.stdin.on('error', () => {});
    child.stdin.end(jobPrompt(task));
    child.stderr.on('data', (d) => {
      stderrTail = (stderrTail + d.toString('utf8')).slice(-4_000);
    });
    const lines = readline.createInterface({ input: child.stdout });
    lines.on('line', (line) => {
      let ev;
      try {
        ev = JSON.parse(line);
      } catch {
        return;
      }
      if (ev?.type === 'thread.started' && typeof ev.thread_id === 'string' && !refusals) {
        refusals = followRefusals({ codexHome: settings.codexHome, sessionId: ev.thread_id, onRefusal: (text) => print(printable(text)) });
      }
      if (ev?.type === 'turn.failed') failure = String(ev.error?.message ?? '') || failure;
      if (ev?.type === 'error' && !failure) failure = String(ev.message ?? '') || null;
      const note = noteForEvent(ev, { dir });
      if (note) progress.note(note);
    });
  }
  const onStop = () => {
    stopped = true;
    // A terminal's Ctrl+C reaches Codex too; anything else is passed on.
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
  refusals?.stop();
  await progress.close();
  let last = '';
  try {
    last = fs.readFileSync(lastFile, 'utf8').trim();
  } catch {
    last = '';
  }
  fs.rmSync(tmp, { recursive: true, force: true });

  const finished = !end.error && end.code === 0 && !failure && !stopped && !tooLong;
  const outcome = finished ? 'completed' : 'failed';
  let result;
  let said;
  if (finished) {
    result = last || 'Codex finished without a summary.';
    said = JOB_WORDS.takeDone;
  } else if (tooLong) {
    result = `Codex was still working after ${Math.round(limitMs / 60_000)} minutes, so the run was stopped.`;
    said = JOB_WORDS.takeTooLong(Math.round(limitMs / 60_000));
  } else if (stopped) {
    result = 'The person stopped Codex before it finished.';
    said = JOB_WORDS.takeStopped;
  } else {
    // Codex's own event says why; what it printed on stderr stays on this terminal (security review).
    const why = failure || (end.error ? 'Codex could not start.' : 'Codex ended with an error before it finished.');
    result = last ? `${why}\n\n${last}` : why;
    said = JOB_WORDS.takeFailed;
    for (const l of stderrTail.split('\n').map((x) => printable(x)).filter(Boolean).slice(-5)) print(l);
  }
  // Keys and cards out, then email addresses and phone numbers (legal, 30 Oct, item 7), before it is sent or kept to send.
  result = truncate(redactContacts(redactSecrets(result)), RESULT_MAX);
  const firstLine = oneLine(result.split('\n').find((l) => l.trim()) ?? '', 200);
  const r = await client.record(
    {
      action_id: null,
      outcome,
      task_id: task.id,
      result,
      summary: `${finished ? 'Codex finished the job' : 'Codex did not finish the job'}: ${firstLine}`,
      // One key per job: a record sent again from the spool never ends the job twice.
      idempotency_key: `cx_take_${sha256Hex(task.id).slice(0, 40)}`,
    },
    { timeoutMs: 10_000 },
  );
  print(said);
  if (finished && firstLine) print(firstLine);
  if (!r.ok) print(JOB_WORDS.takeResultLater);
  return { outcome, result, recorded: r.ok, spooled: r.spooled === true, stopped };
}

/**
 * One look for a job, and its run. Resolves to {kind, code}: kind ran, nothing, paused, or fatal
 * (something waiting will not fix: not connected, not checked, not open, a bad folder, no Codex).
 */
async function takeOnce({ env, dir, print, spawn, stop, quiet = false, limitMs }) {
  const settings = loadSettings(env);
  if (!settings.token || !settings.baseUrl) {
    print(JOB_WORDS.takeNoKey(INSTALL));
    return { kind: 'fatal', code: 1 };
  }
  const ready = readyToTake(settings, { dir, env });
  if (!ready.ok) {
    print(NOT_READY[ready.why](ready));
    return { kind: 'fatal', code: 1 };
  }
  const client = makeClient(settings);
  // Never while paused: Aimiru's own answer first (a 423 at the take says the same).
  const pause = await client.pause({ timeoutMs: 5_000 });
  if (pause.ok && pause.data?.paused === true) {
    if (!quiet) print(JOB_WORDS.takePaused);
    return { kind: 'paused', code: 0 };
  }
  const taken = await client.takeTask({ timeoutMs: 10_000, withBudget: false });
  if (!taken.ok) {
    if (taken.kind === 'http' && taken.status === 423) {
      if (!quiet) print(JOB_WORDS.takePaused);
      return { kind: 'paused', code: 0 };
    }
    if (taken.kind === 'http' && (taken.status === 403 || taken.status === 404) && taken.fromSayso !== false) {
      print(JOB_WORDS.takeNotOpen);
      return { kind: 'fatal', code: 1 };
    }
    if (taken.kind === 'http' && taken.status === 401 && taken.fromSayso !== false) {
      print(taken.code === 'demo_ended' ? client.demoEndedText : JOB_WORDS.takeReconnect(INSTALL));
      return { kind: 'fatal', code: 1 };
    }
    // Under --watch, said once while Aimiru does not answer (take's loop), not at every look.
    if (!quiet) print(JOB_WORDS.takeUnreachable);
    return { kind: 'unreachable', code: 1 };
  }
  const task = taken.data?.task && typeof taken.data.task === 'object' ? taken.data.task : null;
  if (!task || !taskIdOf(task.id)) {
    if (!quiet) print(JOB_WORDS.takeNothing);
    return { kind: 'nothing', code: 0 };
  }
  // Only the person's own jobs, whole, run here; anything else goes back to Aimiru unrun, its words
  // never given to Codex (ADR-0157, beside Aimiru's own filter).
  if (!personsOwnJob(task)) {
    await client.record(
      { action_id: null, outcome: 'failed', task_id: task.id, result: notPersonsJob('Codex'), idempotency_key: `cx_take_${sha256Hex(task.id).slice(0, 40)}` },
      { timeoutMs: 10_000 },
    );
    print(JOB_WORDS.takeNotYours);
    return { kind: 'ran', code: 1 };
  }
  print(JOB_WORDS.taken(oneLine(task.description)));
  print(JOB_WORDS.takeWorking(printable(dir)));
  const run = await runJob({ task, dir, settings, env, client, print, spawn, stop, ...(limitMs ? { limitMs } : {}) });
  return { kind: 'ran', code: run.outcome === 'completed' ? 0 : 1, stopped: run.stopped };
}

/** Resolves after ms, or as soon as stop fires. */
function wait(ms, stop) {
  if (!stop) return sleep(ms);
  if (stop.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const t = setTimeout(done, ms);
    function done() {
      clearTimeout(t);
      stop.removeEventListener('abort', done);
      resolve();
    }
    stop.addEventListener('abort', done, { once: true });
  });
}

/**
 * aimiru-codex take [--watch] [--dir <folder>]. Resolves to the exit code: 0 for a job done, no job
 * or paused; 1 when a job did not finish or nothing could be taken.
 * @param {object} o
 * @param {object} [o.env] @param {string} [o.dir] @param {boolean} [o.watch]
 * @param {(s: string) => void} [o.print] @param {Function} [o.spawn] codex exec (tests)
 * @param {AbortSignal} [o.stop] Ctrl+C and the like (cli.mjs main) @param {number} [o.everyMs] --watch's wait
 */
export async function take(o = {}) {
  const env = o.env || process.env;
  const print = o.print || ((s) => process.stdout.write(`${s}\n`));
  const dir = path.resolve(o.dir || process.cwd());
  // Run by a person (security review): in a terminal of their own, not from inside an agent or a
  // script, and in a project's folder, never the home folder or above it.
  const terminal = o.terminal ?? Boolean(process.stdin.isTTY && process.stdout.isTTY);
  if (!terminal || env.CLAUDECODE || env.CODEX_THREAD_ID) {
    print(JOB_WORDS.takeNotPerson);
    return 1;
  }
  const home = path.resolve(env.HOME || os.homedir());
  if (dir === home || home.startsWith(dir.endsWith(path.sep) ? dir : dir + path.sep)) {
    print(JOB_WORDS.takeHomeFolder(dir));
    return 1;
  }
  let isDir = false;
  try {
    isDir = fs.statSync(dir).isDirectory();
  } catch {
    isDir = false;
  }
  if (!isDir) {
    print(JOB_WORDS.takeNoFolder(printable(dir)));
    return 1;
  }
  if (!gitRootOf(dir)) {
    print(JOB_WORDS.takeNotGit('--dir'));
    return 1;
  }
  const bin = codexBinOf(env);
  const found = spawnSync(bin, ['--version'], { encoding: 'utf8', timeout: 5_000, stdio: ['ignore', 'pipe', 'ignore'], env });
  if (found.error || found.status !== 0) {
    print(JOB_WORDS.takeNoCodex);
    return 1;
  }
  const once = (quiet) => takeOnce({ env, dir, print, spawn: o.spawn, stop: o.stop, quiet, limitMs: o.limitMs });
  if (!o.watch) return (await once(false)).code;
  print(JOB_WORDS.watchStart);
  // Each state is said once as it begins, not at every look: paused, and Aimiru not answering.
  let said = null;
  while (!o.stop?.aborted) {
    const r = await once(true);
    if (r.kind === 'fatal') return r.code;
    if (r.stopped) break;
    if (r.kind === 'ran') {
      said = null;
      continue;
    }
    if (r.kind !== said && r.kind === 'paused') print(JOB_WORDS.watchPaused);
    if (r.kind !== said && r.kind === 'unreachable') print(JOB_WORDS.watchUnreachable);
    said = r.kind;
    await wait(o.everyMs ?? WATCH_EVERY_MS, o.stop);
  }
  print(JOB_WORDS.watchStopped);
  return 0;
}
