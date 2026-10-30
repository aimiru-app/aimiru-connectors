#!/usr/bin/env node
// Aimiru's check for Codex: the command Codex runs for every tool call (ADR-0091).
//
// Codex lets a call run when its check fails: a crash, an exit code other than 0 or 2, a death by
// signal, a timeout or output it cannot read all mark the check "failed", and Codex carries on
// (openai/codex codex-rs/hooks/src/events/pre_tool_use.rs, parse_completed). Codex has no setting to
// block instead (Claude Code's `onFailure: "block"`). This guard is that setting, built here:
//
//   - it runs the check (pre-tool-use.mjs) as its own process, passing Codex's input through;
//   - the check tells it, on fd 3, what to answer if the check dies: "allow" while the call is
//     harmless and nothing waits on the person, "deny" otherwise, and "deny" before it has said;
//   - the check may also say "limit <ms>" there: wait that long from now instead (a step held while
//     the person has paused, ADR-0142, then the usual time once it goes through its check), never
//     past HOLD_LIMIT_MS from the guard's own start, however many such lines come, under Codex's
//     own default limit for a check (10 minutes) until the Mac run logs that Codex waits longer;
//   - when the check answers (exit 0, or exit 2 with its reason on stderr), the guard passes that
//     answer on unchanged;
//   - when the check dies (killed, crashed, any other exit) or runs past GUARD_LIMIT_MS, the guard
//     answers for it: Codex goes ahead (no output) or gets Aimiru's refusal, as the check last said;
//   - SIGTERM, SIGINT or SIGHUP to the guard itself stop the check and answer the same way.
//
// A refusal is the reason on stderr and exit 2, never JSON on stdout: a login profile that prints
// would put its text ahead of the JSON, and Codex would run the call (runtime.mjs refuseAndExit).
//
// The entry in hooks.json wraps this guard in /bin/sh (lib/install.mjs guardCommand), which turns any
// exit other than 0 or 2 into a refusal: a Node.js that moved, or this guard killed with SIGKILL.
// What nothing here can cover: Codex stopping the whole entry after the time hooks.json gives it (an
// hour from 0.3.0, or Codex's own default of 10 minutes if it keeps that; the guard answers by 45 s,
// or by HOLD_LIMIT_MS from its start for a held step). Codex then lets the call run. ADR-0091 and
// docs/VERIFY-LOG.md say so.
//
// Kept small on purpose: Node built-ins only, nothing that can fail to load.

import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { STOPPED_REASON } from './lib/words.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const CHECK = path.join(here, 'pre-tool-use.mjs');
/** The check's 40 s plus room to start and answer. */
const LIMIT_MS = Math.min(45_000, [process.env.AIMIRU_GUARD_LIMIT_MS].map(Number).find((n) => n > 0) ?? 45_000);
/**
 * The longest the guard answers after its own start, whatever the check asks (ADR-0142; quality and
 * engineering review of wk/connectors-flow, 28 Oct): a step held while paused (CODEX_HOLD_CEILING_MS,
 * 8 minutes) and its check after Resume, 15 s under Codex's own default limit of 600 s
 * (CODEX_PROVEN_LIMIT_MS), which is all Codex is known to wait until the Mac run logs a hold past it.
 * Then it becomes 15 s under the hour hooks.json gives the entry (CODEX_TIMEOUT_S), with the ceiling.
 * test/pause-watch.test.mjs pins them together.
 */
const HOLD_LIMIT_MS = 585_000;
/** AIMIRU_GUARD_HOLD_LIMIT_MS can only make it shorter (tests). */
const holdLimitMs = Math.min(HOLD_LIMIT_MS, [process.env.AIMIRU_GUARD_HOLD_LIMIT_MS].map(Number).find((n) => n > 0) ?? HOLD_LIMIT_MS);
/** Every timer ends by this moment, so several "limit" lines never add up past the limit. */
const guardEnd = Date.now() + holdLimitMs;

let verdict = 'deny';
let done = false;
let child = null;
let stdout = '';
let stderr = '';

function answerForCheck() {
  if (done) return;
  done = true;
  try {
    child?.kill('SIGKILL');
  } catch {
    // already gone
  }
  if (verdict === 'allow') {
    process.exit(0); // no output: Codex goes ahead (a harmless call; its record waits on this computer)
  }
  process.stderr.write(`${STOPPED_REASON}\n`, () => process.exit(2));
}

for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(sig, answerForCheck);

// NODE_NO_WARNINGS: a warning Node prints on stderr would become part of a refusal's reason.
const childEnv = { ...process.env, AIMIRU_CODEX_GUARD: '1', AIMIRU_FALLBACK_FD: '3', NODE_NO_WARNINGS: '1' };
delete childEnv.NODE_OPTIONS;
delete childEnv.NODE_PATH;

try {
  child = spawn(process.execPath, [CHECK], { stdio: ['pipe', 'pipe', 'pipe', 'pipe'], env: childEnv });
} catch {
  answerForCheck();
}

if (child) {
  let timer = setTimeout(answerForCheck, Math.max(0, Math.min(LIMIT_MS, guardEnd - Date.now())));
  timer.unref?.();

  child.stdout.on('data', (d) => (stdout += d));
  child.stderr.on('data', (d) => (stderr += d));
  let said = '';
  child.stdio[3]?.on('data', (d) => {
    said += d;
    const lines = said.split('\n');
    said = lines.pop() ?? '';
    for (const line of lines) {
      if (line === 'allow' || line === 'deny') verdict = line;
      const limit = /^limit (\d{1,9})$/.exec(line);
      if (limit && !done) {
        clearTimeout(timer);
        timer = setTimeout(answerForCheck, Math.max(0, Math.min(Number(limit[1]), guardEnd - Date.now())));
        timer.unref?.();
      }
    }
  });
  child.stdio[3]?.on('error', () => {});
  child.stdin.on('error', () => {});
  child.on('error', answerForCheck);
  child.on('close', (code, signal) => {
    if (done) return;
    if (signal === null && code === 0) {
      done = true;
      clearTimeout(timer);
      if (stdout) process.stdout.write(stdout, () => process.exit(0));
      else process.exit(0);
      return;
    }
    if (signal === null && code === 2 && stderr.trim()) {
      done = true;
      clearTimeout(timer);
      process.stderr.write(stderr, () => process.exit(2));
      return;
    }
    answerForCheck();
  });
  process.stdin.on('error', () => {});
  process.stdin.pipe(child.stdin);
}
