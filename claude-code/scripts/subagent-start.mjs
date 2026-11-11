#!/usr/bin/env node
// Aimiru for Claude Code: SubagentStart ("Aimiru's brief", agents track P2.9; the same brief Codex
// gives its subagents at SubagentStart, ADR-0174).
//
// SessionStart never runs for a subagent, so one Claude starts with the Agent tool (or resumes) began
// without the person's brief. As it starts, this asks Aimiru for the brief (GET /v1/brief, at most 2 s,
// the same ask and limit as session-start.mjs) and gives it to that subagent exactly as Aimiru wrote
// it, as hookSpecificOutput.additionalContext, which Claude Code adds to the subagent's context at the
// start of its conversation, before its first prompt (code.claude.com/docs/en/hooks, SubagentStart,
// read 10 Nov 2026). Its input names the subagent (agent_id, agent_type). The hook cannot block the
// subagent, and this never tries to.
//
// The brief alone: no job (a subagent works for the session that started it, which already holds the
// person's job), no late yes, and none of Aimiru's other words to the session. The context stays within
// Claude Code's 10,000 characters (fitContext): a brief that would not fit is left out whole, never cut.
//
// Nothing is printed, and it always ends 0, when there is no brief to give: no key, an empty brief, 401,
// 403, 404 (not open to this agent), 423 (paused), an error, a time limit, a malformed answer or one
// that does not fit. The subagent then starts as it would have.
//
// Keeps, for the doctor, when it last ran and what came of the brief (subagent_brief_ran_at,
// subagent_brief_state), never the brief's words. Prints no secret: never the key, never the address.

import { briefOf } from './vendor/aimiru-client.mjs';
import { askForBrief, briefAloneContext, briefMissed, loadSettings, makeClient, pausedHere, readStdinJson, stateStore } from './lib/runtime.mjs';

/**
 * After Aimiru did not answer (a time limit, no connection, a server error), the subagents that start
 * in the next minute begin at once without asking again: this runs for every subagent start, every
 * resume and every new message a teammate gets, and a down line must not cost each of them 2 s (the
 * agent hat, 11 Nov 2026). Only the time and the word "missed" are kept, never anything Aimiru said.
 */
export const MISS_QUIET_MS = 60_000;

/**
 * True for the input Claude Code sends a SubagentStart hook: the event, the session and the subagent
 * by its own id. A person running this by hand sends none, and nothing is asked or printed.
 */
function fromSubagentStart(input) {
  return (
    input?.hook_event_name === 'SubagentStart' &&
    typeof input?.session_id === 'string' &&
    input.session_id !== '' &&
    typeof input?.agent_id === 'string' &&
    input.agent_id !== ''
  );
}

// A closed pipe must not turn a quiet start into a failure.
process.stdout.on('error', () => process.exit(0));

async function main() {
  let input = {};
  try {
    input = await readStdinJson();
  } catch {
    return;
  }
  if (!fromSubagentStart(input)) return;
  const settings = loadSettings();
  // Paused here: Aimiru would answer 423 and give nothing, so do not make the subagent wait for it.
  if (pausedHere(settings)) return;
  const store = stateStore(settings.dataDir);
  const last = store.subagentBrief();
  if (last?.state === 'missed' && Date.now() - Date.parse(last.ranAt) < MISS_QUIET_MS) return;
  const client = makeClient(settings, { spool: false });
  if (!client.configured) return;
  const answer = await askForBrief(client);
  if (briefMissed(answer)) {
    store.noteSubagentBrief('missed');
    return;
  }
  const brief = briefOf(answer);
  const context = briefAloneContext(brief);
  // What came of it, for the doctor: a brief that was given but left out for room says so.
  store.noteSubagentBrief(brief.state === 'given' && context === null ? 'no_room' : brief.state);
  if (context === null) return;
  // Written whole before the process ends (a pipe on macOS takes it in the background).
  await new Promise((resolve) => process.stdout.write(`${JSON.stringify({ hookSpecificOutput: { hookEventName: 'SubagentStart', additionalContext: context } })}\n`, resolve));
}

main().then(
  () => process.exit(0),
  () => process.exit(0),
);
