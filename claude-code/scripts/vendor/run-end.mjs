// GENERATED COPY of connectors/shared/run-end.mjs. Do not edit here: edit shared/ and run `node scripts/sync-shared.mjs`.
// How a run of the person's job ended, as the runner tells Aimiru (connectors 0.3.0-rc.7; goal 8, step 2;
// docs/specs/2026-11-27-step2-job-between-agents.md section 5): a typed stop and the files the run changed.
//
// A typed stop, `{why, resets_at?}`, closed set (STOP_WHYS):
//   stopped  the person stopped it: their tap in Aimiru (the job read closed while it ran) or the runner
//            stopped on the computer (Ctrl+C, `runner off`). Set by the runner, never read from the agent.
//   stuck    the runner ended it: nothing from the agent for QUIET_MS with no step of its own open, or
//            still working at the take path's own time limit.
//   limit    the maker's own typed signals together, never the words alone (the makers' dated pages,
//            docs/strategy/2026-11-27-makers-phone-handoff-limits.md, 3.1 to 3.8 and 3.14 to 3.21):
//            Claude Code: a rate_limit_event with status "rejected", then a result with is_error true and
//            api_error_status 429, and a non-zero exit, and its resetsAt in the future (the cross-check:
//            false limit messages are on record, #84690, #86272); resets_at is that time.
//            Codex: an error event, then turn.failed with no step between them (an error alone is not the
//            end: Codex retries after one, #60993), each within LIMIT_GAP_MS of the next and of the exit,
//            exit code 1, and both carrying Codex's own usage-limit sentence (protocol/error.rs). Codex's
//            exec gives no reset field and its time has no zone, so no resets_at.
//   ended    anything else that did not finish: an error, no result at all (#103820), a failed start.
// A run that finished has no stop. A run Claude Code or Codex ended on its own with refused steps
// finished as far as the runner can tell; its result says what was refused (the write spike, c1).
//
// Changed files: what the run changed in the person's project, from git, as project paths and added and
// removed line counts only, never a file's words. The working tree is snapshotted at the take and at the
// end as tree objects through a throwaway index (a copy of the project's own, so its stat cache is used):
// nothing is committed and the person's own index is never touched; the blobs git writes are ordinary
// loose objects its own housekeeping prunes. Tree to tree, so an agent is credited only with what changed
// while it ran, never with another agent's uncommitted files, and a file it added counts though git does
// not track it yet (the write spike, step 7). Files git ignores are never counted.
//
// Git runs outside every agent's sandbox, as the person, so each call is kept from starting a program the
// project could name: no snapshot when the project's git settings name a filter, a file watcher or any hook
// (gitStartsPrograms, read again before each snapshot, since a job could add one; the Opus gate on rc.7
// found `add` and `write-tree` into the throwaway index fire post-index-change), and for each call
// core.hooksPath pointed at /dev/null (no hooks folder, in .git or in the tree, runs), the config hook for
// post-index-change off, core.fsmonitor and the untracked cache off,
// no external diff or text conversion, an environment of its own (no GIT_* of the runner's), and a time
// limit. Any doubt or failure means no changed files, never a guess.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { redactContacts } from './contacts.mjs';
import { redactSecrets, truncate } from './aimiru-client.mjs';

/** Why a run stopped, as Aimiru keeps it (CONTRACT.md, POST /v1/receipts stopped.why). */
export const STOP_WHYS = Object.freeze(['ended', 'stuck', 'stopped', 'limit']);
/** Nothing from the agent this long, with no step of its own open: the runner ends the run as stuck. */
export const QUIET_MS = 10 * 60_000;
/** How often the quiet timer looks. */
export const QUIET_EVERY_MS = 30_000;
/** Codex's limit: its error, turn.failed and the exit, each at most this far from the next. */
export const LIMIT_GAP_MS = 10_000;
/** A reset further away than this is not believed (Claude Code's windows are five hours and seven days). */
export const RESET_MAX_MS = 31 * 24 * 60 * 60_000;
/** At most this many changed files go to Aimiru; the rest are counted in `more`. */
export const CHANGED_MAX = 50;
/** A changed file's path, at most this long once cleaned. */
export const PATH_MAX = 300;
/** Each git call, at most this long. */
export const GIT_TIMEOUT_MS = 15_000;

// ---------------------------------------------------------------------------
// Claude Code (`claude -p --output-format stream-json --verbose`)
// ---------------------------------------------------------------------------

/**
 * What the runner keeps of a Claude Code run's events to read its end: the last rejected rate limit
 * (cleared by a later one that allows) and the result. see(ev) for each stream-json event.
 */
