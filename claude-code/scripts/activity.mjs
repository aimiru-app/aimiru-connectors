#!/usr/bin/env node
// Aimiru for Claude Code: /aimiru:activity (ADR-0067, checked versus did). Turns on Claude Code's
// own activity report (OpenTelemetry logs) to the person's Aimiru, so Aimiru can compare what
// Claude Code ran with what it checked: "Checked with Aimiru before 48 of 48 risky actions",
// model spend as Claude Code counts it, and any risky action that ran without a check.
//
//   node scripts/activity.mjs            turn it on (or say it is on)
//   node scripts/activity.mjs --off      turn it off again
//   node scripts/activity.mjs --status   say whether it is on
//
// What it changes, in Claude Code's own settings only: ~/.claude/settings.json, or settings.json in
// the folder CLAUDE_CONFIG_DIR names when Claude Code was started with its own (Claude Code ignores
// these in a project's own settings):
//   env: CLAUDE_CODE_ENABLE_TELEMETRY=1, OTEL_LOGS_EXPORTER=otlp,
//        OTEL_EXPORTER_OTLP_LOGS_PROTOCOL=http/json,
//        OTEL_EXPORTER_OTLP_LOGS_ENDPOINT=<Aimiru>/v1/otlp/v1/logs, OTEL_LOG_TOOL_DETAILS=1
//   otelHeadersHelper: node "<plugin data folder>/otel-headers.mjs"
// The key is never written there: the helper reads it from the key file /aimiru:connect saved
// (readable only by the person) each time Claude Code asks for the headers, so Claude cannot read
// it from a settings file. It refuses when another activity export is already set up there, so
// Aimiru's key never goes to someone else's collector. Every other setting is kept as it is.
// Exit codes: 0 done (or nothing to do), 1 not done (the reason is printed). Never prints the key.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { claudeConfigDir, findDataDir, keyFilePath, loadSettings } from './lib/runtime.mjs';
import { readKeyFile } from './vendor/pair.mjs';
import { normaliseBaseUrl } from './vendor/sayso-client.mjs';

export const HELPER_FILE = 'otel-headers.mjs';
export const OTLP_PATH = '/v1/otlp/v1/logs';

/** The helper Claude Code runs for the headers: the key file next to it, as Authorization. */
export const HELPER_SOURCE = `#!/usr/bin/env node
// Written by Aimiru for Claude Code (/aimiru:activity). Prints the header Claude Code sends with its
// activity report to Aimiru. Reads the key /aimiru:connect saved next to this file; prints nothing
// when it is missing or readable by anyone else.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const file = path.join(path.dirname(fileURLToPath(import.meta.url)), 'key.json');
try {
  const st = fs.statSync(file);
  if (process.platform !== 'win32' && (st.mode & 0o077) !== 0) process.exit(1);
  const v = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!v || typeof v.key !== 'string' || !/^sayso_agt_[A-Za-z0-9_-]{43}$/.test(v.key)) process.exit(1);
  process.stdout.write(JSON.stringify({ Authorization: 'Bearer ' + v.key }));
} catch {
  process.exit(1);
}
`;

/** Claude Code's own settings file, as the person reads it, when it is in its usual place. */
const SETTINGS_WORDS = '~/.claude/settings.json';

/** A settings file as the person reads it: from ~ when it is inside the home folder, else in full. */
export function settingsFileWords(file, home) {
  const rel = path.relative(home, file);
  if (!rel || rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) return file;
  return `~/${rel.split(path.sep).join('/')}`;
}

export const ACTIVITY_MESSAGES = {
  notConnected:
    'Aimiru for Claude Code has no key saved on this computer yet. Run /aimiru:connect first: the activity report reads the key it saves.',
  noAddress: 'The Aimiru address is not known yet. Run /aimiru:connect first.',
  otherExport: (name, file = SETTINGS_WORDS) =>
    `Claude Code already sends its activity somewhere else (${name} in ${file}). Aimiru changed nothing, so its key never goes there. Remove that setting first if you want Aimiru to have it.`,
  otherExportEnv: (name) =>
    `Claude Code already sends its activity somewhere else (${name} is set where Claude Code runs, such as your shell). Aimiru changed nothing, so its key never goes there.`,
  otherExportManaged: (name) =>
    `Your organisation's settings for Claude Code already send its activity somewhere else (${name}), and they come before yours. Aimiru changed nothing, so its key never goes there.`,
  unreadable: (file = SETTINGS_WORDS) => `Aimiru could not read ${file}, so it changed nothing. Check that the file is valid.`,
  on: (url) => `Claude Code now sends its own activity to your Aimiru at ${url}.`,
  already: (url) => `Claude Code already sends its own activity to your Aimiru at ${url}.`,
  what:
    'Aimiru keeps counts and costs: which tools ran, whether each checked with Aimiru first, and model spend as Claude Code counts it. Never your prompts or what the tools read or wrote. Commands are read to tell a delete from a read, then only a fingerprint is kept.',
  restart: 'Restart Claude Code for it to start.',
  off: 'Claude Code no longer sends its activity to Aimiru. Restart Claude Code for it to stop.',
  notOn: 'Claude Code does not send its activity to Aimiru.',
  shellNote:
    'If your shell also sets OTEL_ settings for Claude Code, check that they do not send Claude Code\'s activity anywhere else.',
};

