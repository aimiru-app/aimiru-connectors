// Command line for Aimiru's check for Codex (ADR-0091):
//   aimiru-codex init [--aimiru-url <address>] [--paste-key] [--email <your Aimiru email>] [--wait <seconds>]
//   aimiru-codex doctor [--json]
//   aimiru-codex uninstall
//
// init: gets a key (AIMIRU_AGENT_TOKEN or SAYSO_AGENT_TOKEN, a hidden prompt with --paste-key, or pairing by code), saves
// it owner-only in ~/.sayso/codex, copies the check to ~/.sayso/codex/app, adds it to Codex's
// hooks.json, and tells Aimiru it is installed and waits for the person's trust in Codex (Advised).
// The tier changes to Enforced (shown as Guardrail, ADR-0148) only when the check itself first runs inside Codex.
// Never prints the key.
//
// Pairing by code (ADR-0034, ADR-0150): with no address given, Aimiru's own, https://aimiru.app (or
// the one a kept request was made for); the page opens in the person's browser by itself
// (open-page.mjs) and the link is shown for a phone; one run waits as long as the request lasts,
// saying each minute how long it has left. Stopped before the person connects it (--wait, Ctrl+C, a
// time limit), it says it is still waiting, keeps the request and exits 0 with nothing installed
// yet; the next init waits on the same code.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openPage as openInBrowser } from './vendor/open-page.mjs';
import {
  PAIR_MAX_WAIT_MS,
  PAIR_MESSAGES,
  dropPendingPairing,
  pairAgent,
  pendingLasts,
  readPendingPairing,
  resumeFrom,
  waitForPractice,
  writeKeyFile,
  writePendingPairing,
} from './vendor/pair.mjs';
import { installSource, normaliseBaseUrl, setting } from './vendor/sayso-client.mjs';
import { MESSAGES } from './vendor/messages.mjs';
import { pauseHoldOn } from './vendor/pause-watch.mjs';
import {
  AGENT_LABEL,
  CODEX_TIMEOUT_S,
  CONNECTOR,
  COVERS,
  PACKAGE_NAME,
  PAUSE_HOLDS,
  UNDO_LINE,
  VERSION,
  codexHomeOf,
  dataDirOf,
  keyFilePath,
  loadSettings,
  makeClient,
  ranSinceInstall,
  stateStore,
} from './lib/runtime.mjs';
import { appDirOf, codexSettingsFacts, commandPaths, copyApp, findOurHook, hookKeyOf, installHook, stableNodePath, uninstallHook } from './lib/install.mjs';
import { WORDS } from './lib/words.mjs';

const KEY_RE = /^sayso_agt_[A-Za-z0-9_-]{43}$/;
/**
 * The tier as people read it. Codex held by its own check shows as Guardrail (ADR-0148): a word on
 * screens only, over the tier Aimiru stores and sends, which stays enforced; never stronger than it.
 */
const TIER_NAMES = { enforced: 'Guardrail', routed: 'Routed', advised: 'Advised' };
/** Aimiru's own address: where init connects when nothing names another (ADR-0150). */
export const DEFAULT_ADDRESS = 'https://aimiru.app';
/** The request to connect, kept while it lasts so the next init waits on the same code. */
const PENDING_FILE = 'pairing.json';
/** How often init says it is still waiting for the person. */
const REMIND_EVERY_MS = 60_000;
/** What the person runs again to keep waiting on the same code. */
const INIT_AGAIN = `npx ${PACKAGE_NAME}@next init`;

const HELP = `${PACKAGE_NAME} ${VERSION}: Aimiru's check for Codex

Usage:
  ${PACKAGE_NAME} init [options]       add Aimiru's check to Codex and connect it to Aimiru
      --aimiru-url <address>           your Aimiru address, from Aimiru under Agents, Codex
                                       (${DEFAULT_ADDRESS} when left out; --sayso-url works too)
      --paste-key                      paste a key instead of picking a code in your browser
      --email <your Aimiru email>      the request to connect also reaches your phone
      --wait <seconds>                 how long to wait for you to connect it (at most 10 minutes)
  ${PACKAGE_NAME} doctor [--json]      check that everything works
  ${PACKAGE_NAME} uninstall            take Aimiru's check out of Codex

After init, open Codex, type /hooks and trust "Checking with Aimiru".`;

