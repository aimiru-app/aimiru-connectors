// Codex's take path for the runner (ADR-0161): the runner on this computer asks Aimiru for the job
// the person gave Codex and starts it here, exactly as `aimiru-codex take` does. Nothing new decides
// whether a job may run: readyToTake (Aimiru's check in Codex's settings as install wrote it,
// trusted at its current hash, run inside Codex since the install, checks on in Codex and the
// folder, not turned off) and runJob (`codex exec` with EXEC_FLAGS only, AIMIRU_TASK_ID in its
// environment, short notes, the redacted result) are take.mjs's own, unchanged.

import { spawnSync } from 'node:child_process';
import { loadSettings, makeClient } from './runtime.mjs';
import { INSTALL_LINE, codexBinOf, notReadyText, readyToTake, runJob } from './take.mjs';
import { JOB_WORDS } from './words.mjs';

/** The shape the shared runner reads (vendor/runner.mjs RUNNER_AGENT_VERSION). */
export const RUNNER_AGENT = 1;

/** Codex is on this computer: `codex --version` answers. */
function codexFound(env) {
  try {
    const r = spawnSync(codexBinOf(env), ['--version'], { encoding: 'utf8', timeout: 5_000, stdio: ['ignore', 'pipe', 'ignore'], env });
    return !r.error && r.status === 0;
  } catch {
    return false;
  }
}

/**
 * Codex for the runner: {connector, label, ready(dir), client, run({task, dir, print, stop, spawn})}.
 * Settings are read again at each look, so a key connected again is used without a restart.
 * @param {object} [o] @param {object} [o.env]
 */
export function runnerAgent({ env = process.env } = {}) {
  let cached = null;
  const clientFor = (settings) => {
    if (!cached || cached.token !== settings.token || cached.baseUrl !== settings.baseUrl) {
      cached = { token: settings.token, baseUrl: settings.baseUrl, client: makeClient(settings) };
    }
    return cached.client;
  };
  return {
    connector: 'codex',
    label: 'Codex',
    ready(dir) {
      const settings = loadSettings(env);
      if (!settings.token || !settings.baseUrl) return { ok: false, why: 'no_key', text: JOB_WORDS.takeNoKey(INSTALL_LINE) };
      if (!codexFound(env)) return { ok: false, why: 'no_codex', text: JOB_WORDS.takeNoCodex };
      const r = readyToTake(settings, { dir, env });
      return r.ok ? { ok: true } : { ok: false, why: r.why, text: notReadyText(r) };
    },
    get client() {
      return clientFor(loadSettings(env));
    },
    async run({ task, dir, print, stop, spawn }) {
      const settings = loadSettings(env);
      return runJob({ task, dir, settings, env, client: clientFor(settings), print, stop, ...(spawn ? { spawn } : {}) });
    },
  };
}
