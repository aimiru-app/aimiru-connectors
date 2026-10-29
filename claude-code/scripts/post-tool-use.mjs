#!/usr/bin/env node
// Aimiru for Claude Code: PostToolUse, PostToolUseFailure and PermissionDenied (all async).
//
// Confirms the outcome of a checked call with POST /v1/receipts, linked by tool_use_id to the
// action Aimiru returned at check time. Only a hash of the tool's output leaves the machine.
// When Aimiru cannot take the record it is spooled in ${CLAUDE_PLUGIN_DATA}/spool.jsonl and sent later.
// Reads decided on this computer (ADR-0095): keeps the snapshot fresh (every refresh_s, one process
// at a time), and after a read decided here waits until the oldest such record is flush_s old and
// sends them (one waiter per data folder; hooks.json gives this hook 45 s).
// Async hooks cannot change anything in Claude Code, so this script prints nothing.

import { actionForClaudeCodeTool, isSaysoTool, splitMcpToolName } from './vendor/classify.mjs';
import { linkRequestIdIn, ucpCart, ucpCheckoutIn, ucpOperation, ucpOrderId, ucpScope } from './vendor/checkout.mjs';
import { projectOf, redactDeep, sha256Hex, truncate } from './vendor/sayso-client.mjs';
import { flushLocal, waitThenFlush } from './vendor/local.mjs';
import { loadSettings, localStateFor, makeClient, readStdinJson, refreshSnapshot, stateStore } from './lib/runtime.mjs';

function summaryFor(description, event, input, call) {
  // A program the agent wrote (ADR-0090) reads as its check did: "Run a command: node x.js. x.js,
  // not in your last commit".
  const d = String(description || 'An action').replace(/[.\s]+$/, '');
  let s = d;
  if (event === 'PermissionDenied') s = `${d}. Claude Code's own safety check stopped it`;
  else if (event === 'PostToolUseFailure') s = input.is_interrupt ? `${d}. It was stopped before it finished` : `${d}. It failed`;
  if (call?.unchecked) s = `${s}. Done while Aimiru was unreachable`;
  return truncate(`${s}.`, 280);
}

/**
 * True when this call of Aimiru's own record tool finished a job: outcome completed or failed with a
 * task_id, and Aimiru did not answer it with an error.
 */
function endsSessionJob(input) {
  if (!String(input.tool_name).endsWith('__record') || typeof input.session_id !== 'string' || !input.session_id) return false;
  const ti = input.tool_input && typeof input.tool_input === 'object' ? input.tool_input : {};
  if (typeof ti.task_id !== 'string' || !ti.task_id || !['completed', 'failed'].includes(ti.outcome)) return false;
  return input.tool_response?.isError !== true;
}

/** The order id in a checkout's output: the store's order.id, or Link's lsrq_ request id. */
function orderIdOf(input, checkout) {
  try {
    if (checkout.protocol === 'link') return linkRequestIdIn(input.tool_response);
    return ucpOrderId(input.tool_response);
  } catch {
    return null;
  }
}

