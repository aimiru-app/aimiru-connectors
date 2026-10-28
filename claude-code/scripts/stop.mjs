#!/usr/bin/env node
// Aimiru for Claude Code: Stop (async), when Claude finishes a turn.
//
// Reads decided on this computer (ADR-0095): refreshes the snapshot when it is due (GET /v1/me,
// one process at a time) and sends the reads decided here when they are due (POST
// /v1/checks/local), so a quiet session still reports within a minute. Async hooks cannot change
// anything in Claude Code, so this script prints nothing and never blocks the turn.

import { flushLocal } from './vendor/local.mjs';
import { loadSettings, localStateFor, makeClient, readStdinJson, refreshSnapshot, stateStore } from './lib/runtime.mjs';

async function main() {
  let input = {};
  try {
    input = await readStdinJson();
  } catch {
    input = {};
  }
  const settings = loadSettings();
  const client = makeClient(settings);
  if (!client.configured) return;
  const store = stateStore(settings.dataDir, { secret: settings.token });
  const local = localStateFor(settings, client);
  await Promise.all([
    local.refreshDue() ? refreshSnapshot(client, local, store, input?.session_id).catch(() => null) : null,
    flushLocal(client, local, { budgetMs: 5_000 }).catch(() => null),
    client.flushSpool({ budgetMs: 5_000, max: 50 }).catch(() => null),
  ]);
}

main().then(
  () => process.exit(0),
  () => process.exit(0),
);
