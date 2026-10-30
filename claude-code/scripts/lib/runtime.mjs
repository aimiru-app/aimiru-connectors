// Shared plumbing for the Aimiru for Claude Code scripts: settings, stdin, local state, versions.

import { spawnSync } from 'node:child_process';
import { createHmac, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AIMIRU_PLUGIN_NAMES, claudeConfigDirPaths } from '../vendor/classify.mjs';
import { createLocalState, refreshLocal } from '../vendor/local.mjs';
import { readKeyFile } from '../vendor/pair.mjs';
import { createPauseWatch } from '../vendor/pause-watch.mjs';
import { readSkillVersion } from '../vendor/routine.mjs';
import { ASK_HOLD_MS, createPauseMemory, createAimiruClient, installSource, setting, sha256Hex } from '../vendor/aimiru-client.mjs';
import { CLAUDE_CODE_CONNECT } from '../vendor/messages.mjs';

export const CONNECTOR = 'claude-code';
export const VERSION = '0.3.0-rc.3';
/** onFailure: "block" makes a failed or timed-out check block the call (Claude Code 2.1.295, CHANGELOG). */
export const MIN_ENFORCED_VERSION = '2.1.295';
export const AGENT_LABEL = 'Claude Code';

/**
 * The most one hook's context for Claude may hold (code.claude.com/docs/en/hooks, read 29 Oct 2026):
 * over 10,000 characters, Claude Code saves it to a file and gives Claude the file's path and a
 * 2,000-character preview instead, without asking Claude to read the file. So a context stays within
 * it, and the person's brief is what gives way (ADR-0157, quality review).
 */
export const CONTEXT_MAX_CHARS = 10_000;

/**
 * A context for Claude from its parts, in order, with the person's brief only when the whole stays
 * within CONTEXT_MAX_CHARS: a brief that does not fit is left out whole, never cut, and the rest (the
 * job, a late yes) goes as before. withBrief(true) and withBrief(false) build the two; {text, brief}
 * says which was used.
 */
export function fitContext(withBrief) {
  const full = withBrief(true);
  if (full.length <= CONTEXT_MAX_CHARS) return { text: full, brief: true };
  return { text: withBrief(false), brief: false };
}

/**
 * Whether a GET /v1/brief at session start missed (CC6): no answer in time, no connection, a server
 * error, or an answer from something on the way rather than Aimiru. Then the session's first prompt
 * asks once more (user-prompt-submit.mjs). Aimiru's own answers are no miss: a brief, an empty one,
 * 403 and 404 (not open to this agent), 423 (paused), 401, or a malformed brief.
 */
export function briefMissed(r) {
  if (!r || typeof r !== 'object') return true;
  if (r.ok) return false;
  if (r.kind === 'timeout' || r.kind === 'network') return true;
  return r.kind === 'http' && (r.fromAimiru === false || r.status >= 500);
}

/** Whether this computer holds the person's Pause for this agent now (the last word Aimiru gave, ADR-0022). */
export function pausedHere(settings) {
  try {
    return createPauseMemory(settings.dataDir).get()?.paused === true;
  } catch {
    return false;
  }
}

/**
 * Where this plugin was installed from, for the heartbeat (ADR-0041): the Claude Code plugin
 * marketplace when Claude Code runs it from ~/.claude/plugins (or from the plugins folder of the
 * settings folder CLAUDE_CONFIG_DIR names), npm from node_modules, else unknown (a local folder).
 * AIMIRU_INSTALL_SOURCE overrides. Only the one word leaves.
 */
export function pluginInstallSource(env = process.env) {
  const modulePath = env.CLAUDE_PLUGIN_ROOT || import.meta.url;
  return installSource({ env, modulePath, hint: inConfigPlugins(env, modulePath) ? 'marketplace' : null });
}

/**
 * Claude Code's own settings folder: the one CLAUDE_CONFIG_DIR names when Claude Code was started
 * with its own (an isolated run, a second account), else ~/.claude. It holds the person's settings
 * (settings.json), the installed plugins and their data folders (plugins) and, with the variable,
 * the rest of Claude Code's state (.claude.json, which is ~/.claude.json without it).
 */
export function claudeConfigDir(env = process.env) {
  if (env.CLAUDE_CONFIG_DIR) return path.resolve(env.CLAUDE_CONFIG_DIR);
  return path.join(env.HOME || env.USERPROFILE || os.homedir(), '.claude');
}

/** True when this plugin runs from the plugins folder of the settings folder CLAUDE_CONFIG_DIR names. */
function inConfigPlugins(env, modulePath) {
  if (!env.CLAUDE_CONFIG_DIR || typeof modulePath !== 'string' || !modulePath) return false;
  let where = modulePath;
  if (where.startsWith('file:')) {
    try {
      where = fileURLToPath(where);
    } catch {
      return false;
    }
  }
  return path.resolve(where).startsWith(path.join(claudeConfigDir(env), 'plugins') + path.sep);
}

/**
 * The files in the settings folder CLAUDE_CONFIG_DIR names that Aimiru guards as it guards
 * ~/.claude's (isProtectedPath in classify.mjs knows those by name): the person's settings, the rest
 * of Claude Code's state, and the installed plugins with their data. Changing one can turn Aimiru
 * off, so it is a protected change, held while Aimiru cannot answer. Each is named by the folder's
 * name, by its real one when the folder is a link, and by the other name a Mac gives either
 * (claudeConfigDirPaths, which Codex's check uses for the same files). Empty without the variable.
 */
export function protectedConfigPaths(env = process.env) {
  if (!env.CLAUDE_CONFIG_DIR) return [];
  return claudeConfigDirPaths(claudeConfigDir(env));
}

/**
 * Overall budget for one PreToolUse check (ADR-0145): a check with Aimiru takes at most 10 s, and an
 * ask holds the step at most 4 s, so 30 s leaves room for a slow answer and a retry after a 429.
 * Every network call in a run is bounded by it, so the script always answers before Claude Code gives
 * up on it (on Claude Code older than 2.1.295 a check that runs out of time lets the action through).
 */
export const HOOK_BUDGET_MS = 30_000;

/** The run's budget: AIMIRU_HOOK_BUDGET_MS can only make it shorter, never longer than HOOK_BUDGET_MS. */
export function hookBudgetMs(env = process.env) {
  return Math.min(HOOK_BUDGET_MS, intFromEnv(env, 'HOOK_BUDGET_MS', HOOK_BUDGET_MS));
}
/**
 * How long an ask holds the step (ADR-0145): 4 s whatever the person's reach, 0 in quiet hours.
 * AIMIRU_ASK_BUDGET_MS, when set, can only make it shorter.
 */
