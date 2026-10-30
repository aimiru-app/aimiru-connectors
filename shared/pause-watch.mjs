// Pause watch (ADR-0142; CN8 in docs/specs/2026-10-28-say-it-once-build-plan.md): how Aimiru for
// Claude Code and Codex's check learn of a Pause between their checks, confirm it to Aimiru
// (POST /v1/pause/ack), and how a held step learns that the Pause ended.
//
// One data folder is one agent on one computer, so everything here is per folder:
//   paused.json        the pause memory (aimiru-client.mjs createPauseMemory), with when it began here
//   pause-seen.json    the last read of GET /v1/pause any process made: {at, paused, clear_at,
//                      tried_at, next_at}, so the folder reads at most once every 3 s and a held
//                      step can use the watcher's read
//   pause-poll.lock    held while one process reads (stale after 10 s: a process that died)
//   pause-lease.json   until when the watcher keeps reading: every step and hook extends it
//   pause-steps.log    when steps were let through, the last 500 (steps_after)
//   pause-ack.json     this pause's acknowledgement: {since, learned_by, steps_after, acked, gone,
//                      first, pause_at, ms_after_tap}
//   pause-last.json    when the last confirmed pause began, on Aimiru's clock
//   pause-trace.jsonl  each pause, acknowledgement, hold and its end, owner only (appendTrace)
//
// GET /v1/pause is read as it is: no start, no id. A pause is one stretch of reads that say paused,
// as this folder saw them (the memory's `since`); Aimiru keeps the first acknowledgement of each
// pause per agent and answers first: false after, so a second one costs nothing. A resume is never
// acknowledged: it clears the memory and the stored snapshot, and asks for a fresh one, so nothing
// is decided on this computer from a snapshot sealed before the Resume.
//
// Claude Code and Codex carry a copy (TARGET_ONLY_FILES in scripts/sync-shared.mjs). Vendored by
// scripts/sync-shared.mjs: edit it only in connectors/shared/.

import fs from 'node:fs';
import path from 'node:path';
import { PAUSE_TRACE_FILE, appendTrace, setting, sleep } from './aimiru-client.mjs';

export const PAUSE_WATCH_VERSION = 1;
/** At most one read of the Pause every this long, per agent on one computer (CONTRACT.md). */
export const POLL_EVERY_MS = 3_000;
/** The watcher reads while a step or a hook was seen within this long. */
export const LEASE_MS = 120_000;
/** A held step ends at this ceiling, below the check's own limit of 3600 s (ADR-0142). */
export const HOLD_CEILING_MS = 55 * 60_000;
/** steps_after is sent only when the last read that showed no pause is this recent. */
export const STEPS_WINDOW_MS = 60_000;
/** A poll lock older than this belongs to a process that died. */
const POLL_LOCK_STALE_MS = 10_000;
/** How many go-ahead times pause-steps.log keeps. */
const STEPS_KEPT = 500;

/**
 * Whether a step holds while paused, or is refused at once as before (ADR-0022): the one switch the
 * Mac run decides for each maker (does it wait 90 s on a check). `defaultOn` is the connector's own
 * setting; AIMIRU_PAUSE_HOLD=0 refuses instead, which is as safe: either way
 * the step does not run while paused. The setting only narrows, as the others only shorten: it can
 * never turn on a hold the connector has off because its maker was not seen to wait (devrel review).
 */
export function pauseHoldOn(env = process.env, defaultOn = true) {
  const v = String(setting(env, 'PAUSE_HOLD') ?? '').trim();
  if (v === '0') return false;
  return defaultOn;
}

