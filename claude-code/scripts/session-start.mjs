#!/usr/bin/env node
// Aimiru for Claude Code: SessionStart.
//
// Tells Aimiru where it runs (POST /v1/heartbeat) so the tier Aimiru shows is the one this
// connector delivers (ADR-0007): Enforced only on Claude Code 2.1.295 or later with hooks on.
// Also sends spooled records, and gives Claude one paragraph of context so it does not route
// around a "no". When the person paused this agent (or everything), says so at once: the shared
// client remembers it and every step is refused until Aimiru says otherwise (ADR-0022).
//
// Hand-offs without a tap (ADR-0043), only where the person turned them on (AIMIRU_TAKE_TASKS=1, or
// SAYSO_TAKE_TASKS=1; ADR-0145: hand-offs are not in the wedge, so they are off by default): the
// heartbeat then says this agent takes tasks from Aimiru by itself (environment.accepts_tasks), and a
// new, resumed or cleared session takes the oldest task waiting (POST /v1/tasks/take) and gives it to
// Claude as session context, with the other agent's words quoted as data. Not after a compaction
// (that is the same work going on). Off, the heartbeat says so, nothing is taken, and Claude reads
// that work handed between agents is off here.
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

import { saysoToolName } from './vendor/classify.mjs';
import { sessionSandbox } from './lib/sandbox.mjs';
import { sessionBaselineFor } from './vendor/newness.mjs';
import { flushLocal } from './vendor/local.mjs';
import { ackOnce, pauseHoldOn } from './vendor/pause-watch.mjs';
import { isDemoEnded, projectOf } from './vendor/sayso-client.mjs';
import { AGENT_CONTEXT, MESSAGES, TASKS_ASKED_AT_START, TASKS_OFF_HERE, lateYesContext, lateYesQuestion, resultsContext, taskContext } from './vendor/messages.mjs';
import {
  CONNECTOR,
  MIN_ENFORCED_VERSION,
  AGENT_LABEL,
  PAUSE_HOLDS,
  VERSION,
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
  takesTasksHere,
  watchFor,
  writeJson,
} from './lib/runtime.mjs';

/** How Claude names the Aimiru tools this plugin's own server gives it (.claude-plugin/plugin.json). */
const SAYSO_TOOL_PREFIX = saysoToolName('');

/** Sessions that start new work: a compaction carries on the same work, so it takes no task. */
const TAKING_SOURCES = new Set(['startup', 'resume', 'clear']);

/** Sessions a late yes is offered at (ADR-0094): the person came back to Claude Code; not a compaction. */
const LATE_SOURCES = new Set(['startup', 'resume', 'clear', 'fork']);
/** At most this many late yeses are offered at one start. */
const LATE_MAX = 3;

