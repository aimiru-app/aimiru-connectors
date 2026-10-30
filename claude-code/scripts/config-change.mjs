#!/usr/bin/env node
// Aimiru for Claude Code: ConfigChange.
//
// Stops a settings change that would turn Aimiru off from taking effect in the running session:
// "disableAllHooks": true, this plugin set to false in "enabledPlugins", or an "env" entry that
// changes how the check runs (NODE_OPTIONS, NODE_PATH, CLAUDE_PLUGIN_*). An agent could make
// such a change with a shell command; the person can still make it, and it applies when Claude
// Code restarts. Aimiru is told at once, so it can show the agent's tier truthfully (ADR-0007).
// Policy (managed) settings cannot be blocked and are left alone.

import fs from 'node:fs';
import { CONNECTOR, VERSION, loadSettings, makeClient, pluginInstallSource, readStdinJson, skillVersion, turnsAimiruOff, writeJson } from './lib/runtime.mjs';

async function main() {
  let input = {};
  try {
    input = await readStdinJson();
  } catch {
    return;
  }
  if (!input || input.source === 'policy_settings' || !input.file_path) return;
  let parsed = null;
  try {
    parsed = JSON.parse(fs.readFileSync(input.file_path, 'utf8'));
  } catch {
    return;
  }
  if (!turnsAimiruOff(parsed)) return;

  writeJson({ decision: 'block', reason: 'Aimiru stays on until Claude Code restarts.' });

  const settings = loadSettings();
  const client = makeClient(settings, { spool: false });
  if (client.configured) {
    await client.heartbeat(
      {
        connector: CONNECTOR,
        version: VERSION,
        client_version: null,
        install_source: pluginInstallSource(),
        environment: { hooks_enabled: false, disable_pending: true, source: input.source || null },
        // Same as every heartbeat, so this one never reads as the routine dropped (ADR-0037).
        skill_version: skillVersion(settings),
      },
      { timeoutMs: 4_000 },
    );
  }
}

main().then(
  () => process.exit(0),
  () => process.exit(0),
);