export const DEFAULT_ASK_BUDGET_MS = ASK_HOLD_MS;

/**
 * Pause holds (ADR-0142): a step the check sees while this agent is paused waits for Resume (at most
 * 55 minutes, inside the check's 3600 s in hooks.json) instead of being refused. The one switch for
 * the Mac run's finding: if Claude Code does not wait 90 s on a check, set this to false and every
 * step is refused while paused, as before (ADR-0022). AIMIRU_PAUSE_HOLD=0 does the same on one computer.
 */
export const PAUSE_HOLDS = true;

/** The Pause watch for this plugin's data folder (pause-watch.mjs): one agent on this computer. */
export function watchFor(settings) {
  return createPauseWatch({ dataDir: settings.dataDir });
}

/** How long one watcher runs (watch.mjs): 140 s after a prompt or a step, 30 s after a turn ends. */
export const WATCH_BUDGET_MS = 140_000;
export const WATCH_STOP_BUDGET_MS = 30_000;
/** After a turn ends, a watcher waits for a yes to this session's open questions at most this long (CN10). */
export const WATCH_OPEN_QUESTIONS_MS = 14 * 60_000;

/**
 * A later yes wakes Claude Code to take that exact step (ADR-0145, CN10): the watcher, on an
 * asyncRewake hook, exits 2 with the step for Claude, which takes it at once instead of at the
 * person's next message. Off until the Mac run proves Claude Code honours asyncRewake in a plugin's
 * hooks: until then a yes reaches the step at the next message (user-prompt-submit.mjs), at session
 * start, or on Claude's own retry, as before. AIMIRU_WAKE_ON_YES=1 turns it on on one computer.
 */
export const WAKE_ON_YES = false;

/** Whether the watcher wakes Claude for a later yes: the switch, or AIMIRU_WAKE_ON_YES (0 or 1). */
export function wakesOnYes(env = process.env) {
  const v = String(setting(env, 'WAKE_ON_YES') ?? '').trim();
  if (v === '1') return true;
  if (v === '0') return false;
  return WAKE_ON_YES;
}

/** A watcher's budget for a hook event; AIMIRU_WATCH_BUDGET_MS can only make it shorter (tests). */
export function watchBudgetMs(event, env = process.env) {
  const base = event === 'Stop' ? WATCH_STOP_BUDGET_MS : WATCH_BUDGET_MS;
  return Math.min(base, intFromEnv(env, 'WATCH_BUDGET_MS', base));
}

/**
 * One watcher per Claude Code session (watch.mjs): {take(until), mine(), release()}. A new watcher
 * takes over only from one that is gone, or that ends more than 30 s before it would, so a busy
 * session hands over before its watcher's time runs out instead of starting one for every step; the
 * one taken over sees it within a second and ends.
 */
export function sessionWatchLock(dataDir, session, { marginMs = 30_000 } = {}) {
  const file = path.join(dataDir, 'watchers', `${sha256Hex(`watch:${String(session ?? '')}`).slice(0, 40)}.json`);
  const holder = () => readJsonFile(file);
  const alive = (pid) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch (e) {
      return e?.code === 'EPERM';
    }
  };
  return {
    file,
    take(until, now = Date.now()) {
      const cur = holder();
      const running = cur && Number.isInteger(cur.pid) && cur.pid !== process.pid && Number(cur.until) > now && alive(cur.pid);
      if (running && !(Number(cur.until) < until - marginMs)) return false;
      try {
        writeJsonFile(file, { pid: process.pid, until });
      } catch {
        return false;
      }
      return holder()?.pid === process.pid;
    },
    mine() {
      return holder()?.pid === process.pid;
    },
    release() {
      try {
        if (holder()?.pid === process.pid) fs.rmSync(file, { force: true });
      } catch {
        // ignore
      }
    },
  };
}

/**
 * True when Claude Code runs in the person's own terminal (CLAUDE_CODE_ENTRYPOINT "cli"): only there
 * does the person go back to the session, so only there is a late yes offered (ADR-0094). Headless
 * runs (-p), the SDK and other front ends are not.
 */
export function isInteractive(env = process.env) {
  return String(env.CLAUDE_CODE_ENTRYPOINT ?? '').trim() === 'cli';
}

/**
 * A waiting question is offered for a late yes while it is still open on this computer (its own
 * end: 15 minutes for money and sends), and never once it is older than this (cleanup's age).
 * Aimiru itself offers a yes only within an hour of the person's answer, not of the question, so
 * "within an hour of your yes" holds however long the question waited (ADR-0094 review).
 */
export const LATE_YES_MS = 24 * 3600_000;
/** A late yes quotes the step back only up to this size (contract §2.2). */
export const QUOTED_INPUT_MAX = 8_000;

/**
 * The step a waiting question was about, as Claude reads it back (JSON of its input), or null when
 * it cannot be quoted: no tool name, no input, or an input over QUOTED_INPUT_MAX characters.
 */
export function quotedStep(call) {
  if (!call || typeof call !== 'object' || typeof call.tool_name !== 'string' || !call.tool_name || call.tool_input == null) return null;
  let quoted;
  try {
    quoted = JSON.stringify(call.tool_input);
  } catch {
    return null;
  }
  return typeof quoted === 'string' && quoted.length <= QUOTED_INPUT_MAX ? quoted : null;
}
/** After Aimiru fails to answer, reads and local work skip the network for this long. */
export const DOWN_WINDOW_MS = 30_000;

/**
 * True only when the person turned task taking on for this computer (AIMIRU_TAKE_TASKS=1;
 * ADR-0145, which makes ADR-0043's hand-offs opt-in): hand-offs between agents
 * are not in the wedge, so by default a session start takes no handed-off task and reports that it
 * does not, and Claude may not take one with Aimiru's take_task either.
 */
export function takesTasksHere(env = process.env) {
  return String(setting(env, 'TAKE_TASKS') ?? '').trim() === '1';
}

/**
 * True unless the person turned job taking off on this computer (ADR-0157): AIMIRU_TAKE_TASKS
 * unset, or 1. A session the person starts in their own terminal then takes the job
 * they gave Claude Code in Aimiru, when Aimiru gives it one (Aimiru decides: its door, the person's
 * grant for this agent, and this connector's version); any other value turns that off. Whether Claude
 * may call take_task itself is still takesTasksHere above, unchanged.
 */
