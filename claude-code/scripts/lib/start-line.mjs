// Whether a session start may use the line Aimiru's Connect screen copies (ADR-0312; the Opus security
// gate of 23 Nov 2026, M1). Claude Code gives a hook the environment of a trusted project's settings
// file (its `env`), so a repository could commit AIMIRU_START_TICKET beside an address of its own and
// re-pair the person's Claude Code at their next session start, over the key they have. A session start
// therefore uses a ticket only when all of these hold:
//   1. no key is known on this computer: none in the plugin's settings or the environment, and no key
//      file in the data folder, not even one that cannot be read (an unreadable key is a connection
//      the person made, never "none");
//   2. no settings file Claude Code reads sets the ticket, or anything that changes how Aimiru's check
//      runs (turnsAimiruOff: the data folder, the address, the key, the settings folder): the line puts
//      the ticket in the shell that starts Claude Code, never in a file; a file that cannot be read is
//      treated as one that does;
// and connect.mjs, run from a session start, pairs only with Aimiru's own address (DEFAULT_ADDRESS),
// never one from the environment, the plugin's settings or a request a run before it kept.
// A computer that is connected keeps its key; to connect it to another account, the person types
// /aimiru:connect --again, and the session's first line says the account whenever it changes.
//
// Pure apart from reading those files.

import fs from 'node:fs';
import os from 'node:os';
import { findDataDir, keyFilePath, loadSettings, turnsAimiruOff } from './runtime.mjs';
import { settingsFiles } from './native-prompt.mjs';
import { MESSAGES } from '../vendor/messages.mjs';
import { startTicketFrom } from '../vendor/pair.mjs';

/** The environment name the line hands the ticket over in. */
export const TICKET_ENV = 'AIMIRU_START_TICKET';

/**
 * Whether this computer already has a key for Claude Code: one in the plugin's settings or the
 * environment (loadSettings), or a key file in the data folder, whether or not it can be read.
 */
export function keyKnown(env = process.env) {
  const dataDir = findDataDir(env);
  if (loadSettings({ ...env, CLAUDE_PLUGIN_DATA: dataDir }).token) return true;
  try {
    fs.lstatSync(keyFilePath(dataDir));
    return true;
  } catch (e) {
    // Only a key file that is not there is no key; any other failure to look is one.
    return !(e && (e.code === 'ENOENT' || e.code === 'ENOTDIR'));
  }
}

/** Whether a settings file's `env` names the ticket (any case, as Claude Code passes names as written). */
function setsTicket(json) {
  const env = json?.env;
  return Boolean(env && typeof env === 'object' && Object.keys(env).some((k) => k.toUpperCase() === TICKET_ENV));
}

/**
 * Whether any settings file Claude Code reads for this session sets the ticket, or changes how
 * Aimiru's check runs. `files` is settingsFiles' list (a test seam); by default the managed, user,
 * project and local files of the session's project folder.
 */
export function settingsCarryLine(env = process.env, files = null) {
  const list = files ?? settingsFiles({ env, projectDir: env.CLAUDE_PROJECT_DIR || process.cwd(), home: env.HOME || os.homedir() });
  for (const { file } of list) {
    let raw;
    try {
      raw = fs.readFileSync(file, 'utf8');
    } catch (e) {
      if (e && (e.code === 'ENOENT' || e.code === 'ENOTDIR')) continue;
      return true;
    }
    let json;
    try {
      json = JSON.parse(raw);
    } catch {
      return true;
    }
    if (setsTicket(json) || turnsAimiruOff(json)) return true;
  }
  return false;
}

/**
 * Why a session start does not use the line in this environment: null when it may (or there is no
 * line), 'connected' when a key is known here, 'settings' when a settings file carries it.
 * @param {object} env @param {{ticket: string|null, files?: Array<{file: string}>|null}} o
 */
export function lineRefusal(env, { ticket, files = null }) {
  if (!ticket) return null;
  if (keyKnown(env)) return 'connected';
  if (settingsCarryLine(env, files)) return 'settings';
  return null;
}

/**
 * What a session start without a key says about a line from the Connect screen: that the request is
 * on its way, or that it was not used; null when there is no line or a key is known here (the usual
 * line stands, and a connected session adds lineNotUsedConnected after the account).
 */
export function startLineMessage(env, settings, files = null) {
  const ticket = startTicketFrom(env);
  const why = lineRefusal({ ...env, CLAUDE_PLUGIN_DATA: settings.dataDir }, { ticket, files });
  if (!ticket || why === 'connected') return null;
  return why === 'settings' ? MESSAGES.lineNotUsedSettings : MESSAGES.connectingFromLine;
}
