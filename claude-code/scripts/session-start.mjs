#!/usr/bin/env node
// Aimiru for Claude Code: SessionStart.
//
// Tells Aimiru where it runs (POST /v1/heartbeat) so the tier Aimiru shows is the one this
// connector delivers (ADR-0007): Enforced only on Claude Code 2.1.295 or later with hooks on.
// Also sends spooled records, and gives Claude one paragraph of context so it does not route
// around a "no". When the person paused this agent (or everything), says so at once: the shared
// client remembers it and every step is refused until Aimiru says otherwise (ADR-0022).
//
// The person's brief (ADR-0157, contract C2): asked for beside the heartbeat (GET /v1/brief, at most
// 2 s, so it never delays the start or pushes out the paused notice) and given to Claude right after
// the usual paragraph, exactly as Aimiru wrote it, never to the person. The session keeps the
// brief's version (never its words), so the next prompt can say when the person changed it
// (user-prompt-submit.mjs). 403, 404, 423, an error, a time limit or a malformed answer: no brief.
// One that missed (no answer in 2 s, no connection, a server error) is marked, and the session's first
// prompt asks once more and gives it then (CC6), so a cold server never costs a session its brief.
// A brief that would push the context over Claude Code's 10,000 characters (with a job, or a late
// yes) is left out whole, and the next prompt gives it when there is room (quality review).
//
// The person's job (ADR-0157, which follows ADR-0043 and ADR-0145): a new, resumed or cleared
// session the person starts in their own terminal takes the job they gave Claude Code in Aimiru
// (POST /v1/tasks/take) and gives it to Claude as session context. Aimiru decides whether there is
// one: its door, the person's grant for this agent, and this connector's version in the heartbeat;
// a refusal is quiet. Never in claude -p or the SDK, never after a compaction (the same work going
// on), never while paused. AIMIRU_TAKE_TASKS unset or 1 leaves it on, and any
// other value turns it off; the heartbeat says which (environment.accepts_tasks). The session keeps
// the job's id, signed, so each of its checks names the job until Claude records it done or not
// done (post-tool-use.mjs). Whether Claude may call take_task itself is unchanged: only with
// AIMIRU_TAKE_TASKS=1 (pre-tool-use.mjs).
//
// Reads decided on this computer (ADR-0095): refreshes the snapshot (GET /v1/me) and sends the
// reads decided here that a stopped or crashed session left behind.
//
// A late yes (ADR-0094): in the person's own terminal, a new, resumed, cleared or forked session
// asks Aimiru (POST /v1/approvals/late) about this computer's own questions that Claude Code stopped
// waiting on and that are still open here, only those whose step it can quote back (Aimiru offers a
// yes only within an hour of the answer). Each yes is offered once: the person reads "Your yes for
// ... came in after Claude Code moved on. Run it again?", and Claude reads the exact step and its
// input, quoted as data, to take once if the person says so. Not after a compaction.
// Prints no secret: never the key, never the Aimiru address.

import { aimiruToolName } from './vendor/classify.mjs';
import { sessionSandbox } from './lib/sandbox.mjs';
import { sessionBaselineFor } from './vendor/newness.mjs';
import { flushLocal } from './vendor/local.mjs';
import { ackOnce, pauseHoldOn } from './vendor/pause-watch.mjs';
import { briefOf, isDemoEnded, personsOwnJob, projectOf, sha256Hex } from './vendor/aimiru-client.mjs';
import { AGENT_CONTEXT, MESSAGES, TASKS_ASKED_AT_START, TASKS_OFF_HERE, lateYesContext, lateYesQuestion, notPersonsJob, resultsContext, taskContext } from './vendor/messages.mjs';
import {
  CONNECTOR,
  MIN_ENFORCED_VERSION,
  AGENT_LABEL,
  PAUSE_HOLDS,
  VERSION,
  briefMissed,
  detectClaudeCodeVersion,
  isInteractive,
  loadSettings,
  localStateFor,
  makeClient,
  pluginInstallSource,
  quotedStep,
  readStdinJson,
  refreshSnapshot,
  skillVersion,
  stateStore,
  supportsBlockOnFailure,
  takesJobsHere,
  takesTasksHere,
  watchFor,
  writeJson,
  fitContext,
} from './lib/runtime.mjs';