/** The env entries this script sets, for one Aimiru address. */
export function activityEnv(baseUrl) {
  return {
    CLAUDE_CODE_ENABLE_TELEMETRY: '1',
    OTEL_LOGS_EXPORTER: 'otlp',
    OTEL_EXPORTER_OTLP_LOGS_PROTOCOL: 'http/json',
    OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: `${baseUrl}${OTLP_PATH}`,
    OTEL_LOG_TOOL_DETAILS: '1',
  };
}

export function helperCommand(dataDir) {
  return `node "${path.join(dataDir, HELPER_FILE)}"`;
}

/**
 * An activity export that is not Aimiru's, already in these settings: an exporter for metrics or
 * traces, another logs address, a general address or headers (they would apply to Aimiru's too, and
 * Aimiru's header helper to theirs), or another header helper. Returns its name, or null.
 */
export function otherExport(settings, baseUrl, dataDir) {
  const env = settings && typeof settings.env === 'object' && settings.env ? settings.env : {};
  void baseUrl;
  const exporterOn = (v) => typeof v === 'string' && v.trim() !== '' && v.trim() !== 'none';
  if (exporterOn(env.OTEL_METRICS_EXPORTER)) return 'OTEL_METRICS_EXPORTER';
  if (exporterOn(env.OTEL_TRACES_EXPORTER)) return 'OTEL_TRACES_EXPORTER';
  if (exporterOn(env.OTEL_LOGS_EXPORTER) && env.OTEL_LOGS_EXPORTER !== 'otlp') return 'OTEL_LOGS_EXPORTER';
  for (const name of ['OTEL_EXPORTER_OTLP_ENDPOINT', 'OTEL_EXPORTER_OTLP_HEADERS', 'OTEL_EXPORTER_OTLP_LOGS_HEADERS']) {
    if (typeof env[name] === 'string' && env[name].trim() !== '') return name;
  }
  if (
    typeof env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT === 'string' &&
    env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT.trim() !== '' &&
    !env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT.trim().endsWith(OTLP_PATH)
  ) {
    return 'OTEL_EXPORTER_OTLP_LOGS_ENDPOINT';
  }
  if (env.OTEL_LOGS_EXPORTER === 'otlp' && env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT === undefined) {
    return 'OTEL_LOGS_EXPORTER';
  }
  if (
    typeof settings?.otelHeadersHelper === 'string' &&
    settings.otelHeadersHelper.trim() !== '' &&
    settings.otelHeadersHelper !== helperCommand(dataDir)
  ) {
    return 'otelHeadersHelper';
  }
  return null;
}

/**
 * Where an organisation's managed settings for Claude Code live. They come before the person's own,
 * so an activity export set there would carry Aimiru's header to its address.
 */
export function managedSettingsFiles(platform = process.platform) {
  if (platform === 'darwin') return ['/Library/Application Support/ClaudeCode/managed-settings.json'];
  if (platform === 'win32') return ['C:\\Program Files\\ClaudeCode\\managed-settings.json'];
  return ['/etc/claude-code/managed-settings.json'];
}

/** The OTEL_ settings in the environment Claude Code runs in (this script inherits it). */
function otelEnv(env) {
  const out = {};
  for (const [k, v] of Object.entries(env || {})) if (k.startsWith('OTEL_') && typeof v === 'string') out[k] = v;
  return out;
}

/** An export set outside Claude Code's own settings file: the environment, then managed settings. */
export function exportElsewhere(env, managedFiles, baseUrl, dataDir) {
  const fromEnv = otherExport({ env: otelEnv(env) }, baseUrl, dataDir);
  if (fromEnv) return ACTIVITY_MESSAGES.otherExportEnv(fromEnv);
  for (const file of managedFiles) {
    const read = readSettings(file);
    if (!read.ok) continue;
    const found = otherExport(read.value, baseUrl, dataDir);
    if (found) return ACTIVITY_MESSAGES.otherExportManaged(found);
  }
  return null;
}

/** True when these settings already send Claude Code's activity to this Aimiru. */
export function isOn(settings, baseUrl, dataDir) {
  const env = settings?.env ?? {};
  const ours = activityEnv(baseUrl);
  return Object.entries(ours).every(([k, v]) => env[k] === v) && settings?.otelHeadersHelper === helperCommand(dataDir);
}

function readSettings(file) {
  try {
    const text = fs.readFileSync(file, 'utf8');
    if (text.trim() === '') return { ok: true, value: {} };
    const v = JSON.parse(text);
    return v && typeof v === 'object' && !Array.isArray(v) ? { ok: true, value: v } : { ok: false };
  } catch (e) {
    if (e && e.code === 'ENOENT') return { ok: true, value: {} };
    return { ok: false };
  }
}

