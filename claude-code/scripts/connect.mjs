#!/usr/bin/env node
// Aimiru for Claude Code: /aimiru:connect (ADR-0034, ADR-0150). Connects this computer's Claude Code
// to the person's Aimiru without copying a key: it opens the pairing page in the person's browser
// (and shows the link, for a phone), the person picks the code it shows from three and taps Connect,
// and this script keeps the key it gets in the plugin's data folder
// (${CLAUDE_PLUGIN_DATA}/key.json, readable only by the person). Every later check reads it from
// there, so the plugin's key setting can stay empty. Then it waits on the practice request Aimiru
// made from it (only an alert brings it to the person).
//
//   node scripts/connect.mjs [--url <Aimiru address>] [--email <your Aimiru email>] [--wait <seconds>] [--again]
//
// The address (addressOf): --url; else the request a run before this one kept, while it is worth a
// poll; else the plugin's own setting, as Claude Code hands it to the hooks or keeps it in its
// settings file (it hands it to no command Claude runs); else AIMIRU_BASE_URL; else the address the
// saved key was made for; else Aimiru's own, https://aimiru.app.
//
// One run waits as long as the request lasts, within the longest time limit Claude Code gives a
// command (CONNECT_WAIT_S), saying each minute how long it has left; --wait makes it shorter.
// Stopped before the person connects it (that time limit, Esc, a signal), it says it is still
// waiting, keeps the request and exits 0, and the next run waits on the same code, so the key Aimiru
// makes for it is collected; a request past its 10 minutes is polled once more while Aimiru may
// still keep the key of a Connect tapped near its end (PAIR_KEY_KEPT_MS). Exit codes: 0 connected
// (or already), or still waiting; 1 not connected (declined, run out, used, unreachable, an address
// it cannot use). Never prints the key or the poll secret.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AGENT_LABEL, CONNECTOR, VERSION, findDataDir, keyFilePath, loadSettings, makeClient, savedPluginOption } from './lib/runtime.mjs';
import { openPage as openInBrowser } from './vendor/open-page.mjs';
import {
  PAIR_MESSAGES,
  PRACTICE_WAIT_MS,
  dropPendingPairing,
  pairAgent,
  pendingLasts,
  readPendingPairing,
  resumeFrom,
  waitForPractice,
  writeKeyFile,
  writePendingPairing,
} from './vendor/pair.mjs';
import { normaliseBaseUrl, setting } from './vendor/sayso-client.mjs';
import { describeAsk, markAsked, readImportState } from './vendor/import-lines.mjs';

const PENDING_FILE = 'pairing.json';
/** Aimiru's own address: where connect pairs when nothing names another (Mac run part 1, item 1). */
export const DEFAULT_ADDRESS = 'https://aimiru.app';
/**
 * How long one run waits, in seconds. A request lasts 10 minutes, and Claude Code gives a command
 * at most 10 minutes (its longest time limit), so a run waits 590 s and then ends by itself, saying
 * it is still waiting, before that limit would end it.
 */
export const CONNECT_WAIT_S = 590;
/** How often a run says it is still waiting, so a long wait never looks stuck. */
const REMIND_EVERY_MS = 60_000;
/** What the person runs again to keep waiting on the same code. */
const RUN_AGAIN = '/aimiru:connect';