export function parseArgs(argv) {
  const out = { command: 'help', flags: {} };
  const rest = [...argv];
  if (rest[0] && !rest[0].startsWith('-')) out.command = rest.shift();
  for (let i = 0; i < rest.length; i += 1) {
    const a = rest[i];
    if (a === '--help' || a === '-h') out.command = 'help';
    else if (a === '--version' || a === '-v') out.command = 'version';
    else if (a.startsWith('--')) {
      const [k, v] = a.slice(2).split('=', 2);
      const key = k.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
      if (v !== undefined) out.flags[key] = v;
      else if (rest[i + 1] !== undefined && !rest[i + 1].startsWith('--')) out.flags[key] = rest[++i];
      else out.flags[key] = true;
    }
  }
  return out;
}

/** Reads a hidden line from a terminal (the key is not shown while it is typed). */
async function promptHidden(question, { stdin = process.stdin, stdout = process.stderr } = {}) {
  if (!stdin.isTTY) return '';
  stdout.write(question);
  stdin.setRawMode(true);
  stdin.resume();
  stdin.setEncoding('utf8');
  return new Promise((resolve) => {
    let value = '';
    const onData = (ch) => {
      for (const c of ch) {
        if (c === '\r' || c === '\n' || c === '\u0004') {
          stdin.setRawMode(false);
          stdin.pause();
          stdin.off('data', onData);
          stdout.write('\n');
          resolve(value.trim());
          return;
        }
        if (c === '\u0003') {
          stdin.setRawMode(false);
          process.exit(130);
        }
        if (c === '\u007f') value = value.slice(0, -1);
        else value += c;
      }
    };
    stdin.on('data', onData);
  });
}

/** The running Codex version, from `codex --version` (null when Codex is not on this PATH). */
export function codexVersion(env = process.env, { timeoutMs = 3_000 } = {}) {
  try {
    const r = spawnSync(setting(env, 'CODEX_BIN') || 'codex', ['--version'], { encoding: 'utf8', timeout: timeoutMs, stdio: ['ignore', 'pipe', 'ignore'], env });
    const v = /(\d+\.\d+\.\d+(?:[-.][0-9A-Za-z.]+)?)/.exec(r.stdout || '');
    return v ? v[1].slice(0, 40) : null;
  } catch {
    return null;
  }
}

/** The report init sends: installed, and waiting for the person to trust it in Codex. */
export function installReport({ codexVersion: cv = null, source = 'unknown', checksOff = false } = {}) {
  return {
    connector: CONNECTOR,
    version: VERSION,
    client_version: cv,
    install_source: source,
    environment: {
      step: 'install',
      // Codex skips a new or changed check until the person trusts it: not run yet.
      hook_ran: false,
      hooks_enabled: !checksOff,
      on_failure_block: true,
      covers: [...COVERS],
      platform: process.platform,
      node: process.versions.node,
    },
  };
}

/**
 * The address init connects to: --aimiru-url; the request an init before this one kept, while it is
 * worth a poll (pendingLasts: an init run again as the still waiting line says, with no address,
 * collects that request's key); AIMIRU_BASE_URL or the address the saved key was made for; else
 * https://aimiru.app.
 */
export function addressOf({ given = null, pending = null, settings = {}, now = Date.now() } = {}) {
  if (given) return given;
  if (pendingLasts(pending, now)) return pending.base_url;
  return settings.baseUrl || DEFAULT_ADDRESS;
}

/** Resolves 'stopped' once `stop` fires; never, when there is no stop. */
function stopped(stop) {
  if (!stop) return new Promise(() => {});
  if (stop.aborted) return Promise.resolve('stopped');
  return new Promise((resolve) => stop.addEventListener('abort', () => resolve('stopped'), { once: true }));
}

/**
 * @param {object} o
 * @param {string} [o.saysoUrl] @param {boolean} [o.pasteKey] @param {string} [o.email]
 * @param {number} [o.waitS] how long this run waits for the person to connect it (default: as long as the request lasts)
 * @param {object} [o.env] @param {(s: string) => void} [o.print]
 * @param {string} [o.nodePath] the Node.js Codex runs the check with (default: this one)
 * @param {object} [o.pairing] test seams for pairing: {fetch, sleep, now, practiceWaitMs}
 * @param {(url: string) => Promise<boolean>} [o.openPage] opens the pairing page (default: the person's browser, open-page.mjs)
 * @param {AbortSignal} [o.stop] ends the wait early (main wires SIGINT, SIGTERM and SIGHUP to it)
 * @param {() => Promise<string>} [o.readKey] test seam for the hidden prompt
 * @returns {Promise<number>} exit code
 */
