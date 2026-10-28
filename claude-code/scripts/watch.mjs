#!/usr/bin/env node
// Aimiru for Claude Code: the Pause watcher (ADR-0142; CN9), started by the async UserPromptSubmit,
// PostToolUse and Stop hooks, so it never holds Claude Code up.
//
// While Claude Code works, it reads the Pause outside the step path, at most once every 3 s for this
// computer's whole agent (shared/pause-watch.mjs: one poll lock and one last read for every process
// of this data folder). On a new Pause it writes the pause memory and confirms it to Aimiru (POST
// /v1/pause/ack, learned_by watch), so Aimiru shows Claude Code as held within seconds, and the next
// step the check sees is held until Resume (pre-tool-use.mjs). It never wakes Claude for a Pause:
// that wake is dropped (Rohit's decision of 28 Oct, item 5), so no model turn is spent. A resume
// clears the memory and the snapshot, and asks for a fresh one.
//
// A later yes (ADR-0145, CN10), only with the wake switched on (WAKE_ON_YES, AIMIRU_WAKE_ON_YES=1):
// every 6 s it looks once at this session's open questions whose step can be quoted (GET
// /v1/approvals/{id}?wait=0, no waiting_s: a read, which the retry repeats). For a yes, it marks the
// question woken and exits 2 with the exact step on stderr; hooks.json runs it with asyncRewake, so
// Claude wakes and takes that step, which the waiting question lets through once. Not while paused,
// never for another session's question, and each yes once (user-prompt-submit.mjs skips it then).
// After a turn ends it waits for those questions up to 14 minutes, else 30 s.
//
// One watcher per session: a second one for the same session ends at once, unless the running one
// ends more than 30 s before it would (sessionWatchLock), and it hands over. Each hook event extends
// the lease (2 minutes); the watcher ends with the lease or its budget (140 s, 30 s after a turn).
// It prints nothing on stdout, and exits 0 unless it wakes Claude for a yes.

import { lateYesWake } from './vendor/messages.mjs';
import { watchLoop, yesBeforeLastPause } from './vendor/pause-watch.mjs';
import {
  WATCH_BUDGET_MS,
  WATCH_OPEN_QUESTIONS_MS,
  loadSettings,
  localStateFor,
  makeClient,
  quotedStep,
  readStdinJson,
  sessionWatchLock,
  stateStore,
  wakesOnYes,
  watchBudgetMs,
  watchFor,
} from './lib/runtime.mjs';

/** How often the watcher looks at this session's open questions (CN10). */
const LOOK_EVERY_MS = 6_000;

/**
 * The watcher's budget: 140 s, or 30 s after a turn; after a turn with the wake on and an open
 * question of this session, until the last of them ends, at most 14 minutes. A setting that shortens
 * the watcher (AIMIRU_WATCH_BUDGET_MS, tests) keeps it short.
 */
function budgetFor(event, store, session, wake, now = Date.now()) {
  const base = watchBudgetMs(event);
  if (event !== 'Stop' || !wake || watchBudgetMs('PostToolUse') < WATCH_BUDGET_MS) return base;
  const ends = store
    .offerable({ session })
    .map((e) => Date.parse(e.pending?.expiresAt ?? '') || (Number(e.pending?.ts) || now) + 15 * 60_000)
    .filter(Number.isFinite);
  if (!ends.length) return base;
  return Math.max(base, Math.min(WATCH_OPEN_QUESTIONS_MS, Math.max(...ends) - now));
}

async function main() {
  let input = {};
  try {
    input = await readStdinJson();
  } catch {
    input = {};
  }
  const settings = loadSettings();
  if (!settings.token || !settings.baseUrl) return 0;
  const client = makeClient(settings);
  if (!client.configured) return 0;
  const watch = watchFor(settings);
  watch.extendLease();
  const session = typeof input?.session_id === 'string' && input.session_id ? input.session_id : null;
  const store = stateStore(settings.dataDir, { secret: settings.token });
  const wake = wakesOnYes() && session !== null;
  const budgetMs = budgetFor(input?.hook_event_name, store, session, wake);
  const lock = sessionWatchLock(settings.dataDir, session ?? 'none');
  if (!lock.take(Date.now() + budgetMs)) return 0;
  // A Stop that waits for a yes keeps the lease as long as it waits.
  if (budgetMs > watchBudgetMs('Stop')) watch.extendLease(budgetMs);
  let lookedAt = 0;
  let woke = null;
  /** One look at this session's open questions, every 6 s: the first yes wakes Claude (CN10). */
  const lookForYes = async () => {
    if (!wake || Date.now() - lookedAt < LOOK_EVERY_MS) return null;
    lookedAt = Date.now();
    // Paused: the step would only be held, so the yes waits for the next look after Resume.
    if (client.pausedLocally()) return null;
    const open = store.offerable({ session }).filter((e) => !store.woken(e.exceptionId)).slice(0, 3);
    for (const e of open) {
      const r = await client.approvalsWait(e.exceptionId, 0, { timeoutMs: 2_000 });
      const d = r?.ok ? r.data || {} : null;
      if (!d || d.status !== 'allowed') continue;
      if (yesBeforeLastPause(watch, d.answered_at)) continue;
      const call = e.pending?.call;
      if (quotedStep(call) === null) continue;
      store.markWoken(e.exceptionId);
      woke = lateYesWake(call.tool_name, call.tool_input);
      return { stop: true };
    }
    return null;
  };
  try {
    const local = localStateFor(settings, client);
    await watchLoop(client, watch, { budgetMs, local, stop: () => !lock.mine(), onTick: lookForYes });
  } finally {
    lock.release();
  }
  if (woke) {
    // asyncRewake: exit 2 wakes Claude, with this on stderr as its reminder.
    await new Promise((resolve) => process.stderr.write(`${woke}\n`, resolve));
    return 2;
  }
  return 0;
}

main().then(
  (code) => process.exit(code ?? 0),
  () => process.exit(0),
);