export function createClaudeEnd() {
  let rejected = null;
  let result = null;
  return {
    see(ev) {
      if (!ev || typeof ev !== 'object') return;
      if (ev.type === 'rate_limit_event') {
        const info = ev.rate_limit_info && typeof ev.rate_limit_info === 'object' ? ev.rate_limit_info : null;
        if (info?.status === 'rejected') rejected = info;
        else if (info && (info.status === 'allowed' || info.status === 'allowed_warning')) rejected = null;
      } else if (ev.type === 'result') result = ev;
    },
    get result() {
      return result;
    },
    /**
     * The typed stop, or null when the run finished. exit: {code, signal, error}; stopped: the runner's own
     * stop; stuck: the runner's quiet timer or its time limit.
     */
    stopOf({ exit = {}, stopped = false, stuck = false, now = Date.now() } = {}) {
      return claudeStopOf({ rejected, result, exit, stopped, stuck, now });
    },
  };
}

/** The typed stop of a Claude Code run, from what createClaudeEnd kept (pure). */
export function claudeStopOf({ rejected = null, result = null, exit = {}, stopped = false, stuck = false, now = Date.now() } = {}) {
  if (stopped) return { why: 'stopped' };
  if (stuck) return { why: 'stuck' };
  const code = exit?.code ?? null;
  if (!exit?.error && code === 0 && result && result.is_error !== true) return null;
  const nonZero = !exit?.error && exit?.signal == null && Number.isInteger(code) && code !== 0;
  if (rejected && result && result.is_error === true && result.api_error_status === 429 && nonZero) {
    const reset = resetOf(rejected.resetsAt, now);
    if (reset) return { why: 'limit', resets_at: reset };
  }
  return { why: 'ended' };
}

/** A reset in epoch seconds, as an ISO time, only when it is in the future and not absurdly far. */
function resetOf(epochS, now) {
  const s = typeof epochS === 'number' ? epochS : typeof epochS === 'string' && /^\d+$/.test(epochS) ? Number(epochS) : NaN;
  if (!Number.isFinite(s)) return null;
  const ms = s * 1000;
  if (ms <= now || ms - now > RESET_MAX_MS) return null;
  return new Date(ms).toISOString();
}

// ---------------------------------------------------------------------------
// Codex (`codex exec --json`)
// ---------------------------------------------------------------------------

/**
 * Codex's own usage-limit sentences (codex-rs protocol/error.rs, read 27 Nov 2026): "You've hit your usage
 * limit..." in each plan's form (the apostrophe is U+2019), and "Your workspace is out of credits", also
 * after a stream's "stream disconnected before completion:" (#62416). Read only beside the typed sequence.
 */
