// Programs Codex wrote (CN6; ADR-0090 for Codex), as Aimiru for Claude Code keeps them
// (claude-code/scripts/lib/runtime.mjs and pre-tool-use.mjs): what a session began with, so newness
// is counted from it; the programs a question was about, by file and content, so a yes is used only
// for those, unchanged; and a yes for a program, kept for the rest of the session while the file is
// unchanged. Every record is signed with a MAC keyed by the agent key, so nothing else written to
// this folder can move where newness is counted from or let a file run.

import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/** How long what a session began with is kept (a session can be resumed for days). */
export const SESSION_BASELINE_TTL_MS = 14 * 24 * 3600_000;
/** How long a yes for a program lasts at most, within its session. */
export const PROGRAM_YES_TTL_MS = 24 * 3600_000;

const sha256Hex = (s) => createHash('sha256').update(String(s)).digest('hex');

function sessionMac(secret, session, baseline) {
  return createHmac('sha256', `aimiru-session:${secret}`).update(`${JSON.stringify(String(session ?? ''))}\n${JSON.stringify(baseline ?? null)}`).digest('hex');
}

function programMac(secret, session, file, sha256, ts) {
  return createHmac('sha256', `aimiru-program:${secret}`).update(`${JSON.stringify(String(session ?? ''))}\n${JSON.stringify(String(file ?? ''))}\n${sha256}\n${ts}`).digest('hex');
}

function macEqual(a, b) {
  const x = Buffer.from(String(a ?? ''), 'utf8');
  const y = Buffer.from(String(b ?? ''), 'utf8');
  return x.length === y.length && x.length > 0 && timingSafeEqual(x, y);
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

/** The session records in Codex's data folder, keyed by the agent key (`secret`). */
export function programStore(dataDir, { secret = '' } = {}) {
  const sessionFile = (session) => path.join(dataDir, 'sessions', `${sha256Hex(`session:${String(session ?? '')}`).slice(0, 40)}.json`);
  const programFile = (session, file) => path.join(dataDir, 'programs', `${sha256Hex(`program:${String(session ?? '')}\u0000${String(file ?? '')}`).slice(0, 40)}.json`);
  return {
    /** What this session began with, when the record is there and verifies; else null. */
    sessionBaseline(session, now = Date.now()) {
      if (!secret || !session) return null;
      const v = readJson(sessionFile(session));
      if (!v || v.session !== String(session) || !v.baseline || typeof v.baseline !== 'object') return null;
      if (!macEqual(v.mac, sessionMac(secret, session, v.baseline))) return null;
      if (!Number.isFinite(v.baseline.startedAt) || now - v.baseline.startedAt > SESSION_BASELINE_TTL_MS) return null;
      return v.baseline;
    },
    /** Kept once, at the session's first check: a later check never moves it. True when kept now. */
    putSessionBaseline(session, baseline) {
      if (!secret || !session || !baseline || typeof baseline !== 'object') return false;
      if (this.sessionBaseline(session)) return false;
      writeJson(sessionFile(session), { session: String(session), baseline, mac: sessionMac(secret, session, baseline) });
      return true;
    },
    /** The person allowed these programs: the same file with the same content runs as local work for the rest of the session. */
    rememberPrograms(session, programs, now = Date.now()) {
      if (!secret || !session || !Array.isArray(programs)) return;
      for (const p of programs) {
        if (!p?.path || !/^[0-9a-f]{64}$/.test(String(p.sha256 ?? ''))) continue;
        writeJson(programFile(session, p.path), { session: String(session), path: p.path, sha256: p.sha256, ts: now, mac: programMac(secret, session, p.path, p.sha256, now) });
      }
    },
    /** True when the person allowed this exact content of this file in this session, and the record verifies. */
    programAllowed(session, file, sha256, now = Date.now()) {
      if (!secret || !session || !file || !sha256) return false;
      const v = readJson(programFile(session, file));
      if (!v || v.session !== String(session) || v.path !== file || v.sha256 !== sha256) return false;
      if (!macEqual(v.mac, programMac(secret, session, file, sha256, v.ts))) return false;
      return Number.isFinite(v.ts) && now - v.ts < PROGRAM_YES_TTL_MS;
    },
  };
}

/** The programs an action runs, by file and content, in a fixed order. */
export function programKeys(action) {
  if (!Array.isArray(action?.programs)) return [];
  return action.programs
    .map((p) => ({ path: String(p.path ?? ''), sha256: p.sha256 ?? null }))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

export const sameKeys = (a, b) => JSON.stringify(a ?? []) === JSON.stringify(b ?? []);

/** Every program known by the sha256 of its content (one the same command writes is not). */
export const fullyKnown = (keys) => keys.every((k) => /^[0-9a-f]{64}$/.test(String(k.sha256 ?? '')));

/**
 * Whether a yes covers what runs now: no program asked about, or every one known by its content
 * and the same as when the person was asked (`now`: the keys read again at this moment).
 */
export function yesCovers(askedAbout, now) {
  return !askedAbout.length || (fullyKnown(askedAbout) && sameKeys(askedAbout, now));
}
