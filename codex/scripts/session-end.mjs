#!/usr/bin/env node
// Aimiru's record for Codex: SessionEnd ("Aimiru's record", under "Right before a session ends" in
// /hooks; ADR-0174).
//
// Codex runs SessionEnd as the session closes (an open conversation archived or deleted, Codex closing
// normally, or 30 minutes idle with no client; never for a subagent), always synchronously and for
// at most 3 seconds, and its answer changes nothing (OpenAI, Codex hooks, read 3 Nov 2026: "They are
// advisory, so their output won't steer Codex or keep the thread open"; openai/codex rust-v0.166.0,
// codex-rs/hooks/src/events/session_end.rs, core/src/hook_runtime.rs run_session_end_hooks). Its input
// is the session's id, transcript and folder, and reason "other".
//
// So the person never waits on the network as Codex closes: run by Codex, this starts itself again
// detached (`--send`, in a session of its own, so Codex's limit never stops it) and ends at once. That
// run sends everything that waits on this computer, the reads decided here whether due or not (ADR-0095)
// and the records the spool kept, then ends. Nothing is printed, and the entry around it always ends 0.
//
// What it cannot do yet: tell Aimiru the session ended. Aimiru has no route for it (POST /v1/heartbeat
// sets the agent's tier from its report, so it is never sent from here); the live list goes quiet a
// few minutes after the last step instead (ADR-0174, what it costs later).

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { sendWhatWaits } from './lib/after.mjs';
import { loadSettings, makeClient, readStdinJson } from './lib/runtime.mjs';

/** The detached run's limit. */
const SEND_MS = 20_000;

/** The detached run: sends everything that waits, then ends. */
async function send() {
  const timer = setTimeout(() => process.exit(0), SEND_MS);
  timer.unref();
  const settings = loadSettings();
  const client = makeClient(settings);
  if (!client.configured) return;
  await sendWhatWaits(client, settings, { budgetMs: 10_000, force: true });
}

/** Run by Codex: start the detached run when there is anything to send, and end at once. */
async function start() {
  let input = {};
  try {
    input = await readStdinJson();
  } catch {
    input = {};
  }
  if (input?.hook_event_name !== 'SessionEnd') return;
  const settings = loadSettings();
  if (!settings.token || !settings.baseUrl) return;
  try {
    const child = spawn(process.execPath, [fileURLToPath(import.meta.url), '--send'], { detached: true, stdio: 'ignore', env: process.env });
    child.on('error', () => {});
    child.unref();
  } catch {
    // the next session's check sends what waits instead
  }
}

(process.argv.includes('--send') ? send() : start()).then(
  () => process.exit(0),
  () => process.exit(0),
);
