// What Aimiru's record entries share (ADR-0174): how a step ended, read from what Codex hands
// PostToolUse and from the session's own transcript, the receipt's words, and sending what waits on
// this computer. Node built-ins and the shared client only. Nothing here answers Codex or can change
// a step: PostToolUse, Stop and SubagentStop run in the background (async) and SessionEnd hands its
// work to a detached process.
//
// What Codex 0.166.0 sends (openai/codex rust-v0.166.0, read 3 Nov 2026):
//   PostToolUse  codex-rs/hooks/src/schema.rs PostToolUseCommandInput: session_id, turn_id, agent_id
//                and agent_type (inside a subagent only), transcript_path, cwd, hook_event_name, model,
//                permission_mode, tool_name, tool_input, tool_response, tool_use_id. It runs only for a
//                step whose tool produced its output (codex-rs/core/src/tools/registry.rs: no
//                PostToolUse when the handler failed). For a command (tool_name Bash) tool_response is
//                the command's output text only (codex-rs/core/src/tools/context.rs
//                ExecCommandToolOutput::post_tool_use_response), never its exit code; the output Codex
//                writes to the transcript for that call starts with a header Codex itself writes,
//                "Process exited with code N" among its lines, before "Output:" (response_header).
//                For a tool server call it is the call's result, with isError when the server said so.
//   Stop         schema.rs StopCommandInput: session_id, turn_id, transcript_path, cwd, model,
//                permission_mode, stop_hook_active, last_assistant_message.
//   SubagentStop SubagentStopCommandInput: the same, with agent_id, agent_type, agent_transcript_path.
//   SessionEnd   SessionEndCommandInput: session_id, transcript_path, cwd, reason ("other").
// session_id is the one id shared by a session and every subagent it starts (codex-rs/core/src/session/
// session.rs session_id); agent_id is the subagent's own thread (hook_runtime.rs subagent_hook_context).

import fs from 'node:fs';
import path from 'node:path';
import { createLocalState, flushLocal, localReadsOn, refreshLocal } from '../vendor/local.mjs';
import { redactSecrets, sha256Hex, truncate } from '../vendor/aimiru-client.mjs';

/** How long PostToolUse looks for the step's output in the transcript, where Codex writes the exit code. */
export const EXIT_WAIT_MS = 5_000;
/** How often it looks. */
const EXIT_POLL_MS = 200;
/** How much of the end of the transcript it reads: Codex writes the output last. */
const TAIL_BYTES = 2 * 1024 * 1024;

/**
 * The transcript Codex names for this step, only when it is a real file inside Codex's sessions folder
 * ($CODEX_HOME/sessions, links resolved) named for this session or, inside a subagent, for the
 * subagent's own thread (rollout-<time>-<id>.jsonl), as the check reads it (runtime.mjs
 * ranInsideCodex). Null for anything else: a step piped in by hand names none.
 */
export function transcriptOf(input, codexHome) {
  const file = input?.transcript_path;
  if (typeof file !== 'string' || !path.isAbsolute(file) || !codexHome) return null;
  const ids = [input.session_id, input.agent_id].filter((v) => typeof v === 'string' && v !== '' && !/[\\/]/.test(v));
  if (!ids.length) return null;
  try {
    const sessions = fs.realpathSync(path.join(codexHome, 'sessions'));
    const real = fs.realpathSync(file);
    if (!real.startsWith(sessions + path.sep)) return null;
    const name = path.basename(real);
    if (!name.startsWith('rollout-') || !ids.some((id) => name.endsWith(`-${id}.jsonl`))) return null;
    return fs.statSync(real).isFile() ? real : null;
  } catch {
    return null;
  }
}

/** The end of a file, as text. */
function tailOf(file, bytes = TAIL_BYTES) {
  let fd = null;
  try {
    fd = fs.openSync(file, 'r');
    const size = fs.fstatSync(fd).size;
    const length = Math.min(size, bytes);
    const buf = Buffer.alloc(length);
    fs.readSync(fd, buf, 0, length, size - length);
    return buf.toString('utf8');
  } catch {
    return '';
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {
        // already closed
      }
    }
  }
}

/** The text of a transcript output: a plain string, or Codex's list of text items. */
function outputText(output) {
  if (typeof output === 'string') return output;
  if (Array.isArray(output)) return output.map((x) => (x && typeof x.text === 'string' ? x.text : '')).join('\n');
  return '';
}

/**
 * The exit code Codex wrote for this call in the transcript (text: its end), or null. Only Codex's
 * own output line for this exact call counts (a response item, function_call_output, call_id equal to
 * the step's tool_use_id), and only the header Codex writes before "Output:": a command's own output
 * comes after it, so nothing a command prints can read as its exit. With no "Output:" line there is no
 * header to tell apart from the output (security review of ADR-0174), so nothing is read: null.
 */
