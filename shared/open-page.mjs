// Opens the pairing page in the person's own browser (ADR-0150; Mac run part 1, item 2, 28 Oct
// 2026: printing a link to open on a phone was "very tedious", and the page opened in the browser
// on the same computer was the right way in). The connector still prints the link, for a phone.
//
// It starts one program, the system's own opener (open on a Mac, xdg-open on Linux, start on
// Windows), with the address as one argument, never through a shell, and only:
//   - for the pairing page on the Aimiru this computer pairs with (`<address>/pair/<code>`), written
//     in letters, digits, dots, dashes, underscores, tildes and slashes, so no shell and no Windows
//     command line reads anything in it, and no other kind of link (file:, an app's own) is opened;
//   - where a browser opens in front of the person: never over SSH (SSH_CONNECTION, SSH_CLIENT or
//     SSH_TTY set), never with AIMIRU_NO_BROWSER=1, and on Linux and other systems only with a
//     screen (DISPLAY or WAYLAND_DISPLAY).
//
// Only Claude Code's and Codex's connectors carry this file (scripts/sync-shared.mjs,
// TARGET_ONLY_FILES): OpenClaw's plugin store refuses a plugin that starts other programs, so
// pair.mjs, which every connector carries, never imports it; Claude Code and Codex hand pairAgent
// an opener from their own entry points.
//
// Zero dependencies: Node 18+ built-ins only. Vendored by scripts/sync-shared.mjs; edit it only in
// connectors/shared/ and run `node scripts/sync-shared.mjs`.

import { spawn as childSpawn } from 'node:child_process';
import { normaliseBaseUrl, setting } from './aimiru-client.mjs';

/** A page address with nothing a shell or Windows' command line reads specially. */
const PLAIN_PAGE = /^https?:\/\/[A-Za-z0-9.-]+(?::\d{1,5})?(?:\/[A-Za-z0-9._~-]+)+$/;
/** A pairing code as Aimiru shows it (KQ7-4MZ), with room for a longer one later. */
const PAIR_CODE = /^[A-Za-z0-9]{1,12}(?:-[A-Za-z0-9]{1,12}){0,3}$/;
/** How long the opener has to start before this run stops waiting on it (it never waits on the browser). */
const START_WAIT_MS = 2_000;
/**
 * How long a started opener may take to end. `open` and `start` hand the page to the browser and end
 * at once, with a failure when nothing could open it (no browser, or a sandbox refusing it); one
 * still running after this is opening the page (xdg-open may run the browser itself).
 */
const SETTLE_MS = 1_500;

const present = (v) => typeof v === 'string' && v.trim() !== '';

/**
 * True when a browser opened here appears in front of the person: not over SSH, not turned off with
 * AIMIRU_NO_BROWSER=1, and on systems other than macOS and Windows only
 * with a screen to show it on.
 */
export function browserHere(env = process.env, platform = process.platform) {
  if (String(setting(env, 'NO_BROWSER') ?? '').trim() === '1') return false;
  if (present(env?.SSH_CONNECTION) || present(env?.SSH_CLIENT) || present(env?.SSH_TTY)) return false;
  if (platform === 'darwin' || platform === 'win32') return true;
  return present(env?.DISPLAY) || present(env?.WAYLAND_DISPLAY);
}

/**
 * The page to open: `url` when it is the pairing page (`<address>/pair/<code>`) on the Aimiru at
 * `baseUrl`, written plainly; else null.
 */
export function pageToOpen(url, baseUrl) {
  if (typeof url !== 'string' || typeof baseUrl !== 'string' || url.length > 300) return null;
  let base;
  try {
    base = normaliseBaseUrl(baseUrl);
  } catch {
    return null;
  }
  const prefix = `${base}/pair/`;
  if (!url.startsWith(prefix) || !PAIR_CODE.test(url.slice(prefix.length))) return null;
  return PLAIN_PAGE.test(url) ? url : null;
}

/**
 * The program that opens `url` in the default browser on `platform`, with the address as its one
 * argument (Windows: `start` is part of its command line, so `cmd /d /s /c start "" <url>`, taken as
 * written; the address holds nothing that command line reads specially).
 */
export function openCommand(url, platform = process.platform) {
  if (platform === 'darwin') return { command: 'open', args: [url] };
  if (platform === 'win32') return { command: 'cmd', args: ['/d', '/s', '/c', 'start', '""', url], windowsVerbatimArguments: true };
  return { command: 'xdg-open', args: [url] };
}

/**
 * Opens the pairing page `url` in the person's default browser, when it is the page on the Aimiru at
 * `baseUrl` and a browser opens here (browserHere). Resolves true when the opener handed the page on
 * (it ended without a failure, or is still running after a moment), false when nothing opened it;
 * never throws, and never waits for the browser itself.
 * @param {string} url
 * @param {{baseUrl?: string, env?: object, platform?: string, spawn?: Function, settleMs?: number}} [o]
 */
export function openPage(url, { baseUrl = null, env = process.env, platform = process.platform, spawn = childSpawn, settleMs = SETTLE_MS } = {}) {
  const page = pageToOpen(url, baseUrl);
  if (!page || !browserHere(env, platform)) return Promise.resolve(false);
  const { command, args, windowsVerbatimArguments } = openCommand(page, platform);
  return new Promise((resolve) => {
    let settled = false;
    let child = null;
    const timers = [];
    const done = (ok) => {
      if (settled) return;
      settled = true;
      for (const t of timers) clearTimeout(t);
      // This run never waits for the opener, or the browser it started, to end.
      try {
        child?.unref();
      } catch {
        // nothing to let go of
      }
      resolve(ok);
    };
    try {
      child = spawn(command, args, {
        env,
        stdio: 'ignore',
        detached: true,
        windowsHide: true,
        ...(windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
      });
    } catch {
      done(false);
      return;
    }
    child.once('error', () => done(false));
    child.once('exit', (code) => done(code === 0));
    const starting = setTimeout(() => done(false), START_WAIT_MS);
    timers.push(starting);
    child.once('spawn', () => {
      clearTimeout(starting);
      timers.push(setTimeout(() => done(true), settleMs));
    });
  });
}