/** The whole run stays inside hooks.json's 10 seconds. */
const BUDGET_MS = 9_000;

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
    // Hand-offs land here by themselves: this script takes them as a session starts (ADR-0043).
    accepts_tasks: takesTasksHere(),
    // Claude Code's sandbox for this session's shell commands, as the settings say (ADR-0090):
    // on, off or unknown. With it on, programs the agent writes run as local work.
    sandbox: sandbox.state,
  };
  // The Aimiru routine this plugin carries (skills/sayso/SKILL.md), so the person sees it (ADR-0037).
  const routine = skillVersion(settings);
  const local = localStateFor(settings, client);
  // This computer's own questions still open here, for a late yes (ADR-0094): only in the person's
  // own terminal, only as they come back to it, and only those whose step can be quoted back, since
  // Aimiru uses up each yes it offers (ADR-0094 review).
  const lateIds = LATE_SOURCES.has(String(input.source || 'startup')) && isInteractive() ? store.offerable().slice(0, 20).map((e) => e.exceptionId) : [];
  const projectDir = settings.projectDir || input.cwd || null;
  // The heartbeat, the snapshot, the reads decided here and the late yeses, side by side (each ≤ 4 s).
  const [hb, , , late] = await Promise.all([
    client.heartbeat(
      { connector: CONNECTOR, version: VERSION, client_version: clientVersion, install_source: pluginInstallSource(), environment, skill_version: routine },
      { timeoutMs: 4_000 },
    ),
    refreshSnapshot(client, local, store, input.session_id, { timeoutMs: 3_000 }).catch(() => null),
    flushLocal(client, local, { budgetMs: 2_000, force: true }).catch(() => null),
    lateIds.length ? client.lateAnswers({ project: projectOf(projectDir), exceptionIds: lateIds }, { timeoutMs: 3_000 }).catch(() => null) : Promise.resolve(null),
  ]);
  const lateOffers = lateYesOffers(late, store);

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

  // A task another agent handed to Claude Code, taken while the spooled records go out. Aimiru
  // refuses it while paused, and nothing is taken when Aimiru did not answer the heartbeat.
  const takeMs = Math.min(3_000, BUDGET_MS - (Date.now() - started) - 250);
  const take = hb.ok && !paused && takesTasksHere() && TAKING_SOURCES.has(String(input.source || 'startup')) && takeMs >= 500;
  // Claude Code's own model time is the person's Claude plan, and this start has nowhere safe to
  // hand a key, so a task's budget is never asked for here (ADR-0055): the budget ends unused.
  const [, taken] = await Promise.all([
    client.flushSpool({ budgetMs: 2_000, max: 25 }),
    take ? client.takeTask({ timeoutMs: takeMs, withBudget: false }) : Promise.resolve(null),
  ]);
  const task = taken?.ok && taken.data?.task && typeof taken.data.task === 'object' ? taken.data.task : null;
  // What came of work Claude Code handed on, given back once with the take (ADR-0060).
  const results = taken?.ok && Array.isArray(taken.data?.results) ? taken.data.results : [];
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
    accepts_tasks: takesTasksHere(),
    // Which task this session was given, never its words.
    ...(task ? { last_task: { id: String(task.id ?? ''), from_agent: task.from_agent ?? null, at: new Date().toISOString() } } : {}),
    pending_records: client.spool ? client.spool.size() : 0,
  });

  let systemMessage = null;
  // A 401 page from something on the way (a login wall) is not Aimiru refusing the key.
  // A demo whose time is over says so, with the line that removes the plugin (wave 10, snag 12).
  if (isDemoEnded(hb)) systemMessage = client.demoEndedText;
  else if (!hb.ok && hb.status === 401 && hb.fromSayso !== false) systemMessage = MESSAGES.reconnect(AGENT_LABEL);
  else if (!onFailureBlock) systemMessage = MESSAGES.updateNeeded(MIN_ENFORCED_VERSION);
  else if (!hb.ok) systemMessage = client.pausedLocally() ? pausedLine(client.pausedLocally().explain) : MESSAGES.unreachableNow;
  else if (paused) systemMessage = pausedLine(hb.data?.explain);
  else if (tier && tier !== 'enforced') systemMessage = MESSAGES.tierNotice(cap(tier), reason);

  // The person sees that this session was given a task; Claude reads the task itself.
  if (task) systemMessage = [systemMessage, task.from_person === true ? MESSAGES.jobTaken : MESSAGES.taskTaken(task.from_agent)].filter(Boolean).join(' ');
  if (results.length) systemMessage = [systemMessage, MESSAGES.resultsBack(results.length)].filter(Boolean).join(' ');
  // A yes that came in after Claude Code stopped: the person is asked whether to run it again.
  if (lateOffers.length) systemMessage = [systemMessage, ...lateOffers.map((o) => o.question)].filter(Boolean).join(' ');
  // Aimiru's own server tells Claude to call take_task as a session starts; this session start just
  // did (a second call would take a second task and ask the person to allow the tool), and with task
  // taking off here Claude may not take one at all (pre-tool-use.mjs refuses it).
  const routineNote = !takesTasksHere() ? TASKS_OFF_HERE : taken?.ok ? TASKS_ASKED_AT_START : null;
  const additionalContext = [
    AGENT_CONTEXT,
    task ? taskContext(task, { recordTool: `${SAYSO_TOOL_PREFIX}record`, reportTool: `${SAYSO_TOOL_PREFIX}report_cant` }) : null,
    resultsContext(results),
    routineNote,
    ...lateOffers.map((o) => o.context),
  ]
    .filter(Boolean)
    .join('\n\n');

  writeJson({
    ...(systemMessage ? { systemMessage } : {}),
    hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext },
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
