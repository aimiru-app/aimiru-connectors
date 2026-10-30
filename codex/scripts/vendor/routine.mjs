// GENERATED COPY of connectors/shared/routine.mjs. Do not edit here: edit shared/ and run `node scripts/sync-shared.mjs`.
// The Aimiru routine's version, as a connector reports it in its heartbeat (skill_version, ADR-0037).
// Each connector ships the routine as skills/aimiru/SKILL.md, written by `bun scripts/sync-routine.ts`
// from packages/core/src/routine.ts; this reads the version back from that file exactly as core's
// routineVersionOf does (workers/agent-api/test/routine.test.ts checks the two agree). A connector
// reports the version of the file it actually carries, so a deleted or older file shows as such.

import fs from 'node:fs';

export const ROUTINE_VERSION_KEY = 'aimiru-routine-version';

const VERSION_LINE = /^\s*aimiru-routine-version:\s*"?([0-9A-Za-z][0-9A-Za-z.-]{0,39})"?\s*$/m;

/** The routine version a SKILL.md carries, or null. */
export function routineVersionOf(text) {
  const m = VERSION_LINE.exec(String(text ?? ''));
  return m ? m[1] : null;
}

/** The routine version of the SKILL.md at this path, or null when it is missing or unreadable. */
export function readSkillVersion(file) {
  try {
    return routineVersionOf(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}