export function takesJobsHere(env = process.env) {
  const v = String(setting(env, 'TAKE_TASKS') ?? '').trim();
  return v === '' || v === '1';
}

/**
 * A job this session holds, as get_task gives it back (CONTRACT.md), in the shape the task context
 * reads, while it is still open; null when it ended, cannot be read, or (unless work handed between
 * agents is on here) is not the person's own (ADR-0157).
 */
export function openTaskOf(r, handOffsHere) {
  const t = r?.ok && r.data?.task && typeof r.data.task === 'object' ? r.data.task : null;
  if (!t || ['completed', 'failed', 'cancelled'].includes(t.status) || (t.role && t.role !== 'taking')) return null;
  const fromPerson = t.from?.person === true;
  if (!fromPerson && !handOffsHere) return null;
  return {
    id: t.id,
    description: t.description,
    class: t.class,
    amount_cap: t.amount_cap ?? null,
    currency: t.currency ?? null,
    context: {},
    withheld: Array.isArray(t.withheld) ? t.withheld : [],
    from_person: fromPerson,
    from_agent: fromPerson ? null : typeof t.from?.agent === 'string' ? t.from.agent : null,
  };
}

/** A positive number setting (AIMIRU_<name>), else the fallback. */
function intFromEnv(env, name, fallback) {
  const v = Number(setting(env, name));
  return Number.isFinite(v) && v > 0 ? v : fallback;
}

/** The key /aimiru:connect saves (pairing, ADR-0034): in the plugin's data folder, readable only by the person. */
export const KEY_FILE = 'key.json';

export function keyFilePath(dataDir) {
  return path.join(dataDir, KEY_FILE);
}

/**
 * The plugin's data folder for a script the person runs through a skill (/aimiru:connect,
 * /aimiru:doctor): Claude Code sets CLAUDE_PLUGIN_DATA only for its own runs (the hooks), not for a
 * command Claude runs, so the folder is found where Claude Code keeps it
 * (~/.claude/plugins/data/aimiru-<marketplace>), as the hooks see it. Without it, a key saved by
 * /aimiru:connect would land where no hook reads it.
 * A Claude Code started with its own settings folder (CLAUDE_CONFIG_DIR) keeps the folder in there
 * (<CLAUDE_CONFIG_DIR>/plugins/data), and only there: ~/.claude may belong to the person's everyday
 * Claude Code, whose hooks never read this one's key and whose own key a save there would replace.
 */
export function findDataDir(env = process.env) {
  if (env.CLAUDE_PLUGIN_DATA) return env.CLAUDE_PLUGIN_DATA;
  const home = env.HOME || env.USERPROFILE || os.homedir();
  const base = path.join(claudeConfigDir(env), 'plugins', 'data');
  try {
    const names = fs.readdirSync(base).sort();
    for (const plugin of AIMIRU_PLUGIN_NAMES) {
      const re = new RegExp(`^${plugin}(-|$)`);
      const hit = names.find((n) => re.test(n));
      if (hit) return path.join(base, hit);
    }
  } catch {
    // not installed through a marketplace
  }
  return path.join(home, '.aimiru', 'claude-code');
}

/** The plugin's id as its install line makes it (plugin@marketplace), first among its settings. */
export const PLUGIN_ID = 'aimiru@aimiru';
/**
 * The public marketplace as the install lines name it (owner/repo; #next on the pre-release):
 * release-check.mjs's PUBLISHED.repository, which a test holds it to (ADR-0147, point 7).
 */
export const MARKETPLACE_SOURCE = 'aimiru-app/aimiru-connectors';
/**
 * How the doctor, and Aimiru's stuck helper (src/lib/stuck.ts), say to put back changed or missing
 * plugin files. For a plugin that is still installed, Claude Code says "already installed" and copies
 * nothing, so the install lines alone change nothing. Removing it with --keep-data keeps the plugin's
 * data folder, where /aimiru:connect saves the key, and the install copies the files again from the
 * marketplace already added, on either channel. Removing it clears the address /plugin configure
 * saved, so a key and address pasted there are pasted again. Seen on Claude Code 2.1.312 from a local
 * folder (28 Oct); the clean-machine test checks it on the published release.
 */
export const REINSTALL_LINES = Object.freeze([`claude plugin uninstall ${PLUGIN_ID} --keep-data`, `claude plugin install ${PLUGIN_ID}`]);
/** Claude Code's settings file is read for the plugin's settings only up to this size. */
const MAX_SETTINGS_BYTES = 4 * 1024 * 1024;

/**
 * A plain setting the person gave the plugin (its userConfig, such as aimiru_url), as Claude Code
 * keeps it in its settings file: <settings folder>/settings.json, pluginConfigs["aimiru@aimiru"]
 * .options (ADR-0150). Claude Code hands it to the plugin's hooks and tool server as
 * CLAUDE_PLUGIN_OPTION_<NAME>, but not to a command Claude runs, such as /aimiru:connect (Mac run
 * part 1, item 1: "Set the Aimiru address first" although the install saved it). The settings folder
 * is the one CLAUDE_CONFIG_DIR names, else ~/.claude, and only that one (claudeConfigDir). The plugin
 * from another marketplace is read when aimiru@aimiru has none. The key is never read here: Claude Code keeps it in the computer's keychain. Null when unset.
 */
export function savedPluginOption(env, name) {
  const file = path.join(claudeConfigDir(env), 'settings.json');
  let configs;
  try {
    if (fs.statSync(file).size > MAX_SETTINGS_BYTES) return null;
    configs = JSON.parse(fs.readFileSync(file, 'utf8'))?.pluginConfigs;
  } catch {
    return null;
  }
  if (!configs || typeof configs !== 'object' || Array.isArray(configs)) return null;
  // aimiru@aimiru first, then the plugin's names from any marketplace; null for another plugin.
  const order = (id) => {
    if (id === PLUGIN_ID) return 0;
    const i = AIMIRU_PLUGIN_NAMES.findIndex((p) => id === p || id.startsWith(`${p}@`));
    return i === -1 ? null : i + 1;
  };
  const ours = Object.keys(configs)
    .filter((id) => order(id) !== null)
    .sort((a, b) => order(a) - order(b) || a.localeCompare(b));
  for (const id of ours) {
    const v = configs[id]?.options?.[name];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return null;
}

/** The question when /aimiru:connect names an address (ADR-0034): the person must know it is theirs. */
export function connectAddressQuestion(url) {
  return `this connects Claude Code to the Aimiru at ${url}. Allow it only if that is the address your Aimiru shows.`;
}

/** Characters an address, an email or a number may hold here: nothing a shell treats specially. */
const PLAIN_ARG = /^[A-Za-z0-9@._:/+%=?-]+$/;

function plainArg(raw) {
  if (raw === undefined) return null;
  const m = /^"([^"]*)"$|^'([^']*)'$/.exec(raw);
  const v = m ? (m[1] ?? m[2]) : raw;
  return PLAIN_ARG.test(v) ? v : null;
}

