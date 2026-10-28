#!/usr/bin/env node
// Aimiru's check for Codex: the background sender and Pause watcher (ADR-0095, ADR-0142), started
// detached by pre-tool-use.mjs.
//
// Codex has no hook that runs after a call or when a turn ends for this check, and a new entry would
// need the person's trust in /hooks again, so this short-lived process does what Aimiru for Claude
// Code does in its async hooks:
//   - the Pause watch (ADR-0142, CN11): while Codex works, it reads the Pause at most once every 3 s
//     for this computer's agent (shared/pause-watch.mjs), writes the pause memory on a new Pause and
//     confirms it to Aimiru (POST /v1/pause/ack, learned_by watch), so the next step is held. Codex
//     has no wake: its next step finds the memory and holds there. Each check extends the lease (2
//     minutes), and the watch ends with it, at 15 minutes at most;
//   - with reads decided on the computer on: it refreshes the snapshot of what the person's rules
//     allow without condition (GET /v1/me, one process at a time), and sends those reads (POST
//     /v1/checks/local) once the oldest has waited flush_s, so they reach Aimiru within a minute.
// It never answers Codex and prints nothing; the check started it with nothing of its own open, so
// the guard never waits on it.

import { createLocalState, localReadsOn, refreshLocal, waitThenFlush } from './vendor/local.mjs';
import { watchLoop } from './vendor/pause-watch.mjs';
import { BACKGROUND_MAX_MS, backgroundBudgetMs, loadSettings, makeClient, watchFor } from './lib/runtime.mjs';

/** The sender's own part ends sooner: it sends what waits, then leaves the rest to the watch. */
const SEND_MS = 45_000;

async function main() {
  const settings = loadSettings();
  const client = makeClient(settings);
  if (!client.configured) return;
  const local = createLocalState({ dataDir: settings.dataDir, token: settings.token, baseUrl: client.baseUrl });
  const watch = watchFor(settings);
  const sending = localReadsOn();
  await Promise.all([
    sending && local.refreshDue() ? refreshLocal(client, local, { timeoutMs: 5_000 }).catch(() => null) : null,
    sending ? waitThenFlush(client, local, { budgetMs: SEND_MS - 2_000 }).catch(() => null) : null,
    watchLoop(client, watch, { budgetMs: backgroundBudgetMs(), local }).catch(() => null),
  ]);
}

const timer = setTimeout(() => process.exit(0), BACKGROUND_MAX_MS + 5_000);
timer.unref();
main().then(
  () => process.exit(0),
  () => process.exit(0),
);
