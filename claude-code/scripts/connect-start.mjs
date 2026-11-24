#!/usr/bin/env node
// Aimiru for Claude Code: connect from the line Aimiru's Connect screen copies (one-tap connect, build 5;
// ADR-0261, ADR-0312). The line installs the plugin and starts Claude Code with the ticket in its
// environment (AIMIRU_START_TICKET=<ticket> claude: never in the plugin's settings, never on a command
// line); at that session start this async SessionStart hook asks Aimiru to connect with the ticket and
// this computer's own id (deviceIdIn), so the request shows up on the person's Connect screen, where one
// Connect connects it (from the network the screen was opened on; from any other, the person picks the
// code too). It waits in the background, as long
// as the request lasts, for that Connect; the key then lands in the plugin's data folder, where every
// check reads it from the next step, with no restart and nothing typed.
//
// Only a computer with no key yet, and only with Aimiru's own address (the Opus security gate of
// 23 Nov 2026, M1; lib/start-line.mjs): a trusted project's settings file gives a hook its `env`, so a
// repository could otherwise carry a ticket and an address of its own and re-pair Claude Code at the
// next session start. A computer that is connected keeps its key and sends nothing; the session's
// first line says the line was not used and that /aimiru:connect --again connects another account.
//
// A ticket is used once: its hash is kept in the data folder (tickets-used), so a later session never
// sends it again (Aimiru would turn it down and write the refusal in the person's Record), and two
// sessions starting at once never both send it (an exclusive lock file). It opens nothing and asks
// nothing: a line that ran out leaves the plugin as it was. Prints nothing; never the ticket or the key.

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { findDataDir } from './lib/runtime.mjs';
import { lineRefusal } from './lib/start-line.mjs';
import { startTicketFrom } from './vendor/pair.mjs';
import { connect } from './connect.mjs';

/** The file of the tickets this computer has sent, as sha256 hex, newest last. */
export const USED_FILE = 'tickets-used';
const KEEP_USED = 50;

/**
 * The ticket the pasted line handed Claude Code in its environment (AIMIRU_START_TICKET); null when none.
 * Never kept in the plugin's settings or on a command line (the integrator's MEDIUM finding, 23 Nov 2026).
 */
export function ticketOf(env) {
  return startTicketFrom(env);
}

const hashOf = (ticket) => createHash('sha256').update(ticket).digest('hex');

/** Whether this ticket was sent from here before. */
export function wasUsed(dataDir, ticket) {
  try {
    return fs.readFileSync(path.join(dataDir, USED_FILE), 'utf8').split('\n').includes(hashOf(ticket));
  } catch {
    return false;
  }
}

/**
 * Takes the ticket for this run, once: true only for the one run that made the lock and wrote its hash.
 * The folder and the file are owner-only (0700, 0600).
 */
export function takeTicket(dataDir, ticket) {
  const hash = hashOf(ticket);
  try {
    fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    if (wasUsed(dataDir, ticket)) return false;
    const lock = path.join(dataDir, `ticket-${hash.slice(0, 16)}.lock`);
    fs.closeSync(fs.openSync(lock, 'wx', 0o600));
    const file = path.join(dataDir, USED_FILE);
    let kept = [];
    try {
      kept = fs.readFileSync(file, 'utf8').split('\n').filter((l) => /^[0-9a-f]{64}$/.test(l));
    } catch {
      kept = [];
    }
    const next = [...kept, hash].slice(-KEEP_USED);
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, `${next.join('\n')}\n`, { mode: 0o600 });
    fs.renameSync(tmp, file);
    try {
      fs.rmSync(lock, { force: true });
    } catch {
      // the hash already says it was taken
    }
    return true;
  } catch {
    // Taken by another run (the lock exists), or the folder cannot be written: send nothing.
    return false;
  }
}

/**
 * @param {object} [o] @param {object} [o.env] @param {Function} [o.run] connect.mjs's connect (a test seam)
 * @param {Function} [o.fetch] test seam for every request @param {Array<{file: string}>} [o.files] the settings files read
 * @returns {Promise<number>} always 0: a session start is never held up or stopped by this.
 */
export async function connectFromLine({ env = process.env, run = connect, fetch: fetchImpl = null, files = null } = {}) {
  const ticket = ticketOf(env);
  if (!ticket) return 0;
  const dataDir = findDataDir(env);
  const scoped = { ...env, CLAUDE_PLUGIN_DATA: dataDir };
  // A key known here, or a settings file that carries the line: nothing is taken, written or sent.
  if (lineRefusal(scoped, { ticket, files })) return 0;
  if (!takeTicket(dataDir, ticket)) return 0;
  try {
    await run({ argv: ['--ticket', ticket, '--from-session'], env: scoped, say: () => {}, ...(fetchImpl ? { fetch: fetchImpl } : {}) });
  } catch {
    // Unreachable, or refused: the plugin stays as it was, and the person copies a new line.
  }
  return 0;
}

const invoked = (() => {
  try {
    return fs.realpathSync(process.argv[1] || '') === fs.realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();
if (invoked) {
  connectFromLine().then(
    () => process.exit(0),
    () => process.exit(0),
  );
}