/**
 * The plugin's own commands exactly as their skills run them (ADR-0034):
 * `node "<plugin root>/scripts/connect.mjs"` with only its own options (--url, --email, --wait,
 * --again, or a bare address), `node "<plugin root>/scripts/doctor.mjs"` with none, or
 * `node "<plugin root>/scripts/activity.mjs"` with nothing, --off or --status.
 * Returns {script: 'connect' | 'doctor' | 'activity', url: string | null, off?: boolean, status?: true,
 * literal?: true} (literal: written with the unexpanded ${CLAUDE_PLUGIN_ROOT}), or null for anything
 * else: another program or path, a second command, a pipe or redirect, a variable or an
 * environment prefix. PreToolUse never asks Aimiru about the doctor command, or the activity command
 * turning the report on or saying whether it is on, connected or not (wave 10, snag 10), and lets
 * connect run while Claude Code is not connected yet, since it is how it gets connected; everything
 * else, `activity --off` included, is checked as before.
 */
export function ownSetupCommand(command, pluginRoot) {
  if (typeof command !== 'string' || !pluginRoot || command.length > 1000) return null;
  const m = /^node\s+(?:"([^"]+)"|'([^']+)'|(\S+))((?:\s+\S+)*)\s*$/.exec(command.trim());
  if (!m) return null;
  const file = m[1] ?? m[2] ?? m[3];
  let literal = false;
  const script = ['connect', 'doctor', 'activity'].find((name) => {
    if (file === path.join(pluginRoot, 'scripts', `${name}.mjs`)) return true;
    // The skill's own text, when Claude Code leaves the variable for the shell (quoted, so no
    // splitting). The shell reads it when the command runs, from a variable this hook cannot see
    // (unset, it runs /scripts/<name>.mjs), so `literal` says the file is not known to be the
    // plugin's: the caller lets it through only while not connected (wave 10 review).
    if (m[1] !== undefined && file === `\${CLAUDE_PLUGIN_ROOT}/scripts/${name}.mjs`) return (literal = true);
    return false;
  });
  if (!script) return null;
  const lit = literal ? { literal: true } : {};
  const args = m[4].trim() ? m[4].trim().split(/\s+/) : [];
  if (script === 'doctor') return args.length === 0 ? { script, url: null, ...lit } : null;
  if (script === 'activity') {
    if (args.length === 0 || (args.length === 1 && ['--off', '--status'].includes(args[0]))) {
      return { script, url: null, off: args[0] === '--off', ...(args[0] === '--status' ? { status: true } : {}), ...lit };
    }
    return null;
  }
  let url = null;
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i];
    if (a === '--again') continue;
    if (a === '--url' || a === '--email' || a === '--wait') {
      const v = plainArg(args[i + 1]);
      if (v === null) return null;
      if (a === '--wait' && !/^\d{1,4}$/.test(v)) return null;
      if (a === '--url') {
        if (!/^https?:\/\//.test(v)) return null;
        url = v;
      }
      i += 1;
      continue;
    }
    const bare = plainArg(a);
    if (bare !== null && /^https?:\/\//.test(bare)) {
      url = bare;
      continue;
    }
    return null;
  }
  return { script, url, ...(literal ? { literal: true } : {}) };
}

/**
 * Reads the plugin's settings. The key arrives as CLAUDE_PLUGIN_OPTION_AGENT_KEY (userConfig
 * agent_key), or else from the key file /aimiru:connect saved, with the address it was made for.
 */
export function loadSettings(env = process.env) {
  const configuredToken = (env.CLAUDE_PLUGIN_OPTION_AGENT_KEY || setting(env, 'AGENT_TOKEN') || '').trim();
  const configuredUrl = (env.CLAUDE_PLUGIN_OPTION_AIMIRU_URL || setting(env, 'BASE_URL') || setting(env, 'URL') || '').trim();
  const dataDir = env.CLAUDE_PLUGIN_DATA || path.join(os.homedir(), '.aimiru', 'claude-code');
  const saved = configuredToken ? null : readKeyFile(keyFilePath(dataDir));
  const token = configuredToken || saved?.key || '';
  // A saved key belongs to the address it was made for.
  const baseUrl = saved ? saved.baseUrl || configuredUrl : configuredUrl;
  return {
    token,
    baseUrl,
    keySource: configuredToken ? 'settings' : saved ? 'file' : null,
    dataDir,
    projectDir: env.CLAUDE_PROJECT_DIR || null,
    pluginRoot: env.CLAUDE_PLUGIN_ROOT || null,
    checkTimeoutMs: intFromEnv(env, 'CHECK_TIMEOUT_MS', 10_000),
    // Null unless the person set it: an ask then holds the step 4 s (ADR-0145); set, only shorter.
    askBudgetMs: intFromEnv(env, 'ASK_BUDGET_MS', null),
    recordReads: setting(env, 'RECORD_READS') === '1',
  };
}

/** The plugin's own folder: CLAUDE_PLUGIN_ROOT when Claude Code runs it, else where this file lives. */
export function pluginRootOf(settings) {
  return settings.pluginRoot || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
}

/** Where the plugin keeps the Aimiru routine; Claude Code loads every skills/<name>/SKILL.md (ADR-0037). */
export function skillFile(settings) {
  return path.join(pluginRootOf(settings), 'skills', 'aimiru', 'SKILL.md');
}

/** The routine version this plugin carries, for the heartbeat's skill_version; null when the file is gone. */
export function skillVersion(settings) {
  return readSkillVersion(skillFile(settings));
}

export function makeClient(settings, { spool = true } = {}) {
  return createAimiruClient({
    baseUrl: settings.baseUrl,
    token: settings.token,
    connector: `${CONNECTOR}/${VERSION}`,
    agentLabel: AGENT_LABEL,
    // Not connected yet: the key the person was given first, pairing second (wave 10, snag 4).
    connect: CLAUDE_CODE_CONNECT,
    spoolDir: spool ? settings.dataDir : undefined,
    timeouts: { checkMs: settings.checkTimeoutMs },
  });
}

