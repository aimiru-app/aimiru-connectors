#!/usr/bin/env node
// Aimiru for Claude Code: /aimiru:import (ADR-0162). Brings what Claude Code already knows about the
// person into Aimiru's Memory and Soul, with the person's OK, each line with its source.
//
//   node scripts/import.mjs                          read the files, show the lines picked, keep them for the person's choice
//   node scripts/import.mjs --send [--leave-out 2 5] send the lines shown, less the numbers named
//   node scripts/import.mjs --none                   send nothing, and forget the lines shown
//
// It reads only ~/.claude/CLAUDE.md (or the one in CLAUDE_CONFIG_DIR), the project's CLAUDE.md and
// Claude Code's own notes on the project, on this computer (vendor/import-lines.mjs). The first step
// sends nothing. Only the exact lines it showed are sent, through memory_propose with how set to
// instructions, and Aimiru reads each again with its line rules: keys first, instructions refused,
// private lines waiting for the person. Its skill is one only the person can start: typing
// /aimiru:import is the OK. Exit codes: 0 done, 1 not connected or not sent, 2 a bad option.

import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { AGENT_LABEL, findDataDir, loadSettings, makeClient } from './lib/runtime.mjs';
import { IMPORT_WORDS, dropPending, lookStep, parseLeaveOut, sendStep } from './vendor/import-lines.mjs';

export const IMPORT_COMMAND = '/aimiru:import';
const CONNECT_COMMAND = '/aimiru:connect';

/** The step this run takes, and the numbers left out. Null for an option it does not know. */
export function parseArgs(argv) {
  const out = { step: 'look', leaveOut: new Set() };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--send') out.step = 'send';
    else if (a === '--none') out.step = 'none';
    else if (a === '--leave-out') {
      const words = [];
      while (i + 1 < argv.length && /^\d{1,3}(,\d{1,3})*,?$/.test(argv[i + 1])) words.push(argv[(i += 1)]);
      for (const n of parseLeaveOut(words.join(' '))) out.leaveOut.add(n);
    } else return null;
  }
  if (out.leaveOut.size > 0 && out.step !== 'send') return null;
  return out;
}

/**
 * @param {object} [o]
 * @param {string[]} [o.argv] @param {object} [o.env] @param {(line: string) => void} [o.say]
 * @param {string} [o.projectDir] the project whose files it reads (Claude Code's project folder)
 * @returns {Promise<number>}
 */
export async function runImport({ argv = process.argv.slice(2), env = process.env, say = (l) => process.stdout.write(`${l}\n`), projectDir } = {}) {
  const args = parseArgs(argv);
  if (!args) {
    say(`Run it as ${IMPORT_COMMAND}, or with --send, --send --leave-out and the numbers, or --none.`);
    return 2;
  }
  // Run by Claude from the skill, this has no CLAUDE_PLUGIN_DATA: the state goes where the key is.
  const settings = loadSettings({ ...env, CLAUDE_PLUGIN_DATA: findDataDir(env) });
  const dataDir = settings.dataDir;
  const project = projectDir || env.CLAUDE_PROJECT_DIR || process.cwd();

  if (args.step === 'none') {
    dropPending(dataDir);
    say(IMPORT_WORDS.forgotten);
    return 0;
  }
  // Not connected: nothing is read, since nothing could be sent.
  if (!settings.token || !settings.baseUrl) {
    say(IMPORT_WORDS.noKey(CONNECT_COMMAND));
    return 1;
  }
  if (args.step === 'look') {
    const { pick, lines } = lookStep({ agent: 'claude-code', label: AGENT_LABEL, dataDir, env, projectDir: project });
    for (const l of lines) say(l);
    if (pick.lines.length > 0) {
      say('');
      say(IMPORT_WORDS.choose);
    }
    return 0;
  }
  const client = makeClient(settings, { spool: false });
  const sent = await sendStep({ client, label: AGENT_LABEL, dataDir, leaveOut: args.leaveOut, again: `${CONNECT_COMMAND} --again` });
  if (!sent.waiting) {
    say(IMPORT_WORDS.nothingWaiting(IMPORT_COMMAND));
    return 1;
  }
  for (const l of sent.lines) say(l);
  return sent.result.stop ? 1 : 0;
}

const invoked = (() => {
  try {
    return fs.realpathSync(process.argv[1] || '') === fs.realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();
if (invoked) {
  runImport().then(
    (code) => process.exit(code),
    () => {
      process.stdout.write(`${IMPORT_WORDS.stop.unreachable}\n`);
      process.exit(1);
    },
  );
}
