// Reads decided on this computer (ADR-0095 for the server's part; contract §3 of wave 9).
//
// Most of an agent's calls are reads of its own project, and each checked call costs about a second
// from India. So Aimiru tells the connector, in GET /v1/me's `local` snapshot, which reads the
// person's rules allow without condition right now: at most (read, nothing named) and (read, a change
// inside the project). The connector decides those here, from the snapshot, writes each one to a
// local spool before answering, and sends the records in batches to POST /v1/checks/local, where
// Aimiru checks every one again against the rules as they are then and records it in the same chain.
// Anything else, and anything that fails closed, still goes to Aimiru first, as before.
//
// Only Aimiru for Claude Code and Aimiru's check for Codex carry this file (scripts/sync-shared.mjs):
// only those two kinds of agent get a snapshot.
//
// Vendored by scripts/sync-shared.mjs. Edit it only in connectors/shared/.

import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { READ_ONLY_BUILTINS, splitMcpToolName } from './classify.mjs';
import { createSpool, readReach, setting, sha256Hex, sleep } from './sayso-client.mjs';

/**
 * The only (class, resource) pairs that can ever be decided on this computer. The same list is in
 * packages/core/src/local-decisions.ts; a test on each side pins it.
 */
export const LOCAL_CANDIDATES = Object.freeze([Object.freeze({ class: 'read', resource: null }), Object.freeze({ class: 'read', resource: 'code.local' })]);

/** The connectors that decide reads here (the agent kinds GET /v1/me gives a snapshot to). */
export const LOCAL_CONNECTORS = Object.freeze(['claude-code', 'codex']);

/** The snapshot file and the spool folder, inside the connector's data folder. */
export const LOCAL_FILE = 'local.json';
export const LOCAL_SPOOL_DIR = 'local';

/** The schedule when a snapshot does not say: refresh every 5 minutes, send records after 30 s or 50. */
export const LOCAL_DEFAULTS = Object.freeze({ refresh_s: 300, flush_s: 30, batch_max: 50 });

/** A reach stored with the snapshot sizes a wait only while it is younger than this (ADR-0094). */
export const REACH_FRESH_MS = 3_600_000;

/** The longest a snapshot may be used, whatever it says. */
const MAX_TTL_S = 360;
/** A lock older than this belongs to a process that died. */
const LOCK_STALE_MS = 60_000;
/** One batch stays under the server's 64 KB body limit. */
const BATCH_BYTES = 56 * 1024;
/** A batch names at most this many snapshots. */
const MAX_SNAPSHOTS = 5;

/** Claude Code's own tools whose reads may be decided here: never a tool server's, never an unknown one. */
const CLAUDE_CODE_TOOLS = new Set([
  'Bash', 'PowerShell', 'Monitor', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'WebSearch', 'Agent', 'Task', 'Workflow',
  ...READ_ONLY_BUILTINS,
]);
/** Codex's own shell and file changes. */
const CODEX_TOOLS = new Set(['Bash', 'apply_patch']);

/** False when the person turned reads decided here off: AIMIRU_LOCAL_READS=0 (or SAYSO_LOCAL_READS=0). */
export function localReadsOn(env = process.env) {
  return String(setting(env, 'LOCAL_READS') ?? '').trim() !== '0';
}

/** True for a built-in tool of this connector whose reads may be decided here. */
export function isLocalTool(connector, toolName, toolInput = null) {
  const name = typeof toolName === 'string' ? toolName : '';
  // A tool server's tool (Aimiru's own included) always goes to Aimiru.
  if (!name || splitMcpToolName(name) || name.startsWith('mcp__')) return false;
  if (connector === 'claude-code') {
    if (name === 'Monitor') return typeof toolInput?.command === 'string';
    return CLAUDE_CODE_TOOLS.has(name);
  }
  if (connector === 'codex') return CODEX_TOOLS.has(name);
  return false;
}

/**
 * A snapshot as this computer reads it, or null when it is not one: {v: 1, version, issued_at,
 * ttl_s (at most 360), paused, allow: [{class, resource}], seal, refresh_s, flush_s, batch_max}.
 * The snapshot itself is kept and sent exactly as Aimiru gave it (its seal covers it).
 */
