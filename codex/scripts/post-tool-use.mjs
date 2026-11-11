#!/usr/bin/env node
// Aimiru's record for Codex: PostToolUse ("Aimiru's record", under "After a tool executes" in /hooks;
// ADR-0174). Codex runs it in the background (async) once a step's tool produced its output, so it can
// never block, approve or change the step (OpenAI, Codex hooks, read 3 Nov 2026: "Background hooks
// can't block, approve, rewrite, or otherwise control the operation that triggered them"; openai/codex
// rust-v0.166.0, codex-rs/hooks/src/engine/dispatcher.rs, mod.rs can_apply_control_effects). The entry
// around it (lib/install.mjs quietCommand) always ends 0, and this script prints nothing.
//
// As Aimiru for Claude Code's PostToolUse does (claude-code/scripts/post-tool-use.mjs): confirms how a
// checked step ended with POST /v1/receipts, linked to the action Aimiru returned at check time (the
// link the check kept by tool_use_id, runtime.mjs putCall). Only a hash of the tool's output leaves
// this computer, never the output. A command's exit code is the fact that matters most (a test run
// that failed): Codex does not hand it to this entry, so it is read from the output Codex writes for
// this call in the session's transcript (lib/after.mjs exitCodeOf). Any code but 0 is outcome failed,
// as a command that failed is for Claude Code. Outside Codex's code mode only: there each command runs
// under an id no transcript line holds, so its exit is not found, and a command whose exit was not found
// says "How it ended is not known" rather than passing for a success. A checked read that finished is not confirmed again (the
// check already wrote it; AIMIRU_RECORD_READS=1 confirms all), unless it ran a program Codex wrote. A
// step the check never saw (its entry not trusted, say) is recorded with that said, never as checked.
// A receipt Aimiru cannot take now waits in the spool and goes later. The receipt never names a job's
// task: a task id with completed or failed would finish the person's job.
//
// Then, as Claude Code's does, it sends what waits on this computer: the snapshot of reads decided
// here when due, those reads when due (ADR-0095; the check's background sender still waits for them),
// and the spool.

import { exitCodeOf, outcomeOf, receiptKey, sendWhatWaits, subagentOf, summaryFor } from './lib/after.mjs';
import { actionForCodexTool, isCodexLocalTool } from './lib/map.mjs';
import { loadSettings, makeClient, projectDirOf, readStdinJson, stateStore } from './lib/runtime.mjs';
import { projectOf, redactDeep, setting, sha256Hex, truncate } from './vendor/aimiru-client.mjs';

/** The most this run takes, whatever Codex's own limit (hooks.json gives it 30 s). */
const RUN_MS = 25_000;

/** True for the input Codex sends this entry; a person running it by hand sends none. */
function fromCodex(input) {
  return (
    input?.hook_event_name === 'PostToolUse' &&
    typeof input?.session_id === 'string' &&
    input.session_id !== '' &&
    typeof input?.tool_use_id === 'string' &&
    input.tool_use_id !== '' &&
    typeof input?.tool_name === 'string' &&
    input.tool_name !== ''
  );
}

async function main() {
  let input;
  try {
    input = await readStdinJson();
  } catch {
    return;
  }
  if (!fromCodex(input)) return;
  // Codex's own local tools are never checked (map.mjs), so there is nothing to confirm.
  if (isCodexLocalTool(input.tool_name)) return;

  const settings = loadSettings();
  const client = makeClient(settings);
  if (!client.configured) return;
  const store = stateStore(settings.dataDir, { secret: settings.token });

  const call = store.takeCall(input.tool_use_id);
  const projectDir = projectDirOf(input.cwd, settings.home);
  let action;
  try {
    action = call ? { class: call.class, description: call.description } : actionForCodexTool(input, { projectDir, home: settings.home, protectedPaths: [settings.dataDir, settings.codexHome] });
  } catch {
    // A step this connector cannot read is still recorded.
    action = { class: 'other', description: `Use ${String(input.tool_name).slice(0, 100)}` };
  }

  const exitCode = await exitCodeOf(input, { codexHome: settings.codexHome });
  const outcome = outcomeOf(input, exitCode);

  // The programs Codex wrote that this step ran (CN6): the receipt names each file and the sha256 of
  // its content as it was checked, never its text.
  const artifacts = Array.isArray(call?.programs)
    ? call.programs.filter((p) => p && typeof p.rel === 'string' && /^[0-9a-f]{64}$/.test(String(p.sha256 ?? ''))).slice(0, 20).map((p) => ({ name: truncate(p.rel, 200), sha256: p.sha256 }))
    : [];

  // A read that finished adds nothing to what the Record holds: the check wrote it, or (with no check)
  // it changed nothing. Its failure, a program Codex wrote, or AIMIRU_RECORD_READS=1 is still sent.
  const recordReads = String(setting(process.env, 'RECORD_READS') ?? '').trim() === '1';
  const skipRead = action.class === 'read' && outcome === 'completed' && !artifacts.length && !recordReads && !call?.unchecked;
  // The check already put a record of a step that went ahead without Aimiru's answer in the spool
  // (pre-tool-use.mjs uncheckedRecord); only how it failed is new.
  const skipUnchecked = call?.unchecked === true && outcome === 'completed';

  if (!skipRead && !skipUnchecked) {
    const output = input.tool_response;
    await client.record(
      {
        action_id: call?.actionId ?? null,
        outcome,
        summary: summaryFor(action.description, { outcome, call, subagent: subagentOf(input), unknown: input.tool_name === 'Bash' && exitCode === null }),
        evidence: `sha256:${sha256Hex(JSON.stringify(redactDeep(output ?? null)))}`,
        ...(artifacts.length ? { artifacts } : {}),
        idempotency_key: receiptKey(input),
        // The project (ADR-0056); a receipt for a checked step keeps the project its check named.
        project: projectOf(projectDir),
      },
      { timeoutMs: 8_000 },
    );
  }

  await sendWhatWaits(client, settings, { budgetMs: 5_000 });
  if (Math.random() < 0.05) store.cleanup();
}

const timer = setTimeout(() => process.exit(0), RUN_MS);
timer.unref();
main().then(
  () => process.exit(0),
  () => process.exit(0),
);
