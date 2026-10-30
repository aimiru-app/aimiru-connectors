#!/usr/bin/env node
// Aimiru for Claude Code: UserPromptSubmit, when the person writes to Claude (ADR-0094, ADR-0157).
//
// A yes that came in after Claude Code stopped waiting for it: when this session has a question
// still waiting on this computer whose step can be quoted back, Aimiru is asked about at most 3 of
// them (GET /v1/approvals/{id}?wait=0, all within 2 s). A question whose step cannot be quoted is
// not asked about, since reading an answer uses it up (ADR-0094 review). For each the person allowed, Claude reads the exact step and its input,
// quoted as data, and that it may take exactly that step once if it still fits what the person asks
// now. The existing waiting question then lets that exact call through (pre-tool-use.mjs); a changed
// step is asked about again. Only in the person's own terminal (CLAUDE_CODE_ENTRYPOINT "cli").
//
// The person's brief (ADR-0157): when this session was given a brief (or asked for one and got no
// answer), at most once a minute, Aimiru is asked again with the version the session holds
// (GET /v1/brief, If-None-Match, within 1.2 s). 304, or the same version: nothing. A new version:
// Claude reads once that the person changed it, then the new brief exactly as Aimiru wrote it. An
// emptied brief: Claude reads once to set the old one aside. Never when Aimiru said the brief is
// not open to this agent (403, 404), and never the person's words on this computer, only the version.
// A brief that would push the context over Claude Code's 10,000 characters is left out whole, and
// the version is not kept, so a later prompt gives it when there is room (quality review).
//
// A brief missed at the start (CC6): when the session's start asked for the brief and had no answer
// from Aimiru (no answer in 2 s, no connection, a server error; session-start.mjs marks it), the
// session's first prompt asks at once, without waiting the minute, within the run's 2 s, and gives
// Claude the brief exactly as Aimiru wrote it. Once in a session at most: the ask is marked spent
// before it goes, so a later prompt, or a later start of the same session, never asks this way again
// (the minute rule above still does). Never while this computer holds the person's Pause: it waits
// for the first prompt after Resume.
//
// A job after /clear (ADR-0157): when /clear emptied this session's context while it held an open
// job the person gave (session-start.mjs marks it), the next prompt asks Aimiru for the job (get_task,
// within 1.2 s) and gives it to Claude once more, exactly as at the start; a job that ended meanwhile,
// or one Aimiru says is gone or not this agent's (404, 403), is forgotten, and no answer leaves it for
// the prompt after.
//
// With nothing to say, or no answer, it prints nothing: the person's message is never held up.

import { aimiruToolName } from './vendor/classify.mjs';
import { BRIEF_CHANGED, BRIEF_EMPTIED, lateYesNextMessage, taskContext } from './vendor/messages.mjs';
import { briefOf } from './vendor/aimiru-client.mjs';
import { fitContext, isInteractive, loadSettings, makeClient, openTaskOf, pausedHere, quotedStep, readStdinJson, stateStore, takesTasksHere, writeJson } from './lib/runtime.mjs';

/** How Claude names the Aimiru tools this plugin's own server gives it. */
const AIMIRU_TOOL_PREFIX = aimiruToolName('');
/** One look at a held job, inside the run's 2 s. */
const JOB_MS = 1_200;

/** The whole run, network included. hooks.json gives this hook 3 s. */
const BUDGET_MS = 2_000;

/** The least time between two looks at the person's brief in one session (ADR-0157). */
const BRIEF_EVERY_MS = 60_000;
/** One look at the brief, inside the run's 2 s. */
const BRIEF_MS = 1_200;

/** Whether this session's brief is due a look: it holds one (or none came), and a minute has passed. */
function briefDue(held, now) {
  if (!held || held.state === 'closed') return false;
  return !(Number.isFinite(held.at) && now - held.at < BRIEF_EVERY_MS && now >= held.at - 60_000);
}

/** Whether this session's start missed the brief and the one ask at a prompt is not spent yet (CC6). */
function briefOwed(held) {
  return Boolean(held && held.state === 'none' && held.missed === true && held.caught_up !== true);
}

/**
 * Asks Aimiru whether the person's brief changed since this session was given it: {b, line}, b as
 * briefOf reads the answer and line what Claude reads about it, or null.
 */
async function briefNow(client, held, timeoutMs = BRIEF_MS) {
  const r = await client.brief({ timeoutMs, ifNoneMatch: held.version }).catch(() => null);
  const b = briefOf(r);
  if (b.state === 'given' && b.version !== held.version) return { b, line: held.state === 'given' ? `${BRIEF_CHANGED}\n\n${b.text}` : b.text };
  if (b.state === 'empty' && held.state === 'given') return { b, line: BRIEF_EMPTIED };
  return { b, line: null };
}

/**
 * Keeps what this session now holds of the brief (its version, never the words) and when Aimiru was
 * asked. A changed brief left out for room keeps the old version, so a later prompt gives it.
 */