export function parseArgs(argv) {
  const out = { url: null, email: null, waitS: null, again: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--again') out.again = true;
    else if (a === '--url') out.url = argv[++i] ?? null;
    else if (a === '--email') out.email = argv[++i] ?? null;
    else if (a === '--wait') out.waitS = Number(argv[++i]);
    else if (/^https?:\/\//.test(a)) out.url = a;
  }
  return out;
}

/** Seconds this run waits: --wait, else AIMIRU_CONNECT_WAIT_S, each only shorter than CONNECT_WAIT_S. */
export function waitSecondsOf(args, env) {
  const asked = Number.isFinite(args?.waitS) && args.waitS > 0 ? args.waitS : Number(setting(env, 'CONNECT_WAIT_S'));
  return Number.isFinite(asked) && asked > 0 ? Math.min(asked, CONNECT_WAIT_S) : CONNECT_WAIT_S;
}

/**
 * The Aimiru address this run pairs with: --url; the request a run before this one kept, while it
 * is worth a poll (pendingLasts: a run started as the still waiting line says, with no address,
 * collects that request's key); the plugin's own setting, as Claude Code hands it to the hooks or
 * keeps it in its settings file; AIMIRU_BASE_URL (or AIMIRU_URL); the address the saved key was made
 * for; else https://aimiru.app.
 */
export function addressOf({ args, env, settings, pending, now = Date.now() }) {
  if (args.url) return args.url;
  if (pendingLasts(pending, now)) return pending.base_url;
  return env.CLAUDE_PLUGIN_OPTION_SAYSO_URL || savedPluginOption(env, 'sayso_url') || setting(env, 'BASE_URL') || setting(env, 'URL') || settings.baseUrl || DEFAULT_ADDRESS;
}

/**
 * Asks once (ADR-0162, point 2): bring in what Claude Code already knows about the person? It lists
 * the files the import would read that are on this computer, reads none of them, and says the
 * answer is typing /aimiru:import. Never asked again, and never when none of the files is here.
 */
export function offerImport({ dataDir, env, say }) {
  try {
    if (readImportState(dataDir).asked) return false;
    const lines = describeAsk({ agent: 'claude-code', label: AGENT_LABEL, command: '/aimiru:import', env, projectDir: env.CLAUDE_PROJECT_DIR || process.cwd() });
    if (lines.length === 0) return false;
    say('');
    for (const l of lines) say(l);
    markAsked(dataDir);
    return true;
  } catch {
    // The question can wait for the next connect; the connection is made.
    return false;
  }
}

/** Resolves 'stopped' once `stop` fires; never, when there is no stop. */
function stopped(stop) {
  if (!stop) return new Promise(() => {});
  if (stop.aborted) return Promise.resolve('stopped');
  return new Promise((resolve) => stop.addEventListener('abort', () => resolve('stopped'), { once: true }));
}

/**
 * @param {object} [o]
 * @param {string[]} [o.argv] @param {object} [o.env] @param {(line: string) => void} [o.say]
 * @param {Function} [o.fetch] test seam for every request
 * @param {(url: string) => Promise<boolean>} [o.openPage] opens the pairing page (default: the person's browser, open-page.mjs)
 * @param {AbortSignal} [o.stop] ends the wait early (the command line wires SIGINT, SIGTERM and SIGHUP to it)
 * @returns {Promise<number>} exit code
 */
export async function connect({ argv = process.argv.slice(2), env = process.env, say = (l) => process.stdout.write(`${l}\n`), fetch: fetchImpl, openPage = null, stop = null } = {}) {
  const args = parseArgs(argv);
  // Run by Claude from the skill, this has no CLAUDE_PLUGIN_DATA: the key goes where the hooks read it.
  const settings = loadSettings({ ...env, CLAUDE_PLUGIN_DATA: findDataDir(env) });
  const pendingFile = path.join(settings.dataDir, PENDING_FILE);
  const keyFile = keyFilePath(settings.dataDir);
  const waitS = waitSecondsOf(args, env);
  const t0 = Date.now();

  // Already connected with a key Aimiru still knows: nothing to do, unless asked again.
  if (settings.token && !args.again) {
    const client = makeClient(settings, { spool: false });
    if (client.configured) {
      const me = await client.me();
      if (me.ok) {
        say(`Aimiru for Claude Code is already connected as ${me.data?.agent?.name || AGENT_LABEL}. To connect it as a new agent, run /aimiru:connect --again.`);
        offerImport({ dataDir: settings.dataDir, env, say });
        return 0;
      }
    }
  }

  const pending = readPendingPairing(pendingFile);
  let base;
  try {
    base = normaliseBaseUrl(addressOf({ args, env, settings, pending }));
  } catch (e) {
    say(PAIR_MESSAGES.badAddress(e.message));
    say('Then run: /aimiru:connect --url <address>');
    return 1;
  }

  const result = await pairAgent({
    baseUrl: base,
    agent: { name: AGENT_LABEL, kind: 'claudecode', host: os.hostname() },
    connector: { name: CONNECTOR, version: VERSION },
    personEmail: args.email,
    say,
    maxWaitMs: waitS * 1000,
    resume: resumeFrom(pending, base),
    onStarted: (started) => writePendingPairing(pendingFile, started),
    openPage: openPage || ((url) => openInBrowser(url, { baseUrl: base, env })),
    remindEveryMs: REMIND_EVERY_MS,
    signal: stop,
    ...(fetchImpl ? { fetch: fetchImpl } : {}),
  });

  if (!result.ok) {
    // Not connected yet is not a failure (Mac run part 1, item 3): the request is kept, and the next
    // run waits on the same code.
    if (result.reason === 'waiting') {
      say(PAIR_MESSAGES.stillWaitingRun(RUN_AGAIN));
      return 0;
    }
    say(result.message);
    if (['declined', 'expired', 'used'].includes(result.reason)) dropPendingPairing(pendingFile);
    return 1;
  }

  writeKeyFile(keyFile, { agentKey: result.agentKey, baseUrl: result.baseUrl, agentId: result.agentId, name: result.name });
  dropPendingPairing(pendingFile);
  say(PAIR_MESSAGES.connected(result.name));
  say(PAIR_MESSAGES.savedKey(keyFile));
  if (settings.keySource === 'settings') {
    say('The key in the plugin settings still wins over this one. Clear it with /plugin configure aimiru@aimiru to use the new key.');
  }
  say('Aimiru checks the next action Claude Code takes. The next session reports how it runs, which decides what Aimiru shows.');
  // The practice request: within what is left of this run, never past a stop.
  const left = waitS * 1000 - (Date.now() - t0);
  const practice = waitForPractice({
    baseUrl: result.baseUrl,
    agentKey: result.agentKey,
    practice: result.practice,
    connector: `${CONNECTOR}/${VERSION}`,
    say,
    budgetMs: Math.min(PRACTICE_WAIT_MS, Math.max(20_000, left)),
    ...(fetchImpl ? { fetch: fetchImpl } : {}),
  });
  if ((await Promise.race([practice, stopped(stop)])) === 'stopped') say(PAIR_MESSAGES.practiceWaiting);
  offerImport({ dataDir: settings.dataDir, env, say });
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
  // Stopped from outside (Claude Code's time limit, Esc, Ctrl+C, the terminal closing): the wait ends
  // between polls with the still waiting line and exit 0. A second signal ends it at once.
  const stopper = new AbortController();
  const onSignal = () => {
    if (stopper.signal.aborted) process.exit(0);
    stopper.abort();
  };
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, onSignal);
  connect({ stop: stopper.signal }).then(
    (code) => process.exit(code),
    () => {
      process.stdout.write(`${PAIR_MESSAGES.unreachable}\n`);
      process.exit(1);
    },
  );
}