/** The hold's ceiling: AIMIRU_PAUSE_HOLD_CEILING_MS can only make it shorter (tests, the Mac run). */
export function holdCeilingMs(env = process.env) {
  const v = Number(setting(env, 'PAUSE_HOLD_CEILING_MS'));
  return Number.isFinite(v) && v > 0 ? Math.min(HOLD_CEILING_MS, v) : HOLD_CEILING_MS;
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function writeJson(file, obj) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const tmp = `${file}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(obj), { mode: 0o600 });
    fs.renameSync(tmp, file);
    return true;
  } catch {
    return false;
  }
}

/**
 * The pause watch's state for one connector's data folder. Nothing here talks to Aimiru; pollOnce,
 * ackOnce, watchLoop and holdWhilePaused do, through the connector's client.
 * @param {{dataDir: string}} opts
 */
export function createPauseWatch({ dataDir }) {
  const file = (name) => path.join(dataDir, name);
  const SEEN = file('pause-seen.json');
  const LOCK = file('pause-poll.lock');
  const LEASE = file('pause-lease.json');
  const STEPS = file('pause-steps.log');
  const ACK = file('pause-ack.json');
  const LAST = file('pause-last.json');

  return {
    dataDir,

    /** False once the data folder is gone (the connector removed): a watcher then ends. */
    alive() {
      return fs.existsSync(dataDir);
    },

    /** A step was let through now (every go-ahead of the check): counted for steps_after. */
    noteStep(at = Date.now()) {
      try {
        fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
        fs.appendFileSync(STEPS, `${Math.floor(at)}\n`, { mode: 0o600 });
        if (fs.statSync(STEPS).size > STEPS_KEPT * 2 * 15) {
          const kept = fs.readFileSync(STEPS, 'utf8').split('\n').filter(Boolean).slice(-STEPS_KEPT);
          const tmp = `${STEPS}.${process.pid}.tmp`;
          fs.writeFileSync(tmp, `${kept.join('\n')}\n`, { mode: 0o600 });
          fs.renameSync(tmp, STEPS);
        }
      } catch {
        // a step not counted makes steps_after lower, never a step held or let through
      }
    },

    /** The steps let through after `from` and at or before `to`. */
    stepsBetween(from, to = Date.now()) {
      try {
        return fs
          .readFileSync(STEPS, 'utf8')
          .split('\n')
          .map(Number)
          .filter((t) => Number.isFinite(t) && t > from && t <= to).length;
      } catch {
        return 0;
      }
    },

    /** Keeps the watcher reading until at least now + ms (each step and hook calls it). */
    extendLease(ms = LEASE_MS, now = Date.now()) {
      const until = now + ms;
      const cur = Number(readJson(LEASE)?.until);
      if (!(Number.isFinite(cur) && cur >= until)) writeJson(LEASE, { until });
      return Math.max(until, Number.isFinite(cur) ? cur : 0);
    },

    /** Until when the watcher reads (ms since the epoch), 0 when no lease was ever taken. */
    leaseUntil() {
      const v = Number(readJson(LEASE)?.until);
      return Number.isFinite(v) ? v : 0;
    },

    /** The last read of GET /v1/pause any process of this folder made, or null. */
    lastRead() {
      const v = readJson(SEEN);
      return v && typeof v === 'object' ? v : null;
    },

    /** A read that answered (200): whether it said paused, and, when it did not, when it said so. */
    noteRead(paused, now = Date.now()) {
      const prev = this.lastRead() || {};
      writeJson(SEEN, { ...prev, at: now, paused: paused === true, clear_at: paused === true ? prev.clear_at ?? null : now });
    },

    /** A read was tried now (answered or not); the next one waits until nextAt (a 429's retry-after). */
    noteTried(now = Date.now(), nextAt = null) {
      const prev = this.lastRead() || {};
      writeJson(SEEN, { ...prev, tried_at: now, next_at: Number.isFinite(nextAt) ? nextAt : null });
    },

    /** A read that answered within maxAgeMs, by any process of this folder, or null. */
    freshRead(maxAgeMs = POLL_EVERY_MS, now = Date.now()) {
      const v = this.lastRead();
      const at = Number(v?.at);
      return v && Number.isFinite(at) && now - at >= 0 && now - at < maxAgeMs ? v : null;
    },

    /** True when no read was tried within everyMs (answered or not) and no retry-after holds. */
    pollDue(everyMs = POLL_EVERY_MS, now = Date.now()) {
      const v = this.lastRead();
      const tried = Number(v?.tried_at);
      const next = Number(v?.next_at);
      if (Number.isFinite(next) && next > 0 && now < next) return false;
      return !(Number.isFinite(tried) && now - tried >= 0 && now - tried < everyMs);
    },

    /**
     * Takes the folder's poll lock (exclusive create); a lock older than 10 s is taken over. When the
     * lock cannot be made for any reason but another process holding it (a full or read-only disk),
     * it reads without the lock rather than never: a hold that never reads never sees the Resume
     * (quality review of wk/connectors-flow). It never makes the data folder: one removed by hand
     * stays removed (alive()).
     */
    takePollLock() {
      try {
        fs.writeFileSync(LOCK, String(process.pid), { flag: 'wx', mode: 0o600 });
        return true;
      } catch (e) {
        if (e?.code !== 'EEXIST') return true;
        try {
          if (Date.now() - fs.statSync(LOCK).mtimeMs > POLL_LOCK_STALE_MS) {
            fs.rmSync(LOCK, { force: true });
            fs.writeFileSync(LOCK, String(process.pid), { flag: 'wx', mode: 0o600 });
            return true;
          }
        } catch {
          // another process won the race
        }
        return false;
      }
    },

    releasePollLock() {
      try {
        if (fs.readFileSync(LOCK, 'utf8') === String(process.pid)) fs.rmSync(LOCK, { force: true });
      } catch {
        // gone already
      }
    },

    /** This pause's acknowledgement state, or null. */
    ackState() {
      const v = readJson(ACK);
      return v && typeof v === 'object' ? v : null;
    },

    writeAckState(state) {
      if (state === null) {
        try {
          fs.rmSync(ACK, { force: true });
        } catch {
          // ignore
        }
        return;
      }
      writeJson(ACK, state);
    },

    /**
     * When the last pause Aimiru confirmed began, on Aimiru's clock (an acknowledgement's pause_at),
     * kept after the resume: a yes given before it is never used after it (ADR-0035).
     */
    lastPauseAt() {
      const v = readJson(LAST);
      return typeof v?.pause_at === 'string' && Number.isFinite(Date.parse(v.pause_at)) ? v.pause_at : null;
    },

    notePauseAt(pauseAt) {
      if (typeof pauseAt === 'string' && Number.isFinite(Date.parse(pauseAt))) writeJson(LAST, { pause_at: pauseAt });
    },

    /** One line in pause-trace.jsonl. */
    trace(entry) {
      return appendTrace(dataDir, PAUSE_TRACE_FILE, entry);
    },
  };
}

/**
 * True when a yes the person gave at `answeredAt` (Aimiru's clock) came before the last pause this
 * folder confirmed: such a yes is never used after that pause (ADR-0035, ADR-0142), so the step is
 * asked about again. False when either time is unknown.
 */
export function yesBeforeLastPause(watch, answeredAt) {
  const pause = Date.parse(watch?.lastPauseAt?.() ?? '');
  const yes = Date.parse(answeredAt ?? '');
  return Number.isFinite(pause) && Number.isFinite(yes) && yes < pause;
}

/** Clears the snapshot and asks for a fresh one: nothing is decided here from one sealed before. */
function freshSnapshot(local) {
  try {
    local?.remove?.();
    local?.requestRefresh?.();
  } catch {
    // the snapshot's own age still ends it
  }
}

/**
 * Notes that this folder learned of the pause in its memory now (learnedBy 'watch' or 'held'),
 * once per pause: the steps let through since the last read that showed no pause (null when that
 * read is over a minute old, since the connector cannot say), a trace line, and a fresh snapshot.
 * Returns this pause's acknowledgement state, or null when nothing is paused here.
 */
export function notePauseLearned(client, watch, { learnedBy = 'watch', local = null, now = Date.now() } = {}) {
  const mem = client.pausedLocally();
  if (!mem) return null;
  const state = watch.ackState();
  if (state && state.since === mem.since) return state;
  const clearAt = Number(watch.lastRead()?.clear_at);
  const stepsAfter = Number.isFinite(clearAt) && now - clearAt >= 0 && now - clearAt <= STEPS_WINDOW_MS ? watch.stepsBetween(clearAt, now) : null;
  const next = { since: mem.since, learned_by: learnedBy === 'held' ? 'held' : 'watch', steps_after: stepsAfter, acked: false, gone: false, tries: 0 };
  watch.writeAckState(next);
  watch.trace({ event: 'paused', learned_by: next.learned_by, steps_after: stepsAfter });
  freshSnapshot(local);
  return next;
}

/** The resume: the memory is already cleared by the read that said so. */
function noteResumed(watch, { local = null, by = 'read' } = {}) {
  watch.writeAckState(null);
  watch.trace({ event: 'resumed', by });
  freshSnapshot(local);
}

/**
 * Confirms the pause in this folder's memory to Aimiru (POST /v1/pause/ack), unless it is confirmed
 * already, or Aimiru is older than the route (404 or 405: it stops sending for this pause). A 429, a
 * 5xx or no answer leaves it to the next poll. The answer is a read too: paused false is a resume.
 * Returns {sent, ok?, acked?, gone?, resumed?, refused?, ...answer}.
 */
export async function ackOnce(client, watch, { learnedBy = 'watch', local = null, timeoutMs = 3_000 } = {}) {
  const mem = client.pausedLocally();
  if (!mem) return { sent: false };
  let state = watch.ackState();
  if (!state || state.since !== mem.since) state = notePauseLearned(client, watch, { learnedBy, local });
  if (!state) return { sent: false };
  if (state.acked || state.gone) return { sent: false, acked: Boolean(state.acked), gone: Boolean(state.gone) };
  const r = await client.pauseAck({ learnedBy: state.learned_by, stepsAfter: state.steps_after }, { timeoutMs });
  if (r.ok) {
    const d = r.data && typeof r.data === 'object' ? r.data : {};
    if (d.paused === false) {
      // Resumed before the acknowledgement arrived: nothing to confirm, and nothing to hold.
      noteResumed(watch, { local, by: 'ack' });
      return { sent: true, ok: true, resumed: true, ...d };
    }
    const acked = d.acknowledged === true;
    watch.writeAckState({ ...state, acked, first: d.first === true, pause_at: d.pause_at ?? null, ms_after_tap: d.ms_after_tap ?? null, tries: (state.tries ?? 0) + 1 });
    watch.notePauseAt(d.pause_at ?? null);
    watch.trace({ event: 'acknowledged', learned_by: state.learned_by, steps_after: state.steps_after, acknowledged: acked, first: d.first === true, pause_at: d.pause_at ?? null, ms_after_tap: d.ms_after_tap ?? null });
    return { sent: true, ok: true, acked, ...d };
  }
  const fromAimiru = r.kind === 'http' && r.fromAimiru !== false;
  if (fromAimiru && (r.status === 404 || r.status === 405)) {
    watch.writeAckState({ ...state, gone: true });
    watch.trace({ event: 'ack_unsupported', status: r.status });
    return { sent: true, ok: false, gone: true };
  }
  watch.writeAckState({ ...state, tries: (state.tries ?? 0) + 1 });
  if (fromAimiru && r.status === 401) return { sent: true, ok: false, refused: true, code: r.code ?? null };
  return { sent: true, ok: false, status: r.status ?? 0 };
}

/**
 * One read of GET /v1/pause for this folder (the caller holds the poll lock). The client writes or
 * clears the pause memory from the answer. A new pause is noted and acknowledged; the same pause is
 * acknowledged again only if that has not reached Aimiru yet; a resume clears the snapshot. Network
 * trouble changes nothing. Returns {ok, paused?, changed: 'paused'|'resumed'|null, refused?,
 * retryAfterMs?, ack?}.
 */
export async function pollOnce(client, watch, { local = null, timeoutMs = 3_000, learnedBy = 'watch', now = Date.now } = {}) {
  const before = client.pausedLocally();
  watch.noteTried(now());
  const r = await client.pause({ timeoutMs });
  if (!r.ok) {
    const fromAimiru = r.kind === 'http' && r.fromAimiru !== false;
    if (fromAimiru && r.status === 401) return { ok: false, refused: true, status: 401, code: r.code ?? null };
    if (fromAimiru && r.status === 429) {
      const wait = Number.isFinite(r.retryAfterMs) ? Math.max(POLL_EVERY_MS, r.retryAfterMs) : POLL_EVERY_MS;
      watch.noteTried(now(), now() + wait);
      return { ok: false, status: 429, retryAfterMs: wait };
    }
    return { ok: false, status: r.status ?? 0 };
  }
  if (typeof r.data?.paused !== 'boolean') return { ok: false, status: r.status };
  const paused = r.data.paused === true;
  watch.noteRead(paused, now());
  if (paused) {
    const changed = before ? null : 'paused';
    if (changed) notePauseLearned(client, watch, { learnedBy, local, now: now() });
    const ack = await ackOnce(client, watch, { learnedBy, local, timeoutMs });
    if (ack.resumed) return { ok: true, paused: false, changed: before ? 'resumed' : null, ack };
    return { ok: true, paused: true, changed, ack };
  }
  if (before) {
    noteResumed(watch, { local });
    return { ok: true, paused: false, changed: 'resumed' };
  }
  return { ok: true, paused: false, changed: null };
}

/**
 * The watcher's loop: while the lease and the budget last, one read of the Pause every 3 s for the
 * whole folder (whichever process holds the poll lock reads; the others use its answer). onChange
 * hears each pause and resume; onTick runs about once a second and may end the loop ({stop: true}).
 * Ends early on a 401 (the key stopped working), and when the data folder is gone.
 * Returns {ended: 'budget'|'lease'|'refused'|'tick'|'stopped'|'gone'}.
 */
export async function watchLoop(client, watch, { budgetMs, everyMs = POLL_EVERY_MS, tickMs = 1_000, local = null, onChange = null, onTick = null, stop = () => false } = {}) {
  const end = Date.now() + Math.max(0, Number(budgetMs) || 0);
  while (Date.now() < end) {
    if (stop()) return { ended: 'stopped' };
    if (!watch.alive()) return { ended: 'gone' };
    if (Date.now() >= watch.leaseUntil()) return { ended: 'lease' };
    if (watch.pollDue(everyMs) && watch.takePollLock()) {
      let res;
      try {
        res = await pollOnce(client, watch, { local, timeoutMs: Math.max(250, Math.min(3_000, end - Date.now())) });
      } finally {
        watch.releasePollLock();
      }
      if (res.refused) return { ended: 'refused', code: res.code ?? null };
      if (res.changed && onChange) await onChange(res);
    }
    if (onTick) {
      const t = await onTick();
      if (t?.stop) return { ended: 'tick', ...t };
    }
    await sleep(Math.max(0, Math.min(tickMs, end - Date.now())));
  }
  return { ended: 'budget' };
}

/**
 * Holds a step while this agent is paused (ADR-0142): neither refused nor let through, with no model
 * turn spent. It confirms the pause as 'held' when nothing here has yet, and learns how the pause
 * stands from the folder's reads alone, at most one every 3 s (its own, or another process's). It
 * ends:
 *   'resumed'  a read since the hold began answered 200 with paused false: the step goes through
 *              its normal check;
 *   'ceiling'  ceilingMs after it began (55 minutes; the check's own limit is 3600 s);
 *   'refused'  the key stopped working (401): the step is refused, as the 401's rule says; or the
 *              data folder was removed by hand (code 'gone'): refused, and the folder is not made again;
 *   'stopped'  stop() said so (the caller's own end).
 * Aimiru out of reach changes nothing: the hold goes on, and never turns into a yes.
 * Returns {ended, heldMs, code?}.
 */
export async function holdWhilePaused(client, watch, { ceilingMs = HOLD_CEILING_MS, everyMs = POLL_EVERY_MS, tickMs = 1_000, local = null, timeoutMs = 3_000, stop = () => false } = {}) {
  const started = Date.now();
  watch.trace({ event: 'held' });
  const end = (ended, extra = {}) => {
    const heldMs = Date.now() - started;
    // A folder removed by hand gets nothing written into it (writing would make it again).
    if (extra.code !== 'gone') watch.trace({ event: 'hold_ended', how: ended, held_ms: heldMs });
    return { ended, heldMs, ...extra };
  };
  // Learned at this step (a 423, or a memory no process confirmed yet): confirm it as held.
  const first = await ackOnce(client, watch, { learnedBy: 'held', local, timeoutMs });
  if (first.resumed) return end('resumed');
  if (first.refused) return end('refused', { code: first.code ?? null });
  for (;;) {
    // A read since the hold began, by any process of this folder, that said the pause ended.
    const seen = watch.lastRead();
    if (seen && seen.paused === false && Number(seen.at) >= started) {
      client.forgetPause();
      return end('resumed');
    }
    if (Date.now() - started >= ceilingMs) return end('ceiling');
    if (stop()) return end('stopped');
    if (typeof watch.alive === 'function' && !watch.alive()) return end('refused', { code: 'gone' });
    if (watch.pollDue(everyMs) && watch.takePollLock()) {
      let res;
      try {
        res = await pollOnce(client, watch, { local, learnedBy: 'held', timeoutMs: Math.max(250, Math.min(timeoutMs, ceilingMs - (Date.now() - started))) });
      } finally {
        watch.releasePollLock();
      }
      if (res.refused) return end('refused', { code: res.code ?? null });
      if (res.ok && res.paused === false) return end('resumed');
    }
    await sleep(Math.max(0, Math.min(tickMs, ceilingMs - (Date.now() - started))));
  }
}