export function readSnapshot(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || raw.v !== 1) return null;
  if (typeof raw.version !== 'string' || typeof raw.issued_at !== 'string' || !Number.isFinite(Date.parse(raw.issued_at))) return null;
  const ttl = Number(raw.ttl_s);
  if (!Number.isFinite(ttl) || ttl < 0 || typeof raw.paused !== 'boolean' || !Array.isArray(raw.allow)) return null;
  const allow = [];
  for (const a of raw.allow) {
    if (!a || typeof a !== 'object' || typeof a.class !== 'string') return null;
    if (a.resource !== null && a.resource !== undefined && typeof a.resource !== 'string') return null;
    allow.push({ class: a.class, resource: a.resource ?? null });
  }
  const num = (v, fallback, lo, hi) => {
    const n = Number(v);
    return Number.isFinite(n) && n >= lo && n <= hi ? n : fallback;
  };
  return {
    v: 1,
    version: raw.version,
    issued_at: raw.issued_at,
    ttl_s: Math.min(MAX_TTL_S, ttl),
    paused: raw.paused,
    allow,
    seal: typeof raw.seal === 'string' ? raw.seal : null,
    refresh_s: num(raw.refresh_s, LOCAL_DEFAULTS.refresh_s, 30, 3_600),
    flush_s: num(raw.flush_s, LOCAL_DEFAULTS.flush_s, 1, 600),
    batch_max: Math.floor(num(raw.batch_max, LOCAL_DEFAULTS.batch_max, 1, 50)),
  };
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

function writeJsonAtomic(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(obj), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

/** Takes a lock file (exclusive create); a lock older than LOCK_STALE_MS is taken over. */
function takeLock(file, content) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fs.writeFileSync(file, content, { flag: 'wx', mode: 0o600 });
    return true;
  } catch {
    try {
      if (Date.now() - fs.statSync(file).mtimeMs > LOCK_STALE_MS) {
        fs.rmSync(file, { force: true });
        fs.writeFileSync(file, content, { flag: 'wx', mode: 0o600 });
        return true;
      }
    } catch {
      // another process won the race
    }
    return false;
  }
}

function dropLock(file) {
  try {
    fs.rmSync(file, { force: true });
  } catch {
    // ignore
  }
}

/**
 * This computer's local state for one connector: the snapshot file (local.json, signed with the
 * agent key and kept for the Aimiru address it came from), the local spool, and the locks that make
 * refreshes and the record waiter one at a time.
 * @param {{dataDir: string, token: string, baseUrl: string|null}} opts
 */
