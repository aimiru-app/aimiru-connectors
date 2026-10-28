#!/usr/bin/env node
// Aimiru for Claude Code: doctor (`node scripts/doctor.mjs`, also accepts --doctor; --json for machines).
//
// Checks, in order: Node.js, the Claude Code version (2.1.295 or later blocks a call when the check
// itself fails), the plugin's own files, the key and Aimiru address, a live call to GET /v1/me
// (agent name, the tier Aimiru computes, and whether asks reach the person's phone), the last
// session's report, records waiting to be sent, and whether the Claude Code settings can be read
// for "Claude Code would have asked you N times".
// Never prints the key.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  AGENT_LABEL,
  CONNECTOR,
  MARKETPLACE_SOURCE,
  MIN_ENFORCED_VERSION,
  PAUSE_HOLDS,
  PLUGIN_ID,
  REINSTALL_LINES,
  VERSION,
  compareVersions,
  detectClaudeCodeVersion,
  findDataDir,
  loadSettings,
  makeClient,
  skillVersion,
  stateStore,
} from './lib/runtime.mjs';
import { PAUSE_TRACE_FILE, createSpool, isDemoEnded, readTrace } from './vendor/sayso-client.mjs';
import { CLAUDE_CODE_CONNECT, MESSAGES, clockOf, reachFinding, tierWord } from './vendor/messages.mjs';
import { localReadsOn } from './vendor/local.mjs';
import { pauseHoldOn } from './vendor/pause-watch.mjs';
import { readPermissionSettings, settingsFiles } from './lib/native-prompt.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const pluginRoot = path.resolve(here, '..');
const asJson = process.argv.includes('--json');

const results = [];
function ok(id, text) {
  results.push({ id, ok: true, text });
}
function fix(id, text, todo) {
  results.push({ id, ok: false, text, fix: todo });
}
function note(id, text) {
  results.push({ id, ok: true, note: true, text });
}