const CODEX_LIMIT_RE = /^(?:stream disconnected before completion:\s*)?(?:You[’']ve hit your usage limit\b|Your workspace is out of credits\b)/;

/** True for one of Codex's usage-limit sentences. */
export function isCodexLimitSentence(text) {
  return CODEX_LIMIT_RE.test(String(text ?? '').trim());
}

/**
 * What the runner keeps of a Codex run's JSONL events to read its end: the last error and whether the
 * turn went on after it, the failed turn, and a completed one. see(ev, at) for each event, at its time.
 */
export function createCodexEnd() {
  let error = null;
  let failed = null;
  let completed = false;
  return {
    see(ev, at = Date.now()) {
      if (!ev || typeof ev !== 'object') return;
      if (ev.type === 'error') error = { message: String(ev.message ?? ''), at, wentOn: false };
      else if (ev.type === 'turn.failed') failed = { message: String(ev.error?.message ?? ''), at, afterError: error !== null && !error.wentOn, gap: error ? at - error.at : null };
      else if (ev.type === 'turn.completed') completed = true;
      else if (typeof ev.type === 'string' && ev.type.startsWith('item.') && error && !failed) error.wentOn = true;
    },
    get failure() {
      return failed?.message || error?.message || null;
    },
    get completed() {
      return completed;
    },
    /** A turn.failed was seen. */
    get failedTurn() {
      return failed !== null;
    },
    /** The typed stop, or null when the run finished. exitAt: when the process ended. */
    stopOf({ exit = {}, stopped = false, stuck = false, exitAt = Date.now() } = {}) {
      return codexStopOf({ error, failed, exit, stopped, stuck, exitAt });
    },
  };
}

/** The typed stop of a Codex run, from what createCodexEnd kept (pure). */
export function codexStopOf({ error = null, failed = null, exit = {}, stopped = false, stuck = false, exitAt = Date.now() } = {}) {
  if (stopped) return { why: 'stopped' };
  if (stuck) return { why: 'stuck' };
  if (!exit?.error && exit?.code === 0 && !failed && !error) return null;
  const limit =
    error &&
    failed &&
    failed.afterError === true &&
    Number.isFinite(failed.gap) &&
    failed.gap >= 0 &&
    failed.gap <= LIMIT_GAP_MS &&
    exitAt - failed.at >= 0 &&
    exitAt - failed.at <= LIMIT_GAP_MS &&
    !exit?.error &&
    exit?.signal == null &&
    exit?.code === 1 &&
    isCodexLimitSentence(error.message) &&
    isCodexLimitSentence(failed.message);
  return limit ? { why: 'limit' } : { why: 'ended' };
}

// ---------------------------------------------------------------------------
// The quiet timer
// ---------------------------------------------------------------------------

/**
 * Ends a run that went quiet: onQuiet() once, when nothing came from the agent for quietMs and no step it
 * started is still open (a test suite that runs for minutes prints nothing until it ends, and is not
 * stuck). touch() for any event; opened(id) and closed(id) for a step's start and end.
 */
export function createQuiet({ onQuiet, quietMs = QUIET_MS, everyMs = Math.min(QUIET_EVERY_MS, quietMs), now = Date.now, setTimer = setInterval, clearTimer = clearInterval } = {}) {
  let last = now();
  let fired = false;
  const open = new Set();
  const timer = setTimer(() => {
    if (fired || open.size > 0 || now() - last < quietMs) return;
    fired = true;
    try {
      onQuiet?.();
    } catch {
      // the run is ended by the take path either way
    }
  }, everyMs);
  timer?.unref?.();
  return {
    touch() {
      last = now();
    },
    opened(id) {
      if (id !== undefined && id !== null) open.add(String(id));
      last = now();
    },
    closed(id) {
      if (id !== undefined && id !== null) open.delete(String(id));
      last = now();
    },
    stop() {
      clearTimer(timer);
    },
    get fired() {
      return fired;
    },
  };
}

/** The steps a Claude Code event opens and closes: tool_use ids in an assistant event, tool_result ids in a user one. */
export function claudeStepIds(ev) {
  const content = Array.isArray(ev?.message?.content) ? ev.message.content : [];
  if (ev?.type === 'assistant') return { opened: content.filter((c) => c?.type === 'tool_use' && c.id).map((c) => c.id), closed: [] };
  if (ev?.type === 'user') return { opened: [], closed: content.filter((c) => c?.type === 'tool_result' && c.tool_use_id).map((c) => c.tool_use_id) };
  return { opened: [], closed: [] };
}

/** The step a Codex event opens or closes: item.started and item.completed by the item's id. */
export function codexStepIds(ev) {
  const id = ev?.item?.id;
  if (!id) return { opened: [], closed: [] };
  if (ev.type === 'item.started') return { opened: [id], closed: [] };
  if (ev.type === 'item.completed') return { opened: [], closed: [id] };
  return { opened: [], closed: [] };
}

// ---------------------------------------------------------------------------
// Changed files, from git
// ---------------------------------------------------------------------------

/** Only what git needs from the runner's environment: where programs and home are, and the language. */
function gitEnv(env, extra = {}) {
  const out = {};
  for (const [k, v] of Object.entries(env || {})) {
    if (v === undefined || v === null || String(v) === '') continue;
    if (['PATH', 'HOME', 'LANG', 'TMPDIR', 'USER', 'LOGNAME'].includes(k) || /^LC_[A-Z_]+$/.test(k)) out[k] = String(v);
  }
  if (!out.PATH) out.PATH = '/usr/bin:/bin:/usr/sbin:/sbin';
  return { ...out, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', ...extra };
}

/** The settings each git call starts with: no hooks from any folder, no config hook, no file watcher, no untracked cache. */
const GIT_SAFE = ['-c', 'core.hooksPath=/dev/null', '-c', 'hook.post-index-change.enabled=false', '-c', 'core.fsmonitor=false', '-c', 'core.untrackedCache=false'];

/** One git call: {ok, out} (out as text, or a Buffer with raw), never throwing. */
function git(args, { cwd, env, extra, raw = false, run = spawnSync, timeoutMs = GIT_TIMEOUT_MS } = {}) {
  try {
    const r = run('git', [...GIT_SAFE, ...args], { cwd, env: gitEnv(env, extra), timeout: timeoutMs, encoding: raw ? 'buffer' : 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 16 * 1024 * 1024 });
    if (r.error || r.status !== 0) return { ok: false, out: raw ? Buffer.alloc(0) : '' };
    return { ok: true, out: r.stdout ?? (raw ? Buffer.alloc(0) : '') };
  } catch {
    return { ok: false, out: raw ? Buffer.alloc(0) : '' };
  }
}

/**
 * True when the project's own git settings would have git start a program while it reads the working
 * tree: a filter (clean, smudge or process), a file watcher or any hook set in its settings (hook.<name>.*,
 * through include.path too), in any of its settings files, or when they cannot be read. Then nothing is
 * snapshotted.
 */
export function gitStartsPrograms(dir, { env = process.env, run = spawnSync } = {}) {
  let r;
  try {
    // Without GIT_SAFE: what the project's own settings say about a file watcher is the question.
    r = run('git', ['config', '--null', '--get-regexp', '^(filter\\..+\\.(clean|smudge|process)|core\\.fsmonitor|hook\\..+)$'], { cwd: dir, env: gitEnv(env), timeout: GIT_TIMEOUT_MS, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    return true;
  }
  if (!r || r.error) return true;
  // git config exits 1 when nothing matches: the one answer that means none.
  if (r.status === 1) return false;
  if (r.status !== 0) return true;
  // name\nvalue\0 per entry: a file watcher set to false is no watcher.
  return String(r.stdout ?? '')
    .split('\0')
    .filter(Boolean)
    .some((entry) => {
      const [name, value = ''] = entry.split('\n');
      return !(name.toLowerCase() === 'core.fsmonitor' && /^(false|no|off|0)$/i.test(value.trim()));
    });
}

/**
 * The working tree of the git project holding dir, as a tree object: {root, tree}, or null (not in git, a
 * filter or file watcher in its settings, git missing or slow, any failure). Nothing is committed and the
 * project's own index is never written: the snapshot goes through a copy of it in a folder of its own.
 */
export function snapshotTree(dir, { env = process.env, run = spawnSync, tmpRoot = os.tmpdir() } = {}) {
  const top = git(['rev-parse', '--show-toplevel'], { cwd: dir, env, run });
  const root = top.ok ? String(top.out).trim() : '';
  if (!root || !path.isAbsolute(root)) return null;
  if (gitStartsPrograms(root, { env, run })) return null;
  const at = git(['rev-parse', '--git-path', 'index'], { cwd: root, env, run });
  const indexPath = at.ok ? path.resolve(root, String(at.out).trim()) : null;
  let tmp = null;
  try {
    tmp = fs.mkdtempSync(path.join(tmpRoot, 'aimiru-snapshot-'));
    const index = path.join(tmp, 'index');
    if (indexPath && fs.existsSync(indexPath)) fs.copyFileSync(indexPath, index);
    const extra = { GIT_INDEX_FILE: index };
    if (!git(['add', '--all', '--', '.'], { cwd: root, env, extra, run }).ok) return null;
    const tree = git(['write-tree'], { cwd: root, env, extra, run });
    const sha = tree.ok ? String(tree.out).trim() : '';
    return /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(sha) ? { root, tree: sha } : null;
  } catch {
    return null;
  } finally {
    if (tmp) {
      try {
        fs.rmSync(tmp, { recursive: true, force: true });
      } catch {
        // the system's temporary folder clears it
      }
    }
  }
}

/** A changed file's path as Aimiru may keep it: one line, keys and contacts out, at most PATH_MAX. */
export function cleanPath(p) {
  const one = String(p ?? '')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029\p{Cf}]+/gu, ' ')
    .trim();
  return truncate(redactContacts(redactSecrets(one)), PATH_MAX);
}

/**
 * The files that changed between two snapshots of one project: {files: [{path, added, removed}], more},
 * paths from the project's top folder, counts null for a file git calls binary, at most CHANGED_MAX files
 * (more: how many were left out). Null when either snapshot is missing or git cannot say.
 */
export function changedBetween(before, after, { env = process.env, run = spawnSync } = {}) {
  if (!before?.tree || !after?.tree || before.root !== after.root) return null;
  if (before.tree === after.tree) return { files: [], more: 0 };
  const r = git(['diff', '--numstat', '-z', '--no-renames', '--no-ext-diff', '--no-textconv', before.tree, after.tree], { cwd: after.root, env, run, raw: true });
  if (!r.ok) return null;
  const files = [];
  let total = 0;
  for (const rec of r.out.toString('utf8').split('\0')) {
    const m = /^(-|\d+)\t(-|\d+)\t([\s\S]+)$/.exec(rec);
    if (!m) continue;
    total += 1;
    if (files.length >= CHANGED_MAX) continue;
    const pathText = cleanPath(m[3]);
    if (!pathText) continue;
    files.push({ path: pathText, added: m[1] === '-' ? null : Number(m[1]), removed: m[2] === '-' ? null : Number(m[2]) });
  }
  return { files, more: Math.max(0, total - files.length) };
}

/**
 * The run's changes, measured from a snapshot taken at the take: start() before the agent starts, end()
 * once it has ended, which resolves to changedBetween's answer (or null).
 */
export function createChanges(dir, o = {}) {
  let before = null;
  return {
    start() {
      before = snapshotTree(dir, o);
      return before;
    },
    end() {
      if (!before) return null;
      return changedBetween(before, snapshotTree(dir, o), o);
    },
  };
}
