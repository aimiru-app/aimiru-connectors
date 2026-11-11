#!/usr/bin/env node
// Aimiru's brief for Codex: SessionStart ("Aimiru's brief" in /hooks; ADR-0157), and SubagentStart
// ("Aimiru's brief", under "When a subagent is created"; ADR-0174).
//
// As a Codex session starts (startup, resume, clear, compact or fork, Codex's own sources), asks Aimiru
// for the person's brief (GET /v1/brief, at most 2 s) and gives it to Codex exactly as Aimiru wrote it,
// as hookSpecificOutput.additionalContext, which Codex adds to the session as developer context (OpenAI,
// Codex hooks, "SessionStart"; openai/codex codex-rs/hooks/src/events/session_start.rs). It never takes
// a job: it also runs inside `codex exec`, where `aimiru-codex take` already gave Codex its job.
// Nothing else is printed: no brief (no key, an empty brief, 403, 404, 423 while paused, an error, a
// time limit, a malformed answer) is no output, and the session starts as it would have. The entry
// around it (lib/install.mjs briefCommand) always ends 0.
//
// SubagentStart (ADR-0174): Codex runs it as a subagent starts, fresh or forked, in place of
// SessionStart, which never runs for a subagent (openai/codex rust-v0.166.0,
// codex-rs/core/src/hook_runtime.rs run_pending_session_start_hooks). Its input names the subagent
// (agent_id, its own thread; agent_type, its role) and hookSpecificOutput.additionalContext becomes
// developer context for that subagent only (codex-rs/hooks/src/events/session_start.rs parse_completed,
// schema.rs SubagentStartHookSpecificOutputWire; OpenAI, Codex hooks: "That additionalContext text is
// added as extra developer context for the subagent"). continue: false would not stop it, and this
// never sends one. The same brief, the same 2 s, the same nothing on any failure.
//
// Keeps, for the doctor, when it last ran inside Codex and where its entry sat, never the brief's words.
// When init's report never reached Aimiru, it sends that report first (installed, not run yet), so a
// report names Codex's own connector and version before the first brief (ADR-0151).

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { briefOf } from './vendor/aimiru-client.mjs';
import { findOurBrief } from './lib/install.mjs';
import { installReport, loadSettings, makeClient, readStdinJson, reportedSinceInstall, stateStore } from './lib/runtime.mjs';

/** The folder this runs from (the copy init made, ~/.aimiru/codex/app). */
const APP_DIR = path.dirname(fileURLToPath(import.meta.url));

/** The most the brief may take: Codex waits for this entry before the session's first turn. */
const BRIEF_MS = 2_000;

/** True for the input Codex sends a SessionStart entry (a person running this by hand sends none). */
function fromCodex(input) {
  return input?.hook_event_name === 'SessionStart' && typeof input?.session_id === 'string' && input.session_id !== '' && typeof input?.source === 'string';
}

/** True for the input Codex sends a SubagentStart entry: the session, and the subagent by its own id and role. */
function fromSubagent(input) {
  return (
    input?.hook_event_name === 'SubagentStart' &&
    typeof input?.session_id === 'string' &&
    input.session_id !== '' &&
    typeof input?.agent_id === 'string' &&
    input.agent_id !== '' &&
    typeof input?.agent_type === 'string'
  );
}

async function main() {
  let input = {};
  try {
    input = await readStdinJson();
  } catch {
    input = {};
  }
  const settings = loadSettings();
  const client = makeClient(settings, { spool: false });
  if (!client.configured) return;
  const store = stateStore(settings.dataDir);
  // Aimiru gives Codex its brief by default once a report named Codex's own connector and its version
  // (ADR-0151, ADR-0157). Init sends that report; when it never reached Aimiru, it goes now, first.
  const status = store.readStatus();
  if (fromCodex(input) && !reportedSinceInstall(status)) {
    const source = typeof status.install_source === 'string' ? status.install_source : 'unknown';
    const hb = await client.heartbeat(installReport({ codexVersion: status.codex_version ?? null, source }), { timeoutMs: 1_500 }).catch(() => null);
    if (hb?.ok) store.updateStatus({ install_reported_at: new Date().toISOString(), tier: hb.data?.tier ?? null, reason: hb.data?.reason ?? null });
  }
  const subagent = fromSubagent(input);
  // A brief for a subagent only from Codex's own SubagentStart; by hand, nothing.
  if (input?.hook_event_name === 'SubagentStart' && !subagent) return;
  const brief = briefOf(await client.brief({ timeoutMs: BRIEF_MS }).catch(() => null));
  if (subagent) {
    try {
      store.updateStatus({ subagent_brief_ran_at: new Date().toISOString(), subagent_brief_state: brief.state });
    } catch {
      // a disk that keeps nothing never costs the subagent its brief
    }
  }
  if (fromCodex(input)) {
    let at = null;
    try {
      at = findOurBrief({ codexHome: settings.codexHome, appDir: APP_DIR });
    } catch {
      at = null;
    }
    store.updateStatus({
      brief_ran_at: new Date().toISOString(),
      brief_state: brief.state,
      brief_version: brief.version,
      ...(at?.present ? { brief_group_index: at.groupIndex, brief_handler_index: at.handlerIndex } : {}),
    });
  }
  if (brief.state !== 'given') return;
  // Written whole before the process ends (a pipe on macOS takes it in the background).
  const hookEventName = subagent ? 'SubagentStart' : 'SessionStart';
  await new Promise((resolve) => process.stdout.write(`${JSON.stringify({ hookSpecificOutput: { hookEventName, additionalContext: brief.text } })}\n`, resolve));
}

main().then(
  () => process.exit(0),
  () => process.exit(0),
);
