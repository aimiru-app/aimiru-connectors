#!/usr/bin/env node
// The runner for Claude Code (ADR-0161): `node "<plugin>/scripts/runner.mjs" <on|off|status|run>` in
// a terminal of the person's own, and what the LaunchAgent starts from the runner's own copy
// (`node ~/.sayso/runner/app/runner.mjs run`). The runner itself is vendor/runner.mjs, shared with
// Codex; Claude Code's take path is lib/runner-agent.mjs. Never from inside Claude Code.

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runnerMain } from './vendor/runner.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));

/** How the person types it: this file, by its full path. */
export const RUNNER_LINE = `node "${path.join(here, 'runner.mjs')}"`;

/** `runner <on|off|status|run>` for Claude Code; resolves to the exit code. */
export function claudeRunner(argv, o = {}) {
  return runnerMain(argv, {
    connector: 'claude-code',
    scriptsDir: here,
    ownAgent: path.join(here, 'lib', 'runner-agent.mjs'),
    line: RUNNER_LINE,
    ...o,
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  claudeRunner(process.argv.slice(2)).then(
    (code) => process.exit(code ?? 0),
    (e) => {
      process.stderr.write(`${e?.message || e}\n`);
      process.exit(1);
    },
  );
}