async function main() {
  let input;
  try {
    input = await readStdinJson();
  } catch {
    return;
  }
  const event = input?.hook_event_name || 'PostToolUse';
  if (!input?.tool_name) return;
  if (isSaysoTool(input.tool_name, input.mcp_server)) {
    // Claude recorded the session's job done or not done with Aimiru's own record tool (ADR-0157):
    // the session's later steps no longer name that job. Aimiru's own tools are never recorded here.
    if (event === 'PostToolUse' && endsSessionJob(input)) {
      const settings = loadSettings();
      stateStore(settings.dataDir, { secret: settings.token }).clearSessionTask(input.session_id, input.tool_input.task_id);
    }
    return;
  }

  const settings = loadSettings();
  const store = stateStore(settings.dataDir, { secret: settings.token });
  const client = makeClient(settings);

  // A store's answer to create, update or get_checkout is the cart its complete_checkout will pay
  // for: remembered by checkout id, signed, for an hour (ADR-0065).
  const mcp = splitMcpToolName(input.tool_name);
  const op = mcp ? ucpOperation(mcp.tool) : null;
  if (event === 'PostToolUse' && ['create', 'update', 'get'].includes(op)) {
    try {
      const cart = ucpCart(ucpCheckoutIn(input.tool_response), { server: input.mcp_server?.name || mcp.server });
      // Kept for this tool server only: another server's answer never sets this store's cart.
      if (cart?.reference) store.putCart(cart, ucpScope(input.tool_name));
    } catch {
      // not a cart Aimiru can read: complete_checkout then asks with no amount
    }
  }

  const call = store.takeCall(input.tool_use_id);
  let action;
  try {
    action = call ? { class: call.class, description: call.description } : actionForClaudeCodeTool(input, { projectDir: settings.projectDir || input.cwd });
  } catch {
    // An input this connector cannot read is still recorded.
    action = { class: 'other', description: `Use ${String(input.tool_name).slice(0, 100)}` };
  }

  const outcome = event === 'PostToolUse' ? 'completed' : event === 'PostToolUseFailure' && input.is_interrupt ? 'partial' : 'failed';

  // The programs the agent wrote that this call ran (ADR-0090): the receipt names each file and the
  // sha256 of its content as it was checked, never its text. A file the same command changed has
  // no fingerprint Aimiru read, so it is named in the summary only.
  const artifacts = Array.isArray(call?.programs)
    ? call.programs.filter((p) => p && typeof p.rel === 'string' && /^[0-9a-f]{64}$/.test(String(p.sha256 ?? ''))).slice(0, 20).map((p) => ({ name: truncate(p.rel, 200), sha256: p.sha256 }))
    : [];

  // check already wrote this action to the Record. A finished read adds nothing, so it is not
  // confirmed again (keeps within the per-key rate limit), unless it ran a program the agent wrote:
  // its receipt keeps the file's fingerprint. Set AIMIRU_RECORD_READS=1 (or SAYSO_RECORD_READS=1) to confirm all.
  const skip = call && !call.unchecked && action.class === 'read' && outcome === 'completed' && !settings.recordReads && !artifacts.length;

  if (!skip) {
    const output = event === 'PostToolUse' ? input.tool_response : event === 'PermissionDenied' ? input.reason : input.error;
    const evidence = `sha256:${sha256Hex(JSON.stringify(redactDeep(output ?? null)))}`;
    await client.record({
      action_id: call?.actionId ?? null,
      outcome,
      summary: summaryFor(action.description, event, input, call),
      evidence,
      ...(artifacts.length ? { artifacts } : {}),
      idempotency_key: `cc_${sha256Hex(`${input.session_id}|${input.tool_use_id}|${event}`).slice(0, 40)}`,
      // The project (ADR-0056); a receipt for a checked call keeps the project its check named.
      project: projectOf(settings.projectDir || input.cwd),
      // A checkout's receipt carries the order id the store gave, or Link's request id (ADR-0065).
      ...(call?.checkout ? { checkout: { order_id: event === 'PostToolUse' ? orderIdOf(input, call.checkout) : null } } : {}),
    });
  }

  // Send anything left over from earlier failures while Aimiru is reachable; keep the snapshot
  // fresh; send the reads decided here, waiting for them after one (ADR-0095).
  const local = client.configured ? localStateFor(settings, client) : null;
  await Promise.all([
    client.flushSpool({ budgetMs: 5_000, max: 50 }),
    local && local.refreshDue() ? refreshSnapshot(client, local, store, input.session_id).catch(() => null) : null,
    local ? (call?.local ? waitThenFlush(client, local, { budgetMs: 40_000 }) : flushLocal(client, local, { budgetMs: 5_000 })).catch(() => null) : null,
  ]);
  if (Math.random() < 0.05) store.cleanup();
}

main().then(
  () => process.exit(0),
  () => process.exit(0),
);