export async function init(o = {}) {
  const env = o.env || process.env;
  const print = o.print || ((s) => process.stdout.write(`${s}\n`));
  // The entry starts Node through /usr/bin/env: on Windows it would not start, and Codex would run
  // every call unchecked. Refuse rather than install something that does not hold.
  if ((o.platform || process.platform) === 'win32') {
    print(WORDS.notWindows);
    return 1;
  }
  const dataDir = dataDirOf(env);
  const codexHome = codexHomeOf(env);
  const settings = loadSettings(env);
  const pendingFile = path.join(dataDir, PENDING_FILE);
  const pending = readPendingPairing(pendingFile);

  let url;
  try {
    url = normaliseBaseUrl(addressOf({ given: o.saysoUrl, pending, settings }));
  } catch (e) {
    print(WORDS.badAddress(e.message));
    return 1;
  }

  // The key: the environment, the key saved before for this address, a hidden prompt, or pairing.
  let key = (setting(env, 'AGENT_TOKEN') || '').trim();
  if (!key && settings.keySource === 'file' && settings.baseUrl === url) key = settings.token;
  let paired = null;
  let failed = false;
  if (!key && o.pasteKey !== true) {
    const seams = o.pairing || {};
    const waitS = Number(o.waitS);
    const result = await pairAgent({
      baseUrl: url,
      agent: { name: AGENT_LABEL, kind: 'mcp_proxy', host: os.hostname() },
      connector: { name: CONNECTOR, version: VERSION },
      personEmail: o.email || null,
      say: print,
      maxWaitMs: Number.isFinite(waitS) && waitS > 0 ? Math.min(waitS * 1000, PAIR_MAX_WAIT_MS) : PAIR_MAX_WAIT_MS,
      resume: resumeFrom(pending, url),
      onStarted: (started) => writePendingPairing(pendingFile, started),
      openPage: o.openPage || ((page) => openInBrowser(page, { baseUrl: url, env })),
      remindEveryMs: REMIND_EVERY_MS,
      signal: o.stop || null,
      ...(seams.fetch ? { fetch: seams.fetch } : {}),
      ...(seams.sleep ? { sleep: seams.sleep } : {}),
      ...(seams.now ? { now: seams.now } : {}),
    });
    if (result.ok) {
      dropPendingPairing(pendingFile);
      key = result.agentKey;
      paired = result;
      print(PAIR_MESSAGES.connected(result.name));
    } else if (result.reason === 'waiting') {
      // Not connected yet is not a failure (Mac run part 1, item 3): nothing is installed before it
      // is, and the next init waits on the same code.
      print(PAIR_MESSAGES.stillWaitingRun(INIT_AGAIN));
      return 0;
    } else {
      if (['declined', 'expired', 'used'].includes(result.reason)) dropPendingPairing(pendingFile);
      print(result.message);
      failed = true;
    }
  }
  if (!key && !failed) key = o.readKey ? await o.readKey() : await promptHidden(WORDS.pasteKey);
  if (key && !KEY_RE.test(key)) {
    print(WORDS.notAKey);
    return 1;
  }
  // Saved even when it came from the environment: Codex may start the check without that variable.
  if (key) {
    writeKeyFile(keyFilePath(dataDir), { agentKey: key, baseUrl: url, agentId: paired?.agentId ?? null, name: paired?.name ?? AGENT_LABEL });
    print(WORDS.savedKey(keyFilePath(dataDir)));
  }

  // The check, in a folder that outlives npx's cache, and its entry in Codex's settings.
  const appDir = copyApp(appDirOf(dataDir));
  print(WORDS.copied(appDir));
  let hook;
  try {
    hook = installHook({ codexHome, appDir, nodePath: o.nodePath || stableNodePath(process.execPath, env.PATH) });
  } catch {
    print(WORDS.badSettings(path.join(codexHome, 'hooks.json')));
    return 1;
  }
  print(hook.replaced ? WORDS.replaced(hook.file) : WORDS.installed(hook.file));
  if (hook.backup) print(WORDS.backedUp(hook.backup));
  const facts = codexSettingsFacts({ codexHome, hookKey: hookKeyOf(hook.file, hook.groupIndex) });
  if (facts.checksOff) print(WORDS.checksOff);

  // Tell Aimiru: installed, covering these, not run inside Codex yet (Advised until it does).
  const store = stateStore(dataDir, { secret: key });
  const cv = codexVersion(env);
  const source = installSource({ env, modulePath: import.meta.url });
  // Where the entry sits is not where the person trusted it: only a run inside Codex records that
  // (pre-tool-use.mjs), so the doctor never says the trust holds before there was any (wave 10, T5).
  // installed_at is this computer's own note of every init, kept even when the report to Aimiru below
  // fails: a run recorded before it no longer shows the trust (wave 10 review, finding 6).
  store.updateStatus({ install_source: source, codex_version: cv, installed_version: VERSION, hooks_file: hook.file, installed_at: new Date().toISOString() });
  if (key) {
    const client = makeClient({ ...settings, token: key, baseUrl: url, dataDir });
    const hb = await client.heartbeat(installReport({ codexVersion: cv, source, checksOff: facts.checksOff }), { timeoutMs: 8_000 });
    if (hb.ok) {
      store.updateStatus({ install_reported_at: new Date().toISOString(), tier: hb.data?.tier ?? null, reason: hb.data?.reason ?? null });
      print(WORDS.reported(TIER_NAMES[hb.data?.tier] ?? 'Advised'));
    } else {
      print(WORDS.notReported);
    }
    if (paired) {
      const seams = o.pairing || {};
      const practice = waitForPractice({
        baseUrl: url,
        agentKey: key,
        practice: paired.practice,
        connector: `${CONNECTOR}/${VERSION}`,
        say: print,
        ...(seams.fetch ? { fetch: seams.fetch } : {}),
        ...(seams.practiceWaitMs ? { budgetMs: seams.practiceWaitMs } : {}),
      });
      // Stopped meanwhile: the practice request waits for the person's answer; the trust step still shows.
      if ((await Promise.race([practice, stopped(o.stop)])) === 'stopped') print(PAIR_MESSAGES.practiceWaiting);
    }
  } else {
    print(WORDS.noKey);
  }

  print('');
  print(WORDS.trustTitle);
  print(WORDS.trustStep('/hooks'));
  print(WORDS.trustThen);
  print(WORDS.limit);
  return failed || !key ? 1 : 0;
}

