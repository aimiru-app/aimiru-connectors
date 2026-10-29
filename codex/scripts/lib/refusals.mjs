// Aimiru's refusals inside a `take` run, exactly as Codex surfaces them (ADR-0157).
//
// `codex exec --json` prints nothing for a step a PreToolUse entry refused: Codex never starts it, and
// hands the model "Command blocked by PreToolUse hook: <reason>. Command: <command>" (or "Tool call
// blocked by PreToolUse hook: <reason>. Tool: <name>") as the call's output (openai/codex rust-v0.165.0,
// codex-rs/core/src/hook_runtime.rs, tools/registry.rs). Codex writes that output to the session's
// transcript, $CODEX_HOME/sessions/<yyyy>/<mm>/<dd>/rollout-<time>-<session id>.jsonl, as a
// function_call_output or custom_tool_call_output (seen in the Mac run of 28 Oct). This follows that
// file for the run's session and hands back each refusal once, word for word, so the person reads on
// the terminal what Codex read. Reads only; never writes to Codex's folder.

import fs from 'node:fs';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';

/** How Codex begins the output it gives the model for a call a hook blocked; nothing else counts. */
const BLOCKED_STARTS = ['Command blocked by PreToolUse hook: ', 'Tool call blocked by PreToolUse hook: '];
/** Codex's code mode puts its own words before an error it hands back. */
const SCRIPT_ERROR = 'Script error:\n';

/**
 * The refusals one transcript line holds, as Codex wrote them; [] for any other line (security
 * review). Only Codex's own top-level output counts: a function_call_output whose output is a plain
 * string that begins with Codex's words for a blocked call, or with exactly "Script error:" and a line
 * break before them; only the first line of those words is kept. Nothing inside a structured, custom
 * or tool server output is read, so a tool's own output, or a file the agent printed, never speaks in
 * Aimiru's voice. A refusal Codex wraps in a list (its code mode) is not shown here; Codex says it in
 * its summary.
 */
export function refusalsIn(line) {
  if (typeof line !== 'string' || !line.includes('blocked by PreToolUse hook')) return [];
  let entry;
  try {
    entry = JSON.parse(line);
  } catch {
    return [];
  }
  const payload = entry?.payload;
  if (entry?.type !== 'response_item' || payload?.type !== 'function_call_output' || typeof payload.output !== 'string') return [];
  const text = payload.output.startsWith(SCRIPT_ERROR) ? payload.output.slice(SCRIPT_ERROR.length) : payload.output;
  if (!BLOCKED_STARTS.some((b) => text.startsWith(b))) return [];
  return [text.split('\n')[0].trim()];
}

/** The session's transcript as Codex names it, looked for in the date folders around today. */
export function transcriptOf(codexHome, sessionId, now = new Date()) {
  if (typeof sessionId !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(sessionId)) return null;
  const sessions = path.join(codexHome, 'sessions');
  for (const offset of [0, -1, 1]) {
    const d = new Date(now.getTime() + offset * 24 * 3600_000);
    const dir = path.join(sessions, String(d.getFullYear()), String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0'));
    let names = [];
    try {
      names = fs.readdirSync(dir);
    } catch {
      continue;
    }
    const hit = names.find((n) => n.startsWith('rollout-') && n.endsWith(`-${sessionId}.jsonl`));
    if (hit) return path.join(dir, hit);
  }
  return null;
}

/**
 * Follows one session's transcript and calls onRefusal(text) with each refusal once, in order.
 * stop() reads what was written last, then stops.
 */
export function followRefusals({ codexHome, sessionId, onRefusal, everyMs = 500 }) {
  let file = null;
  let offset = 0;
  let carry = '';
  let timer = null;
  let stopped = false;
  const seen = new Set();
  const decoder = new StringDecoder('utf8');
  const read = () => {
    try {
      if (!file) file = transcriptOf(codexHome, sessionId);
      if (!file) return;
      const size = fs.statSync(file).size;
      if (size <= offset) return;
      const fd = fs.openSync(file, 'r');
      try {
        const buf = Buffer.alloc(Math.min(size - offset, 8 * 1024 * 1024));
        const n = fs.readSync(fd, buf, 0, buf.length, offset);
        offset += n;
        const lines = (carry + decoder.write(buf.subarray(0, n))).split('\n');
        carry = lines.pop() ?? '';
        for (const l of lines) {
          for (const r of refusalsIn(l)) {
            if (seen.has(r)) continue;
            seen.add(r);
            try {
              onRefusal(r);
            } catch {
              // the terminal went away
            }
          }
        }
      } finally {
        fs.closeSync(fd);
      }
    } catch {
      // the transcript moved or is not there: nothing to show from it
    }
  };
  const tick = () => {
    if (stopped) return;
    read();
    timer = setTimeout(tick, everyMs);
    timer.unref?.();
  };
  tick();
  return {
    stop() {
      if (stopped) return;
      stopped = true;
      clearTimeout(timer);
      read();
    },
  };
}