/** This computer's snapshot and local spool for reads decided here (ADR-0095). */
export function localStateFor(settings, client) {
  return createLocalState({ dataDir: settings.dataDir, token: settings.token, baseUrl: client.baseUrl });
}

/**
 * Refreshes the snapshot (GET /v1/me, one process at a time). The store and session are no longer
 * read (the short waits of ADR-0094 went with ask and move on, ADR-0145); the signature stays so the
 * hooks that call it are unchanged.
 */
export async function refreshSnapshot(client, local, store, session, { timeoutMs = 3_000 } = {}) {
  return refreshLocal(client, local, { timeoutMs });
}

/** Reads all of stdin as JSON. Returns {} for empty input; throws on invalid JSON. */
export async function readStdinJson({ maxBytes = 8 * 1024 * 1024 } = {}) {
  if (process.stdin.isTTY) return {};
  const chunks = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    size += chunk.length;
    if (size > maxBytes) throw new Error('input too large');
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString('utf8').trim();
  if (!raw) return {};
  return JSON.parse(raw);
}

/** Writes exactly one JSON object to stdout (Claude Code parses stdout as a single object). */
export function writeJson(obj) {
  process.stdout.write(`${JSON.stringify(obj)}\n`);
}

// ---------------------------------------------------------------------------
// Local state in ${CLAUDE_PLUGIN_DATA}
// ---------------------------------------------------------------------------

function safeName(s) {
  return String(s).replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 120) || 'none';
}