/** What doctor finds, as {check, ok, text}; read-only except one GET /v1/me. */
export async function doctor(o = {}) {
  const env = o.env || process.env;
  const print = o.print || ((s) => process.stdout.write(`${s}\n`));
  const settings = loadSettings(env);
  const appDir = appDirOf(settings.dataDir);
  const store = stateStore(settings.dataDir);
  const status = store.readStatus();
  const checks = [];
  const add = (check, ok, text) => checks.push({ check, ok, text });

  add('key', Boolean(settings.token && settings.baseUrl), WORDS.doctorKey(Boolean(settings.token && settings.baseUrl)));
  if (settings.token && settings.baseUrl) {
    const me = await makeClient(settings, { spool: false }).me();
    // A demo's key after its hour (wave 10, snag 12): say so, with the line that removes the check.
    const ended = !me.ok && me.status === 401 && me.fromSayso !== false && me.code === 'demo_ended';
    add('reach', me.ok, ended ? WORDS.demoEnded(UNDO_LINE) : WORDS.doctorReach(me.ok));
  }
  // Only a run inside Codex since the last init proves the person trusted the check (wave 10, T5,
  // and the review's finding 6: an init whose report failed still counts as an init).
  const ran = ranSinceInstall(status);
  const hook = findOurHook({ codexHome: settings.codexHome, appDir });
  add('installed', hook.present, WORDS.doctorInstalled(hook.present));
  if (hook.present) {
    const paths = commandPaths(hook.command);
    const filesOk = Boolean(paths) && fs.existsSync(paths.nodePath) && fs.existsSync(paths.guardPath) && fs.existsSync(path.join(appDir, 'pre-tool-use.mjs'));
    add('files', filesOk, WORDS.doctorFiles(filesOk));
    const facts = codexSettingsFacts({ codexHome: settings.codexHome, hookKey: hookKeyOf(hook.file, hook.groupIndex, hook.handlerIndex) });
    add('checks_on', !facts.checksOff, WORDS.doctorChecksOn(!facts.checksOff));
    if (facts.turnedOff) add('turned_off', false, WORDS.doctorTurnedOff);
    // A Pause holds Codex's next step only on an entry that gives the check the hour
    // (CODEX_TIMEOUT_S); one an older install wrote (60 s) refuses each step while paused until init
    // runs again (agent-experience review of wk/connectors-flow).
    const holds = pauseHoldOn(env, PAUSE_HOLDS);
    const hourOk = Number(hook.timeout) >= CODEX_TIMEOUT_S;
    add('pause_hold', !holds || hourOk, !holds ? MESSAGES.holdOffLine(AGENT_LABEL) : hourOk ? MESSAGES.holdOnLine(AGENT_LABEL) : WORDS.doctorOldEntry(`npx ${PACKAGE_NAME}@next init`, '/hooks'));
    // Codex keys trust to the entry's place (<hooks.json>:pre_tool_use:<group>:<handler>): an entry
    // added before Aimiru's moves it, and Codex then skips it silently until it is trusted again.
    // The place is the one the last run inside Codex recorded; before any, nothing was trusted yet.
    if (ran && Number.isInteger(status.group_index)) {
      const same = status.group_index === hook.groupIndex && (status.handler_index ?? 0) === hook.handlerIndex;
      add('position', same, WORDS.doctorMoved(same));
    }
  }
  add('ran', ran, WORDS.doctorRan(ran));
  // How an ask holds a step (ADR-0145), as Claude Code's doctor says it.
  add('ask_hold', true, MESSAGES.waitHold);
  if (o.json) print(JSON.stringify({ connector: CONNECTOR, version: VERSION, checks: checks.map(({ check, ok }) => ({ check, ok })), tier: status.tier ?? null }, null, 2));
  else for (const c of checks) print(`${c.ok ? 'ok  ' : 'fix '} ${c.text}`);
  const moved = checks.some((c) => c.check === 'position' && !c.ok);
  if ((!ran || moved) && !o.json) print(WORDS.trustStep('/hooks'));
  return checks.every((c) => c.ok) ? 0 : 1;
}

