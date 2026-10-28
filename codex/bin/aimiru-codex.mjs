#!/usr/bin/env node
// aimiru-codex: Aimiru's check for Codex (ADR-0091). See scripts/cli.mjs.
import { main } from '../scripts/cli.mjs';

main().then(
  (code) => process.exit(code ?? 0),
  (e) => {
    process.stderr.write(`${e?.message || e}\n`);
    process.exit(1);
  },
);