function readJsonFile(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function writeJsonFile(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(obj), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

/**
 * A MAC over a waiting question and the call it belongs to, keyed by the Aimiru key (which only the
 * plugin's own processes see). A question file copied or written for a different call, by anything
 * that can write to this folder, does not verify, so an earlier yes is never applied to another call.
 * Aimiru's own words about the question, kept with it for the retry, are covered too, so nothing
 * written to the folder is shown to Claude as Aimiru's (a file saved before they were kept has none).
 */
function pendingMac(secret, fp, data) {
  const words = typeof data.explain === 'string' && data.explain ? `\n${data.explain}` : '';
  // The programs the question was about (ADR-0090 review): a yes is for them, by their content.
  const programs = Array.isArray(data.programs) ? `\nprograms:${JSON.stringify(data.programs)}` : '';
  // The exact call the question was about, and what Aimiru said with it (ADR-0094): the late yes
  // quotes this call back to Claude, so nothing written to the folder can put words there.
  const call = data.call && typeof data.call === 'object' ? `\ncall:${JSON.stringify(data.call)}` : '';
  return createHmac('sha256', `aimiru-pending:${secret}`).update(`${fp}\n${data.exceptionId ?? ''}\n${data.actionId ?? ''}${words}${programs}${call}`).digest('hex');
}

/**
 * A MAC over what a session began with (ADR-0090 review): the repositories and the commits they were
 * on, keyed by the Aimiru key, so nothing else can move where newness is counted from.
 */
function sessionMac(secret, session, baseline) {
  return createHmac('sha256', `aimiru-session:${secret}`).update(`${JSON.stringify(String(session ?? ''))}\n${JSON.stringify(baseline ?? null)}`).digest('hex');
}

/** How long what a session began with is kept (a session can be resumed for days). */
export const SESSION_BASELINE_TTL_MS = 14 * 24 * 3600_000;

/**
 * A MAC over the job a session took (ADR-0157), keyed by the Aimiru key, so nothing else can make a
 * session's checks name another job.
 */
function sessionTaskMac(secret, session, taskId, ts) {
  return createHmac('sha256', `aimiru-session-task:${secret}`).update(`${JSON.stringify(String(session ?? ''))}\n${String(taskId ?? '')}\n${ts}`).digest('hex');
}

/**
 * A MAC over a program the person allowed in a session (ADR-0090): the session, the file and the
 * sha256 of its content, keyed by the Aimiru key. A file written into this folder by anything else
 * does not verify, so nothing but the person's own yes lets that file run as local work.
 */
function programMac(secret, session, file, sha256, ts) {
  return createHmac('sha256', `aimiru-program:${secret}`).update(`${JSON.stringify(String(session ?? ''))}\n${JSON.stringify(String(file ?? ''))}\n${sha256}\n${ts}`).digest('hex');
}

/** How long a yes for a program lasts at most, within its session (ADR-0090). */
export const PROGRAM_YES_TTL_MS = 24 * 3600_000;

/** A MAC over a remembered cart, its store, its checkout id and when it was seen (ADR-0065). */
function cartMac(secret, scope, reference, ts, cart) {
  return createHmac('sha256', `aimiru-cart:${secret}`).update(`${JSON.stringify(String(scope ?? ''))}\n${reference}\n${ts}\n${JSON.stringify(cart ?? null)}`).digest('hex');
}

/** The file a store's cart is kept in: one per store (ucpScope) and checkout id. */
function cartFileName(scope, reference) {
  return `${sha256Hex(`cart:${String(scope ?? '')}\u0000${reference}`).slice(0, 40)}.json`;
}

function macEqual(a, b) {
  const x = Buffer.from(String(a ?? ''), 'utf8');
  const y = Buffer.from(String(b ?? ''), 'utf8');
  return x.length === y.length && x.length > 0 && timingSafeEqual(x, y);
}

/** How long a store's cart is remembered for its complete_checkout (ADR-0065). */
export const CART_TTL_MS = 60 * 60_000;

export function stateStore(dataDir, { secret = '' } = {}) {
  const callsDir = path.join(dataDir, 'calls');
  const pendingDir = path.join(dataDir, 'pending');
  // One small file per waiting question, by its exception id (ADR-0094): which call it was, so a
  // session start can ask Aimiru about this computer's own questions only.
  const indexDir = path.join(dataDir, 'pending-index');
  const indexFile = (exceptionId) => path.join(indexDir, `${safeName(exceptionId)}.json`);
  const cartsDir = path.join(dataDir, 'carts');
  // Questions whose yes woke Claude already (CN10), so a yes is offered once.
  const wokenDir = path.join(dataDir, 'woken');
  const wokenFile = (exceptionId) => path.join(wokenDir, `${safeName(exceptionId)}.json`);
  const programsDir = path.join(dataDir, 'programs');
  const sessionsDir = path.join(dataDir, 'sessions');
  const sessionFile = (session) => path.join(sessionsDir, `${sha256Hex(`session:${String(session ?? '')}`).slice(0, 40)}.json`);
  const programFile = (session, file) => path.join(programsDir, `${sha256Hex(`program:${String(session ?? '')}\u0000${String(file ?? '')}`).slice(0, 40)}.json`);
  const healthFile = path.join(dataDir, 'health.json');
  const statusFile = path.join(dataDir, 'status.json');
  // Per session (ADR-0157): the brief it was given (its version, never its words), and the job it took.
  const briefsDir = path.join(dataDir, 'briefs');
  const briefFile = (session) => path.join(briefsDir, `${sha256Hex(`brief:${String(session ?? '')}`).slice(0, 40)}.json`);
  const sessionTasksDir = path.join(dataDir, 'session-tasks');
  const sessionTaskFile = (session) => path.join(sessionTasksDir, `${sha256Hex(`task:${String(session ?? '')}`).slice(0, 40)}.json`);
  // A session /clear emptied while it held an open job: given again at its next prompt (ADR-0157).
  const regiveFile = (session) => path.join(sessionTasksDir, `${sha256Hex(`regive:${String(session ?? '')}`).slice(0, 40)}.flag`);

  return {
    dataDir,
    /**
     * What this session was given of the person's brief (ADR-0157): {state, version, at}, state as
     * briefOf says (given, empty, closed or none) and at when Aimiru was last asked. Never the words.
     * missed: the start asked and had no answer from Aimiru (briefMissed), so the first prompt asks at
     * once (CC6); caught_up: that first-prompt ask is spent, and stays spent for the whole session.
     */
    putSessionBrief(session, data) {
      if (!session || !data || typeof data !== 'object') return;
      try {
        const caughtUp = data.caught_up === true || readJsonFile(briefFile(session))?.caught_up === true;
        writeJsonFile(briefFile(session), {
          session: String(session),
          state: String(data.state ?? 'none'),
          version: typeof data.version === 'string' ? data.version : null,
          at: Number(data.at) || Date.now(),
          ...(data.missed === true ? { missed: true } : {}),
          ...(caughtUp ? { caught_up: true } : {}),
        });
      } catch {
        // the next prompt does not look again; the next session start does
      }
    },
    sessionBrief(session) {
      if (!session) return null;
      const v = readJsonFile(briefFile(session));
      return v && v.session === String(session) ? v : null;
    },
    /** The job this session took at its start (ADR-0157): its checks carry the job's id until it ends. */
    putSessionTask(session, taskId) {
      if (!secret || !session || typeof taskId !== 'string' || !taskId) return;
      const ts = Date.now();
      try {
        writeJsonFile(sessionTaskFile(session), { session: String(session), task_id: taskId, ts, mac: sessionTaskMac(secret, session, taskId, ts) });
      } catch {
        // its checks go without the job's id
      }
    },
    /** The id of the job this session took, while it is open and the record verifies; else null. */
    sessionTask(session) {
      if (!secret || !session) return null;
      const v = readJsonFile(sessionTaskFile(session));
      if (!v || v.session !== String(session) || typeof v.task_id !== 'string' || !Number.isFinite(v.ts)) return null;
      if (!macEqual(v.mac, sessionTaskMac(secret, session, v.task_id, v.ts))) return null;
      if (Date.now() - v.ts > SESSION_BASELINE_TTL_MS) return null;
      return v.task_id;
    },
    /**
     * /clear emptied this session's context while it held an open job (ADR-0157): the next prompt asks
     * Aimiru for the job (get_task) and gives it to Claude once more. A flag only: the job's id stays
     * in the signed session record, and nothing here can name another job.
     */
    markRegive(session) {
      if (!session) return;
      try {
        fs.mkdirSync(sessionTasksDir, { recursive: true, mode: 0o700 });
        fs.writeFileSync(regiveFile(session), String(Date.now()), { mode: 0o600 });
      } catch {
        // the job is not given again
      }
    },
    regiveDue(session) {
      return Boolean(session) && fs.existsSync(regiveFile(session));
    },
    clearRegive(session) {
      if (!session) return;
      try {
        fs.rmSync(regiveFile(session), { force: true });
      } catch {
        // given again at most once more
      }
    },
    /** The session recorded its job done or not done (ADR-0157): its later steps carry no job's id. */
    clearSessionTask(session, taskId) {
      if (!session) return;
      const v = readJsonFile(sessionTaskFile(session));
      if (!v || (taskId && v.task_id !== taskId)) return;
      try {
        fs.rmSync(sessionTaskFile(session), { force: true });
      } catch {
        // ignore
      }
    },
    /** Links a checked call to its later record (keyed by tool_use_id). */
    putCall(toolUseId, data) {
      if (!toolUseId) return;
      writeJsonFile(path.join(callsDir, `${safeName(toolUseId)}.json`), { ...data, ts: Date.now() });
    },
    takeCall(toolUseId) {
      if (!toolUseId) return null;
      const f = path.join(callsDir, `${safeName(toolUseId)}.json`);
      const v = readJsonFile(f);
      try {
        fs.rmSync(f, { force: true });
      } catch {
        // ignore
      }
      return v;
    },
    /** An ask that timed out: the same call later waits on the same question instead of asking again. */
    putPending(fp, data) {
      if (!secret) return; // without a key there is nothing to wait on
      writeJsonFile(path.join(pendingDir, `${safeName(fp)}.json`), { ...data, mac: pendingMac(secret, fp, data), ts: Date.now() });
      if (data.exceptionId) {
        try {
          writeJsonFile(indexFile(data.exceptionId), { fp, exceptionId: data.exceptionId, session: data.call?.session_id ?? null, ts: Date.now() });
        } catch {
          // the question still waits; it is not offered at session start
        }
      }
    },
    /**
     * This computer's waiting questions (ADR-0094), newest first: [{exceptionId, fp, session, ts}],
     * only those asked within maxAgeMs, and only for one session when `session` is given.
     */
    pendingIndex({ maxAgeMs = LATE_YES_MS, session = null, now = Date.now() } = {}) {
      let names = [];
      try {
        names = fs.readdirSync(indexDir).filter((n) => n.endsWith('.json'));
      } catch {
        return [];
      }
      const out = [];
      for (const n of names) {
        const v = readJsonFile(path.join(indexDir, n));
        if (!v || typeof v.exceptionId !== 'string' || typeof v.fp !== 'string' || !Number.isFinite(v.ts)) continue;
        if (now - v.ts > maxAgeMs || now < v.ts - 60_000) continue;
        if (session !== null && v.session !== String(session)) continue;
        out.push(v);
      }
      return out.sort((a, b) => b.ts - a.ts);
    },
    /**
     * The waiting questions a late yes can be offered for (ADR-0094 review), newest first:
     * [{exceptionId, fp, session, ts, pending}]. Each one's question file is here, verifies, is
     * still open, belongs to `session` when one is given (by the file's own MAC'd call, not only the
     * index), and its step can be quoted back (quotedStep). Only these are sent to Aimiru or polled,
     * so a yes is never used up for a step Claude would not be told about.
     */
    offerable({ session = null, now = Date.now() } = {}) {
      const out = [];
      for (const e of this.pendingIndex({ session, now })) {
        const p = this.pendingFor(e.exceptionId);
        if (!p || quotedStep(p.call) === null) continue;
        if (session !== null && p.call.session_id !== String(session)) continue;
        out.push({ ...e, pending: p });
      }
      return out;
    },
    /** The waiting question with this exception id, when its file is here and verifies; else null. */
    pendingFor(exceptionId) {
      const v = readJsonFile(indexFile(exceptionId));
      if (!v || typeof v.fp !== 'string') return null;
      const p = this.getPending(v.fp);
      return p && p.exceptionId === exceptionId ? { ...p, fp: v.fp } : null;
    },
    getPending(fp) {
      const v = readJsonFile(path.join(pendingDir, `${safeName(fp)}.json`));
      if (!v) return null;
      if (!secret || !macEqual(v.mac, pendingMac(secret, fp, v))) {
        this.deletePending(fp);
        return null;
      }
      const expires = v.expiresAt ? Date.parse(v.expiresAt) : v.ts + 15 * 60_000;
      if (Number.isFinite(expires) && expires < Date.now()) {
        this.deletePending(fp);
        return null;
      }
      return v;
    },
    deletePending(fp) {
      const file = path.join(pendingDir, `${safeName(fp)}.json`);
      const v = readJsonFile(file);
      try {
        fs.rmSync(file, { force: true });
        if (v && typeof v.exceptionId === 'string') fs.rmSync(indexFile(v.exceptionId), { force: true });
      } catch {
        // ignore
      }
    },
    /** The watcher woke Claude for this question's yes (CN10): it is not offered again. */
    markWoken(exceptionId) {
      if (!exceptionId) return;
      try {
        writeJsonFile(wokenFile(exceptionId), { exceptionId, ts: Date.now() });
      } catch {
        // offered again at the next message: a repeat, never a loss
      }
    },
    /** True when the watcher already woke Claude for this question's yes. */
    woken(exceptionId) {
      return Boolean(exceptionId) && fs.existsSync(wokenFile(exceptionId));
    },
    /**
     * A store's cart, by its store (ucpScope of the tool that answered) and checkout id, from the
     * store's answer to create_checkout, update_checkout or get_checkout (ADR-0065). Signed with the
     * Aimiru key like a waiting question: a cart written by anything else (a lower total, other
     * items) is never read back, and a cart one tool server answered with is never read for another.
     */
    putCart(cart, scope = '', now = Date.now()) {
      if (!secret || !cart?.reference) return;
      writeJsonFile(path.join(cartsDir, cartFileName(scope, cart.reference)), { cart, ts: now, mac: cartMac(secret, scope, cart.reference, now, cart) });
    },
    getCart(reference, scope = '', now = Date.now()) {
      if (!secret || !reference) return null;
      const v = readJsonFile(path.join(cartsDir, cartFileName(scope, reference)));
      if (!v || typeof v.ts !== 'number' || !macEqual(v.mac, cartMac(secret, scope, reference, v.ts, v.cart))) return null;
      if (now - v.ts > CART_TTL_MS || now < v.ts - 60_000) return null;
      return v.cart?.reference === reference ? v.cart : null;
    },
    isDown(now = Date.now()) {
      const h = readJsonFile(healthFile);
      return Boolean(h && h.downUntil && h.downUntil > now);
    },
    markDown(ms = DOWN_WINDOW_MS) {
      try {
        writeJsonFile(healthFile, { downUntil: Date.now() + ms });
      } catch {
        // ignore
      }
    },
    markUp() {
      try {
        if (fs.existsSync(healthFile)) fs.rmSync(healthFile, { force: true });
      } catch {
        // ignore
      }
    },
    writeStatus(obj) {
      try {
        writeJsonFile(statusFile, obj);
      } catch {
        // ignore
      }
    },
    readStatus() {
      return readJsonFile(statusFile);
    },
    /**
     * The person allowed these programs in this session (ADR-0090): the same file with the same
     * content then runs as local work for the rest of the session. Signed with the Aimiru key.
     */
    rememberPrograms(session, programs) {
      if (!secret || !session || !Array.isArray(programs)) return;
      for (const p of programs) {
        if (!p?.path || !/^[0-9a-f]{64}$/.test(String(p.sha256 ?? ''))) continue;
        const ts = Date.now();
        writeJsonFile(programFile(session, p.path), { session: String(session), path: p.path, sha256: p.sha256, ts, mac: programMac(secret, session, p.path, p.sha256, ts) });
      }
    },
    /** True when the person allowed this exact file content in this session, and the record verifies. */
    programAllowed(session, file, sha256) {
      if (!secret || !session || !file || !sha256) return false;
      const v = readJsonFile(programFile(session, file));
      if (!v || v.session !== String(session) || v.path !== file || v.sha256 !== sha256) return false;
      if (!macEqual(v.mac, programMac(secret, session, file, sha256, v.ts))) return false;
      return Number.isFinite(v.ts) && Date.now() - v.ts < PROGRAM_YES_TTL_MS;
    },
    /**
     * What this session began with (newness.mjs sessionBaselineFor), kept once: a session that
     * starts again (resumed, compacted) keeps the first, so committing during it never moves where
     * newness is counted from. Signed with the Aimiru key. Returns true when it was kept now.
     */
    putSessionBaseline(session, baseline) {
      if (!secret || !session || !baseline || typeof baseline !== 'object') return false;
      if (this.sessionBaseline(session)) return false;
      writeJsonFile(sessionFile(session), { session: String(session), baseline, mac: sessionMac(secret, session, baseline) });
      return true;
    },
    /** What this session began with, when the record is there and verifies; else null. */
    sessionBaseline(session) {
      if (!secret || !session) return null;
      const v = readJsonFile(sessionFile(session));
      if (!v || v.session !== String(session) || !v.baseline || typeof v.baseline !== 'object') return null;
      if (!macEqual(v.mac, sessionMac(secret, session, v.baseline))) return null;
      if (!Number.isFinite(v.baseline.startedAt) || Date.now() - v.baseline.startedAt > SESSION_BASELINE_TTL_MS) return null;
      return v.baseline;
    },
    /** True the first time an offer is made on this computer, false after (offers.json). */
    offerOnce(name) {
      const file = path.join(dataDir, 'offers.json');
      const seen = readJsonFile(file) || {};
      if (seen[name]) return false;
      try {
        writeJsonFile(file, { ...seen, [name]: new Date().toISOString() });
      } catch {
        return false; // never repeat an offer it could not note
      }
      return true;
    },
    /** Removes call and pending files older than maxAgeMs (what sessions began with: after SESSION_BASELINE_TTL_MS). */
    cleanup(maxAgeMs = 24 * 3600_000) {
      for (const [dir, age] of [[callsDir, maxAgeMs], [pendingDir, maxAgeMs], [indexDir, maxAgeMs], [cartsDir, maxAgeMs], [programsDir, maxAgeMs], [wokenDir, maxAgeMs], [sessionsDir, Math.max(maxAgeMs, SESSION_BASELINE_TTL_MS)], [briefsDir, Math.max(maxAgeMs, SESSION_BASELINE_TTL_MS)], [sessionTasksDir, Math.max(maxAgeMs, SESSION_BASELINE_TTL_MS)]]) {
        let names = [];
        try {
          names = fs.readdirSync(dir);
        } catch {
          continue;
        }
        for (const n of names) {
          const f = path.join(dir, n);
          try {
            if (Date.now() - fs.statSync(f).mtimeMs > age) fs.rmSync(f, { force: true });
          } catch {
            // ignore
          }
        }
      }
    },
  };
}

/**
 * The same call in the same session: same tool, same effect. Claude often rewrites the free-text
 * "description" when it retries, so that is left out; for a command, only the command counts.
 */
export function fingerprint(input) {
  const ti = input?.tool_input && typeof input.tool_input === 'object' ? { ...input.tool_input } : {};
  delete ti.description;
  const what = ['Bash', 'PowerShell', 'Monitor'].includes(input?.tool_name) && typeof ti.command === 'string' ? { command: ti.command } : ti;
  return sha256Hex(`${input?.session_id ?? ''}\n${input?.tool_name ?? ''}\n${JSON.stringify(what)}`).slice(0, 40);
}

// ---------------------------------------------------------------------------
// Claude Code version
// ---------------------------------------------------------------------------

export function compareVersions(a, b) {
  const pa = String(a).split(/[.-]/).map((x) => Number.parseInt(x, 10) || 0);
  const pb = String(b).split(/[.-]/).map((x) => Number.parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d > 0 ? 1 : -1;
  }
  return 0;
}

/**
 * Finds the running Claude Code version.
 * 1. AI_AGENT, which Claude Code sets for its child processes ("claude-code_2-1-304_agent"; observed, not documented)
 * 2. CLAUDE_CODE_EXECPATH, whose last segment is the version for the native install (observed)
 * 3. `claude --version`, when allowed (slower; used at session start and by doctor)
 */
export function detectClaudeCodeVersion(env = process.env, { allowSpawn = false, timeoutMs = 2_000 } = {}) {
  const m = /claude-code[_-](\d+)[-.](\d+)[-.](\d+)/i.exec(env.AI_AGENT || '');
  if (m) return `${m[1]}.${m[2]}.${m[3]}`;
  const exec = env.CLAUDE_CODE_EXECPATH || '';
  const tail = exec.split(/[\\/]/).pop() || '';
  if (/^\d+\.\d+\.\d+$/.test(tail)) return tail;
  const pinned = setting(env, 'CLAUDE_VERSION');
  if (pinned && /^\d+\.\d+\.\d+$/.test(pinned)) return pinned;
  if (!allowSpawn) return null;
  try {
    const r = spawnSync(setting(env, 'CLAUDE_BIN') || 'claude', ['--version'], { encoding: 'utf8', timeout: timeoutMs, stdio: ['ignore', 'pipe', 'ignore'] });
    const v = /(\d+\.\d+\.\d+)/.exec(r.stdout || '');
    return v ? v[1] : null;
  } catch {
    return null;
  }
}

export function supportsBlockOnFailure(version) {
  return Boolean(version) && compareVersions(version, MIN_ENFORCED_VERSION) >= 0;
}

// ---------------------------------------------------------------------------
// Settings guard
// ---------------------------------------------------------------------------

/**
 * Environment settings that change how the check itself runs: Node options can load code into the
 * check, plugin variables can replace its key, address or files, CLAUDE_CONFIG_DIR moves Claude
 * Code's settings folder, with the plugins installed there and the settings files Aimiru guards, and
 * those of Aimiru's own settings (AIMIRU_) that send every check to another address with
 * another key (AGENT_TOKEN, BASE_URL, URL, read before the saved key; PLUGIN_, the tool server's),
 * file the work under another project (PROJECT, which rules can name), or say which Claude Code runs
 * (CLAUDE_VERSION, CLAUDE_BIN, which decide whether a failed check blocks) (agent-experience review
 * of wk/connectors-flow). Settings that only shorten a wait or ask for more records stay free to change.
 */
export const HIJACK_ENV_RE = /^(NODE_OPTIONS|NODE_PATH|CLAUDE_CONFIG_DIR|CLAUDE_PLUGIN_(OPTION_[A-Z0-9_]+|ROOT|DATA)|AIMIRU_(AGENT_TOKEN|BASE_URL|URL|PROJECT|CLAUDE_VERSION|CLAUDE_BIN|PLUGIN_[A-Z0-9_]+))$/i;

/** True when these settings turn Aimiru off, or change how its check runs. */
export function turnsAimiruOff(settingsJson) {
  if (!settingsJson || typeof settingsJson !== 'object') return false;
  if (settingsJson.disableAllHooks === true) return true;
  const enabled = settingsJson.enabledPlugins;
  if (enabled && typeof enabled === 'object') {
    for (const [id, on] of Object.entries(enabled)) {
      // The plugin under its published name, from any marketplace (aimiru@<marketplace>).
      if (on === false && AIMIRU_PLUGIN_NAMES.some((name) => new RegExp(`^${name}(@|$)`, 'i').test(id))) return true;
    }
  }
  const env = settingsJson.env;
  if (env && typeof env === 'object' && Object.keys(env).some((k) => HIJACK_ENV_RE.test(k))) return true;
  return false;
}