export function createLocalState({ dataDir, token = '', baseUrl = null } = {}) {
  const file = path.join(dataDir, LOCAL_FILE);
  const spoolDir = path.join(dataDir, LOCAL_SPOOL_DIR);
  const spool = createSpool(spoolDir);
  const refreshLock = path.join(dataDir, 'local-refresh.lock');
  const triedFile = path.join(dataDir, 'local-tried.json');
  const waiterLock = path.join(spoolDir, 'waiter.lock');
  const key = typeof token === 'string' ? token.trim() : '';
  const base = typeof baseUrl === 'string' ? baseUrl : null;

  const macOf = (body) => createHmac('sha256', `sayso-local:${key}`).update(JSON.stringify(body)).digest('hex');

  /**
   * The stored snapshot when its file verifies and was made for this key and this Aimiru, else null:
   * {snapshot (as Aimiru gave it), view (readSnapshot), reach, received_ms, base_url}.
   */
  function read() {
    if (!key) return null;
    const v = readJson(file);
    if (!v || typeof v !== 'object') return null;
    const body = { snapshot: v.snapshot ?? null, reach: v.reach ?? null, received_ms: v.received_ms, base_url: v.base_url };
    if (!macEqual(v.mac, macOf(body))) return null;
    if (!Number.isFinite(body.received_ms) || body.base_url !== base) return null;
    const view = readSnapshot(body.snapshot);
    return { ...body, view };
  }

  /** Keeps a snapshot (and the reach that came with it) as received now. */
  function write(snapshot, reach, receivedMs = Date.now()) {
    if (!key) return false;
    const body = { snapshot: snapshot ?? null, reach: reach ?? null, received_ms: Math.floor(receivedMs), base_url: base };
    try {
      writeJsonAtomic(file, { ...body, mac: macOf(body) });
      return true;
    } catch {
      return false;
    }
  }

  function remove() {
    try {
      fs.rmSync(file, { force: true });
    } catch {
      // ignore
    }
  }

  /** The reach stored with the snapshot, only while it was received within the last hour (ADR-0094). */
  function storedReach(now = Date.now()) {
    const f = read();
    if (!f || !f.reach) return null;
    const age = now - f.received_ms;
    return age >= 0 && age < REACH_FRESH_MS ? readReach(f.reach) : null;
  }

  /** The schedule from the stored snapshot, else the defaults. */
  function schedule() {
    const f = read();
    const s = f?.view;
    return s ? { refresh_s: s.refresh_s, flush_s: s.flush_s, batch_max: s.batch_max } : { ...LOCAL_DEFAULTS };
  }

  /** True when a refresh is due: none tried within refresh_s (each try is noted, answered or not). */
  function refreshDue(now = Date.now()) {
    const t = readJson(triedFile);
    const at = Number(t?.at);
    if (!Number.isFinite(at) || now < at - 60_000) return true;
    return now - at >= schedule().refresh_s * 1000;
  }

  function noteTried(now = Date.now()) {
    try {
      writeJsonAtomic(triedFile, { at: now });
    } catch {
      // ignore
    }
  }

  /** Asks for a refresh at the next chance (a record Aimiru did not agree with, ADR-0095). */
  function requestRefresh() {
    try {
      fs.rmSync(triedFile, { force: true });
    } catch {
      // ignore
    }
  }

  /** Writes one decided read ahead of the answer (write-ahead). False when it could not be written. */
  function append(record, snapshot) {
    try {
      spool.append({ kind: 'local', record, snapshot });
      return true;
    } catch {
      return false;
    }
  }

  return {
    file,
    spool,
    read,
    write,
    remove,
    storedReach,
    schedule,
    refreshDue,
    noteTried,
    requestRefresh,
    append,
    lockRefresh: () => takeLock(refreshLock, String(process.pid)),
    unlockRefresh: () => dropLock(refreshLock),
    /**
     * The record waiter's lock, one per data folder: 'mine', or 'covered' when another waiter will
     * send everything waiting at or after flushAt, or 'busy' when another is sending right now.
     */
    takeWaiter(flushAt) {
      if (takeLock(waiterLock, JSON.stringify({ pid: process.pid, flush_at: flushAt }))) return 'mine';
      // Everything already in the spool goes when that waiter sends, so a record written before it
      // starts sending is covered by it.
      const held = readJson(waiterLock);
      const at = Number(held?.flush_at);
      return Number.isFinite(at) && at > Date.now() + 300 ? 'covered' : 'busy';
    },
    releaseWaiter: () => dropLock(waiterLock),
    /** True while a waiter holds the lock and has not started sending: what waits now goes with it. */
    waiterCovers(now = Date.now()) {
      const held = readJson(waiterLock);
      const at = Number(held?.flush_at);
      try {
        if (Date.now() - fs.statSync(waiterLock).mtimeMs > LOCK_STALE_MS) return false;
      } catch {
        return false;
      }
      return Number.isFinite(at) && at > now + 300;
    },
  };
}

/**
 * Whether this call is decided here (contract §3.2). Local only when every line holds; otherwise
 * the call goes to Aimiru as before:
 *   1. reads decided here are on, and the connector is Claude Code or Codex;
 *   2. the tool is one of the agent's own built-in tools (never a tool server's, never Aimiru's own);
 *   3. the class is read;
 *   4. it names nothing, or a change inside the project (code.local);
 *   5. no counterparty, amount, currency or cart; not sensitive; no program the agent wrote; no step
 *      that names its own resource (a mixed command, ADR-0096);
 *   6. no question waits for this same call;
 *   7. Aimiru has not said this agent is paused (the pause memory is empty);
 *   8. a snapshot is stored, verifies, was made for this key and this Aimiru, is not paused, is
 *      younger than its ttl_s by this computer's own elapsed time, and allows exactly this pair.
 * (9., writing the record before answering, is the caller's: append() must succeed.)
 * @returns {{local: true, file: object, ageMs: number} | {local: false, why: string}}
 */