async function main() {
  // The data folder first: the key /aimiru:connect saved lives there (ADR-0034).
  // Claude Code sets CLAUDE_PLUGIN_DATA only for its own runs: find the folder the hooks use.
  const settings = loadSettings({ ...process.env, CLAUDE_PLUGIN_DATA: findDataDir(process.env) });

  // 1. Node.js
  const nodeMajor = Number(process.versions.node.split('.')[0]);
  if (nodeMajor >= 18) ok('node', `Node.js ${process.versions.node} is ready.`);
  else fix('node', `Node.js ${process.versions.node} is too old.`, 'Install Node.js 18 or later.');

  // 2. Claude Code
  const cc = detectClaudeCodeVersion(process.env, { allowSpawn: true, timeoutMs: 5_000 });
  if (!cc) fix('claude_code', 'Claude Code was not found.', 'Install Claude Code, or run this from a terminal where `claude --version` works.');
  else if (compareVersions(cc, MIN_ENFORCED_VERSION) >= 0) ok('claude_code', `Claude Code ${cc} stops an action when the check with Aimiru cannot finish.`);
  else fix('claude_code', `Claude Code ${cc} lets an action through when the check with Aimiru cannot finish, so Aimiru shows it as Advised.`, `Update Claude Code to ${MIN_ENFORCED_VERSION} or later: claude update`);

  // 3. Plugin files. The fix is the reinstall Aimiru's own page gives for this finding (REINSTALL_LINES):
  // the install lines alone copy nothing over a plugin that is still installed.
  const reinstall = `Reinstall it, then restart Claude Code: ${REINSTALL_LINES.join(', then ')}. The key /aimiru:connect saved stays; a key and address pasted with /plugin configure ${PLUGIN_ID} need pasting again. If Claude Code no longer knows the marketplace aimiru, first run claude plugin marketplace add ${MARKETPLACE_SOURCE} (with #next on the pre-release).`;
  try {
    const hooks = JSON.parse(fs.readFileSync(path.join(pluginRoot, 'hooks', 'hooks.json'), 'utf8'));
    const pre = hooks?.hooks?.PreToolUse?.[0]?.hooks?.[0];
    if (pre?.onFailure === 'block') ok('plugin', `Aimiru for Claude Code ${VERSION} checks each action before it runs.`);
    else fix('plugin', 'The plugin files are changed: a failed check would not stop the action.', reinstall);
  } catch {
    fix('plugin', 'The plugin files are missing.', reinstall);
  }

  // 3b. The Aimiru routine (skills/sayso/SKILL.md), which the heartbeat reports (ADR-0037)
  const routine = skillVersion({ ...settings, pluginRoot });
  if (routine) ok('routine', `Claude Code has the Aimiru routine (version ${routine}): when to check with Aimiru, and what to do while a question to you is open.`);
  else fix('routine', 'The Aimiru routine is missing from the plugin, so Aimiru shows that Claude Code has not loaded it.', 'Update: claude plugin update aimiru@aimiru');

  // The Aimiru that answered, when it keeps a doctor's findings apart from the agent's own reports.
  let reportTo = null;

  // 4 and 5. Key, address and a live call
  const store = stateStore(settings.dataDir);
  const last = store.readStatus();
  const haveKey = Boolean(settings.token);
  const haveUrl = Boolean(settings.baseUrl);
  if (!haveKey || !haveUrl) {
    if (last?.configured) {
      note('key', 'Claude Code keeps your Aimiru key. To check the connection from this terminal, set AIMIRU_AGENT_TOKEN and AIMIRU_BASE_URL first.');
    } else {
      // Wave 10, snag 4: the key the person was given first, pairing second, by the plugin's full id.
      fix('key', 'Aimiru for Claude Code has no key yet.', CLAUDE_CODE_CONNECT);
    }
  } else {
    // Pairing (ADR-0034): the key /aimiru:connect saved, in the plugin's data folder.
    if (settings.keySource === 'file') ok('key', 'Using the key /aimiru:connect saved, readable only by you.');
    const client = makeClient(settings, { spool: false });
    if (!client.configured) {
      fix('address', 'The Aimiru address is not a valid https address.', 'Copy the address again from Aimiru, under Agents.');
    } else {
      const me = await client.me();
      if (me.ok) {
        const agent = me.data?.agent || {};
        const tier = tierWord(agent.tier);
        ok('connection', `Connected to Aimiru as ${agent.name || 'this agent'}. Aimiru shows it as ${tier}.`);
        if (me.data?.space?.paused) note('paused', 'Everything is paused in Aimiru. Nothing runs until you resume.');
        else if (agent.status === 'paused') note('paused', `${agent.name || 'This agent'} is paused in Aimiru. Nothing runs until you resume it.`);
        // Whether asks reach the person's phone (ADR-0033): a warning, never a failure.
        const reach = reachFinding(me.data);
        if (reach) (reach.ok ? ok : note)('reach', reach.text);
        // How an ask holds a step (ADR-0145: a few seconds whatever the reach, so the line names no
        // phone and holds in a demo too), when the person last answered, and whether reads are
        // decided here (ADR-0095), when Aimiru says.
        note('wait', MESSAGES.waitHold);
        if (me.data?.reach && typeof me.data.reach === 'object') {
          const last = Date.parse(me.data.reach.last_answer_at ?? '');
          if (Number.isFinite(last)) note('last_answer', MESSAGES.lastAnswer(new Date(last).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })));
        }
        if ('local' in (me.data || {})) note('local', me.data.local && localReadsOn() ? MESSAGES.localOn : MESSAGES.localOff);
        const min = me.data?.connector_min_versions?.['claude-code'];
        if (min && compareVersions(VERSION, min) < 0) fix('version', `Aimiru asks for Aimiru for Claude Code ${min} or later.`, 'Update: claude plugin update aimiru@aimiru');
        if (me.data?.doctor_report === true) reportTo = client;
      } else if (me.fromSayso === false) {
        fix('connection', `Something between this computer and Aimiru refused the request (${me.status}), so Aimiru never saw it.`, 'Check the Aimiru address, and any firewall or network filter on this computer.');
      } else if (isDemoEnded(me)) {
        // Wave 10, snag 12: the key belonged to a demo whose time is over.
        fix('connection', 'The demo has ended, so Aimiru no longer takes this key.', `To remove Aimiru, run: ${client.undoLine}`);
      } else if (me.status === 401) {
        fix('connection', 'Aimiru does not recognise this key.', settings.keySource === 'file' ? 'Run /aimiru:connect --again in Claude Code to connect it again.' : 'Reconnect Claude Code in Aimiru, under Agents, and add the new key with /plugin configure aimiru@aimiru, then restart Claude Code.');
      } else {
        fix('connection', `Aimiru could not be reached (${me.code || me.kind}).`, 'Check the address and your connection, then run this again.');
      }
    }
  }

  // 6. Last session
  if (last?.ts) {
    if (last.reachable && last.tier) note('last_session', `The last session reported to Aimiru at ${last.ts}. Aimiru showed ${tierWord(last.tier)}${last.reason ? `: ${last.reason}` : ''}.`);
    else if (last.configured) note('last_session', `The last session, at ${last.ts}, could not reach Aimiru (${last.error || 'no answer'}).`);
  } else {
    note('last_session', 'No session has reported to Aimiru from this computer yet.');
  }

  // 6b. Pause (ADR-0142): whether a Pause holds the next step or refuses each one, and the last Pause
  // this computer confirmed, from its own trace.
  note('pause_hold', pauseHoldOn(process.env, PAUSE_HOLDS) ? MESSAGES.holdOnLine(AGENT_LABEL) : MESSAGES.holdOffLine(AGENT_LABEL));
  const confirmed = readTrace(settings.dataDir, PAUSE_TRACE_FILE).filter((l) => l?.event === 'acknowledged' && typeof l.pause_at === 'string').at(-1);
  if (confirmed && clockOf(confirmed.pause_at)) note('pause_confirmed', MESSAGES.pauseConfirmed(AGENT_LABEL, clockOf(confirmed.pause_at), confirmed.ms_after_tap));

  // 7. Work your other agents hand on (ADR-0043, ADR-0145): not part of this release. Aimiru closes
  // the door to it for every agent (ADR-0141), so the computer's own setting turns nothing on, and the
  // doctor never offers it (agent-experience and devrel review of wk/connectors-flow).
  note('tasks', 'Work handed between agents is off for now.');

  // 8. Waiting records
  const waiting = createSpool(settings.dataDir).size();
  if (waiting > 0) note('waiting', `${waiting} record${waiting === 1 ? ' is' : 's are'} waiting to be sent to Aimiru. They are sent with the next action.`);

  // 8. "Claude Code would have asked you N times" (ADR-0040): worked out from the settings files here.
  try {
    const lists = readPermissionSettings(settingsFiles({ projectDir: settings.projectDir || process.cwd() }));
    if (lists.unreadable.length === 0) {
      note('native_prompts', 'Aimiru can read your Claude Code settings, so it counts what Claude Code would have asked you.');
    } else {
      note(
        'native_prompts',
        `Aimiru cannot read your Claude Code ${[...new Set(lists.unreadable)].join(' and ')} settings, so its count of what Claude Code would have asked you is an estimate.`,
      );
    }
  } catch {
    // the count is not the doctor's business to fail on
  }

  // 9. Tell Aimiru what this check found (ADR-0054), so the person's page for this agent can say
  // what to fix. Only the check ids and whether each passed; never the text, a path or the key.
  // Only to an Aimiru that keeps them apart from the agent's own reports (GET /v1/me says so): an
  // older one would take this for a session's report and lower the tier. Never fails the doctor.
  if (reportTo) {
    const checks = results.filter((r) => !r.note).map((r) => ({ check: r.id, ok: r.ok }));
    try {
      const sent = await reportTo.heartbeat({ connector: CONNECTOR, version: VERSION, source: 'doctor', doctor: checks.slice(0, 30) });
      if (sent?.ok) note('reported', 'Aimiru has what this check found, so its page for this agent shows anything to fix.');
    } catch {
      // the report is a convenience; the findings above stand
    }
  }

  if (asJson) {
    process.stdout.write(`${JSON.stringify({ ok: results.every((r) => r.ok), results }, null, 2)}\n`);
  } else {
    for (const r of results) {
      const mark = r.ok ? (r.note ? '  ' : 'ok') : '!!';
      process.stdout.write(`${mark} ${r.text}\n`);
      if (r.fix) process.stdout.write(`   Fix: ${r.fix}\n`);
    }
  }
  return results.every((r) => r.ok) ? 0 : 1;
}

main().then(
  (code) => process.exit(code),
  () => process.exit(1),
);
