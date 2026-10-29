#!/usr/bin/env node
// The runner for Codex (ADR-0161): `aimiru-codex runner <on|off|status|run>` (cli.mjs), and what the
// LaunchAgent starts from the runner's own copy (`node ~/.sayso/runner/app/runner.mjs run`). The
// runner itself is vendor/runner.mjs, shared with Claude Code; Codex's take path is lib/runner-agent.mjs.

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runnerMain } from './vendor/runner.mjs';
import { PACKAGE_NAME } from './lib/runtime.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));

/** How the person types it: no tag and no version (Rohit, 29 Oct 23:50). */
export const RUNNER_LINE = `npx ${PACKAGE_NAME} runner`;

/** `runner <on|off|status|run>` for Codex; resolves to the exit code. */
export function codexRunner(argv, o = {}) {
  return runnerMain(argv, {
    connector: 'codex',
    scriptsDir: here,
    ownAgent: path.join(here, 'lib', 'runner-agent.mjs'),
    line: RUNNER_LINE,
    ...o,
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  codexRunner(process.argv.slice(2)).then(
    (code) => process.exit(code ?? 0),
    (e) => {
      process.stderr.write(`${e?.message || e}\n`);
      process.exit(1);
    },
  );
}
