#!/usr/bin/env node
// Aimiru's record for Codex: Stop and SubagentStop ("Aimiru's record", under "Right before Codex ends
// its turn" and "Right before a subagent ends its turn" in /hooks; ADR-0174).
//
// As Aimiru for Claude Code's Stop does (claude-code/scripts/stop.mjs): refreshes the snapshot of
// reads decided on this computer when it is due (GET /v1/me, one process at a time), sends those reads
// when they are due (POST /v1/checks/local, ADR-0095) and the records that waited for Aimiru (the
// spool), so a quiet session still reports within a minute. Codex runs both entries in the background
// (async), so they can never keep a turn going: a Stop entry that printed a reason, or ended 2, would
// have Codex carry on with it as a new prompt (openai/codex rust-v0.166.0,
// codex-rs/hooks/src/events/stop.rs parse_completed), which only a synchronous entry can do
// (engine/mod.rs can_apply_control_effects). This prints nothing and the entry around it always ends 0.

import { sendWhatWaits } from './lib/after.mjs';
import { loadSettings, makeClient, readStdinJson } from './lib/runtime.mjs';

/** The most this run takes, whatever Codex's own limit (hooks.json gives it 30 s). */
const RUN_MS = 20_000;

async function main() {
  let input = {};
  try {
    input = await readStdinJson();
  } catch {
    input = {};
  }
  if (input?.hook_event_name !== 'Stop' && input?.hook_event_name !== 'SubagentStop') return;
  const settings = loadSettings();
  const client = makeClient(settings);
  if (!client.configured) return;
  await sendWhatWaits(client, settings, { budgetMs: 5_000 });
}

const timer = setTimeout(() => process.exit(0), RUN_MS);
timer.unref();
main().then(
  () => process.exit(0),
  () => process.exit(0),
);