function keepBrief(store, session, held, { b, line }, given) {
  const now = Date.now();
  if (line && !given) store.putSessionBrief(session, { ...held, at: now });
  else if (b.state === 'given' || b.state === 'empty') store.putSessionBrief(session, { state: b.state, version: b.version, at: now });
  else if (b.state === 'closed') store.putSessionBrief(session, { state: 'closed', version: held.version, at: now });
  else store.putSessionBrief(session, { ...held, at: now });
}

/**
 * The last start's status says its brief was missed (CC6): now it says the brief came with the
 * person's message, its version and how many lines, never its words. A later start that got its own
 * brief is left as it is.
 */
function noteBriefAtPrompt(store, b) {
  const status = store.readStatus();
  if (!status || typeof status !== 'object' || status.brief?.missed !== true) return;
  store.writeStatus({ ...status, brief: { state: 'given', version: b.version, count: b.count, at_prompt: true, at: new Date().toISOString() } });
}

/**
 * The held job's context once more, or null. Forgets a job that ended, or one Aimiru says is gone or
 * not this agent's (404, 403: its checks then name no job); keeps the mark when no answer came.
 */
async function jobAgain(client, store, session, taskId) {
  const r = await client.getTask(taskId, { timeoutMs: JOB_MS }).catch(() => null);
  if (!r?.ok) {
    if (r?.kind === 'http' && (r.status === 403 || r.status === 404) && r.fromAimiru !== false) {
      store.clearRegive(session);
      store.clearSessionTask(session, taskId);
    }
    return null;
  }
  store.clearRegive(session);
  const task = openTaskOf(r, takesTasksHere());
  if (!task) {
    store.clearSessionTask(session, taskId);
    return null;
  }
  return taskContext(task, { recordTool: `${AIMIRU_TOOL_PREFIX}record`, reportTool: `${AIMIRU_TOOL_PREFIX}report_cant`, progress: true });
}

async function main() {
  const begun = Date.now();
  let input = {};
  try {
    input = await readStdinJson();
  } catch {
    return;
  }
  const session = typeof input?.session_id === 'string' && input.session_id ? input.session_id : null;
  if (!session) return;
  const settings = loadSettings();
  if (!settings.token || !settings.baseUrl) return;
  const store = stateStore(settings.dataDir, { secret: settings.token });
  // Only this session's own questions, still open here, whose step can be quoted back, and not one
  // whose yes already woke Claude (watch.mjs, CN10): each yes is offered once.
  const waiting = isInteractive() ? store.offerable({ session }).filter((e) => !store.woken(e.exceptionId)).slice(0, 3) : [];
  let held = store.sessionBrief(session);
  // A brief the start missed (CC6), asked for now, never while paused. Marked spent before it goes,
  // so it is never asked this way twice in the session, even if this run is cut off.
  const owed = briefOwed(held) && !pausedHere(settings);
  if (owed) {
    held = { ...held, missed: false, caught_up: true };
    store.putSessionBrief(session, held);
  }
  const lookAtBrief = owed || briefDue(held, Date.now());
  const heldJob = store.regiveDue(session) ? store.sessionTask(session) : null;
  if (store.regiveDue(session) && !heldJob) store.clearRegive(session);
  if (!waiting.length && !lookAtBrief && !heldJob) return;
  const client = makeClient(settings, { spool: false });
  if (!client.configured) return;
  const started = Date.now();
  const [jobLine, briefSeen, answers] = await Promise.all([
    heldJob ? jobAgain(client, store, session, heldJob).catch(() => null) : Promise.resolve(null),
    lookAtBrief ? briefNow(client, held, owed ? Math.max(250, BUDGET_MS - (Date.now() - begun)) : BRIEF_MS).catch(() => null) : Promise.resolve(null),
    Promise.all(
      waiting.map((w) => client.approvalsWait(w.exceptionId, 0, { timeoutMs: Math.max(250, BUDGET_MS - (Date.now() - started)) }).catch(() => null)),
    ),
  ]);
  const late = [];
  answers.forEach((r, i) => {
    const d = r?.ok ? r.data || {} : null;
    if (!d || d.status !== 'allowed') return;
    const p = store.pendingFor(waiting[i].exceptionId);
    const call = p?.call;
    if (quotedStep(call) === null) return;
    late.push(lateYesNextMessage(call.tool_name, call.tool_input));
  });
  // The job and a late yes come first; the brief only while the whole fits Claude Code's cap.
  const context = fitContext((withBrief) => [jobLine, withBrief ? briefSeen?.line : null, ...late].filter(Boolean).join('\n\n'));
  if (briefSeen) keepBrief(store, session, held, briefSeen, context.brief);
  // For the doctor: the brief the start missed came with the person's message (counts, never words).
  if (owed && briefSeen?.line && briefSeen.b.state === 'given' && context.brief) noteBriefAtPrompt(store, briefSeen.b);
  if (!context.text) return;
  writeJson({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: context.text } });
}

main().then(
  () => process.exit(0),
  () => process.exit(0),
);