export function localDecision(action, { env = process.env, connector, toolName, toolInput = null, pending = false, paused = false, file = null, now = Date.now() } = {}) {
  const no = (why) => ({ local: false, why });
  if (!localReadsOn(env)) return no('off');
  if (!LOCAL_CONNECTORS.includes(connector)) return no('connector');
  if (!isLocalTool(connector, toolName, toolInput)) return no('tool');
  if (!action || typeof action !== 'object' || action.class !== 'read') return no('class');
  const resource = action.resource ?? null;
  if (!LOCAL_CANDIDATES.some((c) => c.resource === resource)) return no('resource');
  if (action.counterparty || action.amount != null || action.currency || action.checkout) return no('money');
  if (action.sensitive === true) return no('sensitive');
  if (Array.isArray(action.programs) && action.programs.length) return no('programs');
  if (Array.isArray(action.neverParts) && action.neverParts.length) return no('parts');
  if (pending) return no('pending');
  if (paused) return no('paused');
  const s = file?.view;
  if (!s) return no('snapshot');
  if (s.paused) return no('snapshot_paused');
  const age = now - file.received_ms;
  if (!(age >= 0 && age < s.ttl_s * 1000)) return no('snapshot_age');
  if (!s.allow.some((a) => a.class === 'read' && a.resource === resource)) return no('not_allowed');
  return { local: true, file, ageMs: Math.floor(age) };
}

/** The call's context in a local record: the same fields a check sends, without empty ones. */
function recordContext(context) {
  const out = {};
  for (const k of ['tool_name', 'session_id', 'tool_use_id']) {
    const v = context?.[k];
    if (v !== null && v !== undefined && v !== '') out[k] = String(v).slice(0, 200);
  }
  if (typeof context?.native_prompt === 'boolean') out.native_prompt = context.native_prompt;
  if (context?.native_prompt_estimated === true) out.native_prompt_estimated = true;
  return out;
}

/**
 * One read decided here, as the connector sends it (contract §1.1 "Local record"): age_ms is this
 * computer's own elapsed time since it received the snapshot (it decides whether a sealed snapshot
 * covered it, so a wrong clock never matters); `at` is this computer's clock, for display.
 */
export function localRecord({ action, context = {}, project = null, file, now = Date.now() }) {
  const evidence = typeof action?.evidence === 'string' && action.evidence ? action.evidence : null;
  return {
    local_id: randomUUID(),
    at: new Date(now).toISOString(),
    age_ms: Math.max(0, Math.floor(now - file.received_ms)),
    action: {
      class: 'read',
      resource: action.resource ?? null,
      description: String(action.description ?? '').slice(0, 280),
      ...(evidence ? { evidence_sha256: sha256Hex(evidence) } : {}),
    },
    context: recordContext(context),
    project: project && typeof project === 'object' && project.label ? { label: project.label, hash: project.hash ?? null } : null,
    snapshot: file.view.issued_at,
  };
}

/**
 * Reads GET /v1/me and keeps its snapshot and reach (contract §3.3), one process at a time: a
 * caller that finds the lock held skips. `local: null` (or no snapshot), 401 and 403 delete the
 * file, so nothing more is decided here. Returns {ok, me?, skipped?}.
 */
export async function refreshLocal(client, state, { timeoutMs = 3_000 } = {}) {
  if (!state.lockRefresh()) return { ok: false, skipped: true };
  try {
    state.noteTried();
    const r = await client.me({ timeoutMs });
    if (r.ok) {
      const d = r.data && typeof r.data === 'object' ? r.data : {};
      if (readSnapshot(d.local)) state.write(d.local, readReach(d.reach), Date.now());
      else state.remove();
      return { ok: true, me: d };
    }
    if (r.kind === 'http' && r.fromSayso !== false && (r.status === 401 || r.status === 403)) state.remove();
    return { ok: false, status: r.status ?? 0 };
  } finally {
    state.unlockRefresh();
  }
}

/** How many entries from the front of a batch fit in one request: ≤ 56 KB and ≤ 5 snapshots. */
function fitting(entries) {
  let bytes = 64;
  const snaps = new Set();
  for (let i = 0; i < entries.length; i += 1) {
    const e = entries[i];
    const name = e?.snapshot?.issued_at ?? null;
    const adds = name !== null && !snaps.has(name);
    if (adds && snaps.size >= MAX_SNAPSHOTS) return Math.max(1, i);
    bytes += JSON.stringify(e?.record ?? null).length + (adds ? JSON.stringify(e.snapshot).length : 0) + 2;
    if (bytes > BATCH_BYTES) return Math.max(1, i);
    if (adds) snaps.add(name);
  }
  return entries.length;
}

/**
 * Sends the reads decided here to POST /v1/checks/local, at most batch_max a request, when the
 * oldest has waited flush_s or batch_max wait (or `force`). Per record: recorded and replayed leave
 * the spool, invalid and conflict are dropped, anything else stays. 429, 5xx and no answer keep the
 * batch; a 429 also deletes the snapshot (the day's cap, or the minute's rate). A batch answer that
 * says paused writes the pause memory; any re-check other than agree deletes the snapshot and asks
 * for a refresh, so the next call goes to Aimiru.
 */