/** How Claude names the Aimiru tools this plugin's own server gives it (.claude-plugin/plugin.json). */
const AIMIRU_TOOL_PREFIX = aimiruToolName('');

/** Sessions that start new work: a compaction carries on the same work, so it takes no task. */
const TAKING_SOURCES = new Set(['startup', 'resume', 'clear']);

/** Sessions a late yes is offered at (ADR-0094): the person came back to Claude Code; not a compaction. */
const LATE_SOURCES = new Set(['startup', 'resume', 'clear', 'fork']);
/** At most this many late yeses are offered at one start. */
const LATE_MAX = 3;

/** The whole run stays inside hooks.json's 10 seconds. */
const BUDGET_MS = 9_000;

/** The most the person's brief may take (ADR-0157): asked beside the heartbeat, which takes up to 4 s. */
const BRIEF_MS = 2_000;

function cap(s) {
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
}

/**
 * What the person reads at session start while paused: the hold's own line when steps are held
 * (ADR-0142), else Aimiru's sentence, as before (ADR-0022).
 */
function pausedLine(explain) {
  return pauseHoldOn(process.env, PAUSE_HOLDS) ? MESSAGES.pauseHolding : MESSAGES.pausedNotice(explain);
}

async function main() {
  const started = Date.now();
  let input = {};
  try {
    input = await readStdinJson();
  } catch {
    input = {};
  }
  const settings = loadSettings();
  const store = stateStore(settings.dataDir, { secret: settings.token });
  const client = makeClient(settings);

  if (!client.configured) {
    store.writeStatus({ ts: new Date().toISOString(), configured: false, connector_version: VERSION });
    writeJson({ systemMessage: MESSAGES.setupNeeded });
    return;
  }

  // What this session begins with (ADR-0090 review): the commit each repository of the project is
  // on, kept once per session, so a program the agent writes and commits later still counts as new.
  if (input.session_id) {
    try {
      if (!store.sessionBaseline(input.session_id)) store.putSessionBaseline(input.session_id, sessionBaselineFor(settings.projectDir || input.cwd || null, { budgetMs: 1_500 }));
    } catch {
      // newness then counts from the commit the project is on when a program runs
    }
  }

  const clientVersion = detectClaudeCodeVersion(process.env, { allowSpawn: true, timeoutMs: 2_000 });
  let sandbox = { on: false, state: 'unknown' };
  try {
    sandbox = sessionSandbox({ projectDir: settings.projectDir || input.cwd || null });
  } catch {
    sandbox = { on: false, state: 'unknown' };
  }
  const onFailureBlock = supportsBlockOnFailure(clientVersion);
  const environment = {
    on_failure_block: onFailureBlock,
    hooks_enabled: true,
    cloud_workers: process.env.CLAUDE_CODE_REMOTE === 'true',
    remote: process.env.CLAUDE_CODE_REMOTE === 'true',
    entrypoint: process.env.CLAUDE_CODE_ENTRYPOINT || null,
    permission_mode: input.permission_mode || null,
    session_source: input.source || null,
    platform: process.platform,
    node: process.versions.node,
    // The person's jobs land here by themselves: a session they start takes one (ADR-0157).
    accepts_tasks: takesJobsHere(),
    // Claude Code's sandbox for this session's shell commands, as the settings say (ADR-0090):
    // on, off or unknown. With it on, programs the agent writes run as local work.
    sandbox: sandbox.state,
  };
  // The Aimiru routine this plugin carries (skills/aimiru/SKILL.md), so the person sees it (ADR-0037).
  const routine = skillVersion(settings);
  const local = localStateFor(settings, client);
  // This computer's own questions still open here, for a late yes (ADR-0094): only in the person's
  // own terminal, only as they come back to it, and only those whose step can be quoted back, since
  // Aimiru uses up each yes it offers (ADR-0094 review).
  const lateIds = LATE_SOURCES.has(String(input.source || 'startup')) && isInteractive() ? store.offerable().slice(0, 20).map((e) => e.exceptionId) : [];
  const projectDir = settings.projectDir || input.cwd || null;
  // The heartbeat, the snapshot, the reads decided here, the late yeses and the person's brief, side
  // by side (each ≤ 4 s; the brief ≤ 2 s, so it never adds to the start).
  const [hb, , , late, briefAnswer] = await Promise.all([
    client.heartbeat(
      { connector: CONNECTOR, version: VERSION, client_version: clientVersion, install_source: pluginInstallSource(), environment, skill_version: routine },
      { timeoutMs: 4_000 },
    ),
    refreshSnapshot(client, local, store, input.session_id, { timeoutMs: 3_000 }).catch(() => null),
    flushLocal(client, local, { budgetMs: 2_000, force: true }).catch(() => null),
    lateIds.length ? client.lateAnswers({ project: projectOf(projectDir), exceptionIds: lateIds }, { timeoutMs: 3_000 }).catch(() => null) : Promise.resolve(null),
    client.brief({ timeoutMs: BRIEF_MS }).catch(() => null),
  ]);
  const lateOffers = lateYesOffers(late, store);
  // What Aimiru gave of the person's brief (kept below, once it is known to fit the context).
  const brief = briefOf(briefAnswer);
  // No answer from Aimiru in time (a cold server, no connection, a server error): the session's first
  // prompt asks once more and gives it then (CC6). The budgets here stay as they are.
  const missed = brief.state === 'none' && briefMissed(briefAnswer);

  const tier = hb.ok ? hb.data?.tier ?? null : null;
  const reason = hb.ok ? hb.data?.reason ?? null : null;
  // The person paused this agent (or everything): the client remembers it, and every step is held
  // until Aimiru says otherwise (ADR-0142; refused with the hold switched off, ADR-0022). Say so as
  // the session starts, and confirm the pause: this agent is held from now (learned_by watch).
  const paused = hb.ok && hb.data?.paused === true;
  const watch = watchFor(settings);
  watch.extendLease();
  if (paused) {
    try {
      await ackOnce(client, watch, { learnedBy: 'watch', local, timeoutMs: Math.max(250, Math.min(2_000, BUDGET_MS - (Date.now() - started) - 1_500)) });
    } catch {
      // the watcher confirms it at its first read
    }
  }

  // The job the person gave Claude Code, taken while the spooled records go out (ADR-0157): only in a
  // session the person started in their own terminal, never in claude -p or the SDK. Aimiru refuses
  // it while paused, and nothing is taken when Aimiru did not answer the heartbeat.
  const takeMs = Math.min(3_000, BUDGET_MS - (Date.now() - started) - 250);
  const jobsHere = takesJobsHere();
  // Aimiru's own word on this agent's take switch, when its heartbeat answer gives it (ADR-0152:
  // off until the person sends this agent its first job): no request while it says no.
  const switchedOff = hb.ok && hb.data?.takes_jobs === false;
  // After /clear (ADR-0157, agent-experience review; the integrator: no new hook): a session that
  // still holds an open job takes no second one, and its next prompt gives the job to Claude once more
  // (user-prompt-submit.mjs). A /clear that starts the session under a new id leaves the job behind:
  // a known gap, written down in ADR-0157.
  const handOffsHere = takesTasksHere();
  const heldId = String(input.source || '') === 'clear' && input.session_id ? store.sessionTask(input.session_id) : null;
  if (heldId) store.markRegive(input.session_id);
  const take = !heldId && hb.ok && !paused && jobsHere && !switchedOff && isInteractive() && TAKING_SOURCES.has(String(input.source || 'startup')) && takeMs >= 500;
  // Claude Code's own model time is the person's Claude plan, and this start has nowhere safe to
  // hand a key, so a task's budget is never asked for here (ADR-0055): the budget ends unused.
  const [, taken] = await Promise.all([
    client.flushSpool({ budgetMs: 2_000, max: 25 }),
    take ? client.takeTask({ timeoutMs: takeMs, withBudget: false }) : Promise.resolve(null),
  ]);
  const offered = taken?.ok && taken.data?.task && typeof taken.data.task === 'object' ? taken.data.task : null;
  // Beside Aimiru's own filter (ADR-0157): unless the person turned work handed between agents on
  // here (AIMIRU_TAKE_TASKS=1), only the person's own job, whole, reaches Claude. Anything else goes
  // straight back to Aimiru as not done, its words unread by Claude, and the person sees nothing new.
  const task = offered && (handOffsHere || personsOwnJob(offered)) ? offered : null;
  if (offered && task !== offered) {
    await client
      .record(
        { action_id: null, outcome: 'failed', task_id: String(offered.id ?? ''), result: notPersonsJob(AGENT_LABEL), idempotency_key: `cc_back_${sha256Hex(String(offered.id ?? '')).slice(0, 40)}` },
        { timeoutMs: Math.max(250, Math.min(2_000, BUDGET_MS - (Date.now() - started) - 500)) },
      )
      .catch(() => null);
  }
  // What came of work Claude Code handed on, given back once with the take (ADR-0060): only where
  // work handed between agents is on.
  const results = handOffsHere && taken?.ok && Array.isArray(taken.data?.results) ? taken.data.results : [];
  // Each check in this session names the job until Claude records it done or not done (ADR-0157).
  if (task && input.session_id) store.putSessionTask(input.session_id, String(task.id ?? ''));

  // Aimiru's own server tells Claude to call take_task as a session starts; this session start just
  // did (a second call would take a second task and ask the person to allow the tool), and with task
  // taking off here Claude may not take one at all (pre-tool-use.mjs refuses it).
  const routineNote = taken?.ok ? TASKS_ASKED_AT_START : !takesTasksHere() ? TASKS_OFF_HERE : null;
  // What Claude reads. The person's brief goes right after the usual paragraph, exactly as Aimiru
  // wrote it (ADR-0157), only while the whole stays within Claude Code's cap for one context: the job
  // and a late yes come first, and a brief left out comes at the next prompt (quality review).
  const context = fitContext((withBrief) =>
    [
      AGENT_CONTEXT,
      withBrief && brief.state === 'given' ? brief.text : null,
      task
        ? taskContext(task, { recordTool: `${AIMIRU_TOOL_PREFIX}record`, reportTool: `${AIMIRU_TOOL_PREFIX}report_cant`, progress: true })
        : null,
      resultsContext(results),
      routineNote,
      ...lateOffers.map((o) => o.context),
    ]
      .filter(Boolean)
      .join('\n\n'),
  );
  const briefGiven = brief.state !== 'given' || context.brief;
  // The session keeps the brief's version, never its words; a brief left out is kept as none, so the
  // next prompt asks again and gives it; a missed one is marked, so the first prompt asks at once.
  if (input.session_id) {
    store.putSessionBrief(input.session_id, briefGiven ? { state: brief.state, version: brief.version, at: Date.now(), missed } : { state: 'none', version: null, at: Date.now() });
  }

  // For the doctor: whether jobs are open to this agent, as the last take Aimiru answered said.
  const prior = store.readStatus();
  const jobs = !jobsHere
    ? 'off'
    : taken?.ok
      ? 'open'
      : taken && taken.kind === 'http' && (taken.status === 403 || taken.status === 404) && taken.fromAimiru !== false
        ? 'not_open'
        : (prior?.jobs ?? null);
  store.writeStatus({
    ts: new Date().toISOString(),
    configured: true,
    connector_version: VERSION,
    client_version: clientVersion,
    on_failure_block: onFailureBlock,
    reachable: hb.ok,
    error: hb.ok ? null : hb.code || hb.kind,
    http_status: hb.status || null,
    tier,
    reason,
    paused,
    skill_version: routine,
    routine_version: hb.ok ? hb.data?.routine_version ?? null : null,
    accepts_tasks: jobsHere,
    jobs,
    // What this session was given of the person's brief: how many lines and which version, never words.
    brief: briefGiven
      ? { state: brief.state, version: brief.version, count: brief.count, ...(missed ? { missed: true } : {}), at: new Date().toISOString() }
      : { state: 'none', version: null, count: 0, left_out: 'no_room', at: new Date().toISOString() },
    // Which task this session was given, never its words.
    ...(task ? { last_task: { id: String(task.id ?? ''), from_agent: task.from_agent ?? null, at: new Date().toISOString() } } : {}),
    pending_records: client.spool ? client.spool.size() : 0,
  });

  let systemMessage = null;
  // A 401 page from something on the way (a login wall) is not Aimiru refusing the key.
  // A demo whose time is over says so, with the line that removes the plugin (wave 10, snag 12).
  if (isDemoEnded(hb)) systemMessage = client.demoEndedText;
  else if (!hb.ok && hb.status === 401 && hb.fromAimiru !== false) systemMessage = MESSAGES.reconnect(AGENT_LABEL);
  else if (!onFailureBlock) systemMessage = MESSAGES.updateNeeded(MIN_ENFORCED_VERSION);
  else if (!hb.ok) systemMessage = client.pausedLocally() ? pausedLine(client.pausedLocally().explain) : MESSAGES.unreachableNow;
  else if (paused) systemMessage = pausedLine(hb.data?.explain);
  else if (tier && tier !== 'enforced') systemMessage = MESSAGES.tierNotice(cap(tier), reason);

  // The person sees that this session was given a task; Claude reads the task itself.
  if (task) systemMessage = [systemMessage, task.from_person === true ? MESSAGES.jobTaken : MESSAGES.taskTaken(task.from_agent)].filter(Boolean).join(' ');
  if (results.length) systemMessage = [systemMessage, MESSAGES.resultsBack(results.length)].filter(Boolean).join(' ');
  // A yes that came in after Claude Code stopped: the person is asked whether to run it again.
  if (lateOffers.length) systemMessage = [systemMessage, ...lateOffers.map((o) => o.question)].filter(Boolean).join(' ');

  writeJson({
    ...(systemMessage ? { systemMessage } : {}),
    hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: context.text },
  });
}

/**
 * The late yeses Aimiru offered (POST /v1/approvals/late), for this computer's own waiting
 * questions only: [{question, context}], at most 3. Only quotable questions were sent (offerable);
 * one whose file went away meanwhile is not offered, and its yes still answers an identical retry
 * within the hour (ADR-0035).
 */
function lateYesOffers(late, store) {
  if (!late?.ok || !Array.isArray(late.data?.answers)) return [];
  const offers = [];
  for (const a of late.data.answers) {
    if (offers.length >= LATE_MAX) break;
    if (!a || typeof a.exception_id !== 'string') continue;
    const p = store.pendingFor(a.exception_id);
    const call = p?.call;
    if (quotedStep(call) === null) continue;
    const description = typeof a.description === 'string' && a.description ? a.description : call.description;
    offers.push({ question: lateYesQuestion(description, AGENT_LABEL), context: lateYesContext(call.tool_name, call.tool_input) });
  }
  return offers;
}

main().then(
  () => process.exit(0),
  () => process.exit(0),
);