/**
 * Write a file whole. A settings file that is a link (a dotfiles folder, say) is written through
 * the link, so the link stays; an existing file keeps its permissions.
 */
function writeAtomic(link, text, mode) {
  let file = link;
  try {
    if (fs.lstatSync(link).isSymbolicLink()) file = fs.realpathSync(link);
  } catch {
    // not there yet
  }
  if (!mode) {
    try {
      mode = fs.statSync(file).mode & 0o777;
    } catch {
      // a new file
    }
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, text, mode ? { mode } : undefined);
  if (mode) {
    try {
      fs.chmodSync(tmp, mode);
    } catch {
      // not supported on this system
    }
  }
  fs.renameSync(tmp, file);
}

export function parseArgs(argv) {
  return { off: argv.includes('--off'), status: argv.includes('--status') };
}

export async function activity({
  argv = process.argv.slice(2),
  env = process.env,
  say = (l) => process.stdout.write(`${l}\n`),
  managedFiles = managedSettingsFiles(),
} = {}) {
  const args = parseArgs(argv);
  const home = env.HOME || env.USERPROFILE || os.homedir();
  // The settings this Claude Code reads: in the folder CLAUDE_CONFIG_DIR names when it was started
  // with its own, so turning the report on, off or asking about it never touches ~/.claude then.
  const settingsFile = path.join(claudeConfigDir(env), 'settings.json');
  const fileWords = settingsFileWords(settingsFile, home);
  const dataDir = findDataDir(env);
  const read = readSettings(settingsFile);
  if (!read.ok) {
    say(ACTIVITY_MESSAGES.unreadable(fileWords));
    return 1;
  }
  const settings = read.value;
  const saved = readKeyFile(keyFilePath(dataDir));
  const configured = loadSettings({ ...env, CLAUDE_PLUGIN_DATA: dataDir });

  if (args.off || args.status) {
    const env0 = settings.env && typeof settings.env === 'object' ? settings.env : {};
    const ourHelper = settings.otelHeadersHelper === helperCommand(dataDir);
    const ourEndpoint = typeof env0.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT === 'string' && env0.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT.endsWith(OTLP_PATH);
    if (args.status) {
      say(ourHelper && ourEndpoint ? ACTIVITY_MESSAGES.already(env0.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT.slice(0, -OTLP_PATH.length)) : ACTIVITY_MESSAGES.notOn);
      return 0;
    }
    if (!ourHelper && !ourEndpoint) {
      say(ACTIVITY_MESSAGES.notOn);
      return 0;
    }
    const next = { ...settings, env: { ...env0 } };
    // Only what this script set, and only while it still holds this script's values.
    const base = ourEndpoint ? env0.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT.slice(0, -OTLP_PATH.length) : null;
    const ours = base ? activityEnv(base) : {};
    for (const [k, v] of Object.entries(ours)) if (next.env[k] === v) delete next.env[k];
    if (Object.keys(next.env).length === 0) delete next.env;
    if (ourHelper) delete next.otelHeadersHelper;
    writeAtomic(settingsFile, `${JSON.stringify(next, null, 2)}\n`);
    try {
      fs.rmSync(path.join(dataDir, HELPER_FILE), { force: true });
    } catch {
      // nothing to remove
    }
    say(ACTIVITY_MESSAGES.off);
    return 0;
  }

  if (!saved) {
    say(ACTIVITY_MESSAGES.notConnected);
    return 1;
  }
  let base;
  try {
    base = normaliseBaseUrl(saved.baseUrl || configured.baseUrl || '');
  } catch {
    say(ACTIVITY_MESSAGES.noAddress);
    return 1;
  }
  if (isOn(settings, base, dataDir) && fs.existsSync(path.join(dataDir, HELPER_FILE))) {
    say(ACTIVITY_MESSAGES.already(base));
    say(ACTIVITY_MESSAGES.what);
    return 0;
  }
  const other = otherExport(settings, base, dataDir);
  if (other) {
    say(ACTIVITY_MESSAGES.otherExport(other, fileWords));
    return 1;
  }
  const elsewhere = exportElsewhere(env, managedFiles, base, dataDir);
  if (elsewhere) {
    say(elsewhere);
    return 1;
  }
  writeAtomic(path.join(dataDir, HELPER_FILE), HELPER_SOURCE, 0o700);
  const next = {
    ...settings,
    env: { ...(settings.env && typeof settings.env === 'object' ? settings.env : {}), ...activityEnv(base) },
    otelHeadersHelper: helperCommand(dataDir),
  };
  writeAtomic(settingsFile, `${JSON.stringify(next, null, 2)}\n`);
  say(ACTIVITY_MESSAGES.on(base));
  say(ACTIVITY_MESSAGES.what);
  say(ACTIVITY_MESSAGES.restart);
  say(ACTIVITY_MESSAGES.shellNote);
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
  activity().then(
    (code) => process.exit(code),
    () => {
      process.stdout.write('Aimiru could not change the settings. Nothing was changed.\n');
      process.exit(1);
    },
  );
}