export async function flushLocal(client, state, { budgetMs = 5_000, force = false, now = Date.now() } = {}) {
  const oldest = state.spool.oldestMs();
  if (oldest === null) return { sent: 0, dropped: 0, kept: 0, skipped: false, idle: true };
  const sched = state.schedule();
  if (!force && now - oldest < sched.flush_s * 1000 && state.spool.size() < sched.batch_max) {
    return { sent: 0, dropped: 0, kept: state.spool.size(), skipped: false, notDue: true };
  }
  let paused = false;
  let forget = false;
  const started = Date.now();
  const result = await state.spool.flushBatches(
    async (batch) => {
      const usable = batch.map((e) => e && e.kind === 'local' && e.record && typeof e.record.local_id === 'string' && e.snapshot && typeof e.snapshot === 'object');
      const records = batch.filter((_, i) => usable[i]).map((e) => e.record);
      if (!records.length) return batch.map(() => 'drop');
      const snapshots = [];
      const named = new Set();
      for (const e of batch.filter((_, i) => usable[i])) {
        const id = e.snapshot.issued_at;
        if (!named.has(id)) {
          named.add(id);
          snapshots.push(e.snapshot);
        }
      }
      const r = await client.postLocalChecks({ records, snapshots }, { timeoutMs: Math.max(500, Math.min(10_000, budgetMs - (Date.now() - started))) });
      if (r.ok) {
        const d = r.data && typeof r.data === 'object' ? r.data : {};
        if (d.paused === true) paused = true;
        const byId = new Map((Array.isArray(d.results) ? d.results : []).filter((x) => x && typeof x.local_id === 'string').map((x) => [x.local_id, x]));
        return batch.map((e, i) => {
          if (!usable[i]) return 'drop';
          const x = byId.get(e.record.local_id);
          if (!x) return 'retry';
          if (x.status === 'recorded' || x.status === 'replayed') {
            if (typeof x.recheck === 'string' && x.recheck !== 'agree') forget = true;
            return 'done';
          }
          if (x.status === 'invalid' || x.status === 'conflict') return 'drop';
          return 'retry';
        });
      }
      const fromAimiru = r.kind === 'http' && r.fromSayso !== false;
      if (fromAimiru && r.status === 429) {
        forget = true;
        return batch.map(() => 'retry');
      }
      if (fromAimiru && r.status === 403) {
        // This agent is not one Aimiru takes these from: they will never be taken, and nothing more is decided here.
        forget = true;
        return batch.map(() => 'drop');
      }
      if (fromAimiru && r.status === 401) {
        forget = true;
        return batch.map(() => 'retry');
      }
      if (fromAimiru && (r.status === 400 || r.status === 413)) return batch.map(() => 'drop');
      return batch.map(() => 'retry');
    },
    { budgetMs, batchMax: sched.batch_max, cut: fitting },
  );
  if (paused) client.rememberPause?.(null);
  if (forget || paused) {
    state.remove();
    state.requestRefresh();
  }
  return { ...result, paused, forgot: forget };
}

/**
 * The record waiter (contract §3.3): after a read is decided here, waits until the oldest record
 * waiting is flush_s old, then sends. One waiter per data folder: a caller whose records another
 * waiter will send leaves at once. Bounded by budgetMs (the hook's own time).
 */
export async function waitThenFlush(client, state, { budgetMs = 40_000 } = {}) {
  const end = Date.now() + budgetMs;
  while (Date.now() < end - 1_000) {
    const oldest = state.spool.oldestMs();
    if (oldest === null) return { flushed: false, idle: true };
    const due = oldest + state.schedule().flush_s * 1000;
    if (due > end - 1_500) return { flushed: false, late: true };
    const lock = state.takeWaiter(due);
    if (lock === 'covered') return { flushed: false, covered: true };
    if (lock === 'busy') {
      await sleep(200);
      continue;
    }
    try {
      await sleep(Math.max(0, due - Date.now()));
      const res = await flushLocal(client, state, { budgetMs: Math.max(1_000, Math.min(8_000, end - Date.now() - 250)), force: true });
      return { flushed: true, ...res };
    } finally {
      state.releaseWaiter();
    }
  }
  return { flushed: false, late: true };
}