export function exitCodeIn(text, toolUseId) {
  if (typeof toolUseId !== 'string' || !toolUseId) return null;
  const key = `"call_id":${JSON.stringify(toolUseId)}`;
  const lines = String(text ?? '').split('\n');
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i];
    if (!line.includes(key) || !line.includes('function_call_output')) continue;
    let item;
    try {
      item = JSON.parse(line);
    } catch {
      continue;
    }
    const p = item?.type === 'response_item' ? item.payload : null;
    if (p?.type !== 'function_call_output' || p.call_id !== toolUseId) continue;
    const parts = outputText(p.output).split(/\r?\nOutput:/);
    if (parts.length < 2) return null;
    const m = /^Process exited with code (-?\d{1,4})$/m.exec(parts[0]);
    return m ? Number(m[1]) : null;
  }
  return null;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * How a command step ended, from the session's transcript (exitCodeIn): Codex writes the call's output
 * there just after PostToolUse starts, so this looks for at most waitMs. Null when the transcript
 * cannot be trusted, the step is not a plain call (Codex's code mode runs commands as exec-<id>, an id
 * no transcript line holds), or Codex did not write it in time (a command still running, finished
 * later through write_stdin, writes its exit under another call).
 */
export async function exitCodeOf(input, { codexHome, waitMs = EXIT_WAIT_MS } = {}) {
  if (input?.tool_name !== 'Bash' || typeof input?.tool_use_id !== 'string' || /^exec-/.test(input.tool_use_id)) return null;
  const file = transcriptOf(input, codexHome);
  if (!file) return null;
  const end = Date.now() + Math.max(0, waitMs);
  for (;;) {
    const code = exitCodeIn(tailOf(file), input.tool_use_id);
    if (code !== null || Date.now() >= end) return code;
    await sleep(EXIT_POLL_MS);
  }
}

/**
 * How the step ended, as a receipt's outcome: failed for a command that ended with any code but 0, or
 * a tool server call its server marked as an error; completed otherwise, including when the exit is
 * not known (Codex runs PostToolUse only once the tool produced its output).
 */
export function outcomeOf(input, exitCode) {
  if (Number.isInteger(exitCode) && exitCode !== 0) return 'failed';
  const r = input?.tool_response;
  if (r && typeof r === 'object' && !Array.isArray(r) && (r.isError === true || r.is_error === true)) return 'failed';
  return 'completed';
}

/** A subagent's kind as Codex names it (its role), short and plain, or null outside a subagent. */
export function subagentOf(input) {
  if (typeof input?.agent_id !== 'string' || !input.agent_id) return null;
  const type = typeof input.agent_type === 'string' ? input.agent_type.replace(/[^\p{L}\p{N} _-]+/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, 40) : '';
  return { id: input.agent_id.slice(0, 120), type: type || null };
}

/**
 * The receipt's one line (people read it in the Record), as Aimiru for Claude Code words its own
 * (claude-code/scripts/post-tool-use.mjs summaryFor): the step as the check described it, how it
 * ended, and, when it applies, that Codex ran it while Aimiru could not be reached, or without
 * Aimiru's check, and that a subagent of Codex did it. `unknown`: a command whose exit code was not
 * found (Codex's code mode, a command finished later, a transcript not written in time): the receipt
 * says so instead of passing completed off as a success (quality review of ADR-0174).
 */
export function summaryFor(description, { outcome, call, subagent, unknown = false }) {
  const d = String(description || 'An action').replace(/[.\s]+$/, '');
  let s = d;
  if (outcome === 'failed') s = `${s}. It failed`;
  else if (unknown) s = `${s}. How it ended is not known`;
  if (call?.unchecked) s = `${s}. Done while Aimiru was unreachable`;
  else if (!call) s = `${s}. Codex ran it without Aimiru's check`;
  if (subagent) s = `${s}. Done by a subagent of Codex${subagent.type ? ` (${subagent.type})` : ''}`;
  return truncate(redactSecrets(`${s}.`), 280);
}

/** The receipt's idempotency key: one per step, never the check's own ("|unchecked", pre-tool-use.mjs). */
export function receiptKey(input) {
  return `cx_${sha256Hex(`${input?.session_id ?? ''}|${input?.tool_use_id ?? ''}|after`).slice(0, 40)}`;
}

/** This computer's snapshot and local spool (ADR-0095), as the check keeps them. */
export function localFor(settings, client) {
  return createLocalState({ dataDir: settings.dataDir, token: settings.token, baseUrl: client.baseUrl });
}

/**
 * Sends what waits on this computer, as Aimiru for Claude Code's Stop does (claude-code/scripts/
 * stop.mjs): refreshes the snapshot when it is due (GET /v1/me, one process at a time), sends the
 * reads decided here that are due (POST /v1/checks/local; `force` sends them all, as a session ends)
 * and the records that waited for Aimiru (the spool). Reads decided here only while they are on
 * (AIMIRU_LOCAL_READS). Never throws.
 */
export async function sendWhatWaits(client, settings, { budgetMs = 5_000, force = false } = {}) {
  if (!client?.configured) return;
  const sending = localReadsOn();
  let local = null;
  try {
    local = localFor(settings, client);
  } catch {
    local = null;
  }
  await Promise.all([
    sending && local && local.refreshDue() ? refreshLocal(client, local, { timeoutMs: Math.min(3_000, budgetMs) }).catch(() => null) : null,
    local ? flushLocal(client, local, { budgetMs, force }).catch(() => null) : null,
    client.flushSpool({ budgetMs, max: 50 }).catch(() => null),
  ]);
}