export async function uninstall(o = {}) {
  const env = o.env || process.env;
  const print = o.print || ((s) => process.stdout.write(`${s}\n`));
  const dataDir = dataDirOf(env);
  const r = uninstallHook({ codexHome: codexHomeOf(env), appDir: appDirOf(dataDir) });
  print(r.removed ? WORDS.removed(r.file) : WORDS.nothingToRemove(r.file));
  return 0;
}

export async function main(argv = process.argv.slice(2)) {
  const { command, flags } = parseArgs(argv);
  if (command === 'help') {
    process.stdout.write(`${HELP}\n`);
    return 0;
  }
  if (command === 'version') {
    process.stdout.write(`${VERSION}\n`);
    return 0;
  }
  if (command === 'init') {
    // --aimiru-url, or --sayso-url as the commands made before the rename (ADR-0093) say.
    const url = [flags.aimiruUrl, flags.saysoUrl].find((v) => typeof v === 'string');
    // Stopped from outside (Ctrl+C, a time limit, the terminal closing): the wait ends between polls
    // with the still waiting line and exit 0. A second signal ends it at once.
    const stopper = new AbortController();
    const onSignal = () => {
      if (stopper.signal.aborted) process.exit(0);
      stopper.abort();
    };
    const signals = ['SIGINT', 'SIGTERM', 'SIGHUP'];
    for (const s of signals) process.on(s, onSignal);
    try {
      return await init({
        saysoUrl: url,
        pasteKey: flags.pasteKey === true,
        email: typeof flags.email === 'string' ? flags.email : null,
        waitS: typeof flags.wait === 'string' ? Number(flags.wait) : null,
        stop: stopper.signal,
      });
    } finally {
      for (const s of signals) process.off(s, onSignal);
    }
  }
  if (command === 'doctor') return doctor({ json: flags.json === true });
  if (command === 'uninstall') return uninstall();
  process.stderr.write(`Unknown command "${command}".\n\n${HELP}\n`);
  return 2;
}
