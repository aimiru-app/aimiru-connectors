#!/usr/bin/env node
// Aimiru for Claude Code: UserPromptSubmit, when the person writes to Claude (ADR-0094).
//
// A yes that came in after Claude Code stopped waiting for it: when this session has a question
// still waiting on this computer whose step can be quoted back, Aimiru is asked about at most 3 of
// them (GET /v1/approvals/{id}?wait=0, all within 2 s). A question whose step cannot be quoted is
// not asked about, since reading an answer uses it up (ADR-0094 review). For each the person allowed, Claude reads the exact step and its input,
// quoted as data, and that it may take exactly that step once if it still fits what the person asks
// now. The existing waiting question then lets that exact call through (pre-tool-use.mjs); a changed
// step is asked about again.
//
// Only in the person's own terminal (CLAUDE_CODE_ENTRYPOINT "cli"). With no waiting question, or no
// answer, it prints nothing and exits at once: the person's message is never held up.

import { lateYesNextMessage } from './vendor/messages.mjs';
import { isInteractive, loadSettings, makeClient, quotedStep, readStdinJson, stateStore, writeJson } from './lib/runtime.mjs';

/** The whole run, network included. hooks.json gives this hook 3 s. */
const BUDGET_MS = 2_000;

async function main() {
  if (!isInteractive()) return;
  let input = {};
  try {
    input = await readStdinJson();
  } catch {
    return;
  }
  const session = typeof input?.session_id === 'string' && input.session_id ? input.session_id : null;
  if (!session) return;
  const settings = loadSettings();
  if (!settings.token || !settings.baseUrl) return;
  const store = stateStore(settings.dataDir, { secret: settings.token });
  // Only this session's own questions, still open here, whose step can be quoted back, and not one
  // whose yes already woke Claude (watch.mjs, CN10): each yes is offered once.
  const waiting = store.offerable({ session }).filter((e) => !store.woken(e.exceptionId)).slice(0, 3);
  if (!waiting.length) return;
  const client = makeClient(settings, { spool: false });
  if (!client.configured) return;
  const started = Date.now();
  const answers = await Promise.all(
    waiting.map((w) => client.approvalsWait(w.exceptionId, 0, { timeoutMs: Math.max(250, BUDGET_MS - (Date.now() - started)) }).catch(() => null)),
  );
  const lines = [];
  answers.forEach((r, i) => {
    const d = r?.ok ? r.data || {} : null;
    if (!d || d.status !== 'allowed') return;
    const p = store.pendingFor(waiting[i].exceptionId);
    const call = p?.call;
    if (quotedStep(call) === null) return;
    lines.push(lateYesNextMessage(call.tool_name, call.tool_input));
  });
  if (!lines.length) return;
  writeJson({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: lines.join('\n\n') } });
}

main().then(
  () => process.exit(0),
  () => process.exit(0),
);
