// Aimiru Agent API client for connectors (wire contract v1, workers/agent-api/CONTRACT.md).
//
// Zero dependencies: Node 18+ built-ins only (fetch, AbortSignal.timeout, node:crypto, node:fs).
// Vendored into each connector by scripts/sync-shared.mjs. Edit it only in
// connectors/shared/ and run `node scripts/sync-shared.mjs`.
//
// What it gives a connector:
//   - check / approvalsWait / record / heartbeat / me / pause, with timeouts and a request id
//   - decide(): check plus the contract's fail-closed rule, as one answer: allow | ask | deny
//   - waitForApproval(): long-polls an exception within a time budget
//   - a durable JSONL spool for records, flushed with retry
//   - a pause memory: once Aimiru says this agent is paused (or everything is), every step is
//     refused until Aimiru answers that it is not, even while Aimiru cannot be reached (ADR-0022)
//   - redactSecrets(): strips obvious secrets before any text leaves the machine

import { createHash, createHmac, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DEFAULT_CONNECT, MESSAGES, undoLineFor } from './messages.mjs';

export const CONTRACT_VERSION = 'v1';

/** The prefix a connector's settings carry in the environment: AIMIRU_<name>. */
export const SETTING_PREFIXES = Object.freeze(['AIMIRU_']);

/**
 * A setting from the environment by its name without the prefix (BASE_URL, AGENT_TOKEN, ...):
 * AIMIRU_<name> when it is set and not blank. Undefined when it is not set.
 */
export function setting(env, name) {
  for (const prefix of SETTING_PREFIXES) {
    const v = env?.[`${prefix}${name}`];
    if (v !== undefined && v !== null && String(v).trim() !== '') return String(v);
  }
  return undefined;
}

/** The environment variable a setting is read from: AIMIRU_<name>. */
export function settingName(env, name) {
  for (const prefix of SETTING_PREFIXES) {
    const v = env?.[`${prefix}${name}`];
    if (v !== undefined && v !== null && String(v).trim() !== '') return `${prefix}${name}`;
  }
  return `${SETTING_PREFIXES[0]}${name}`;
}

/** Classes that are denied when Aimiru cannot answer (spec D12, CONTRACT.md "Fail closed"). */
export const FAIL_CLOSED_CLASSES = Object.freeze(['spend', 'send', 'share', 'book', 'delete', 'login']);
/** Every class the contract knows. */
export const ACTION_CLASSES = Object.freeze([...FAIL_CLOSED_CLASSES, 'write', 'read', 'other']);

/**
 * The one offline rule (CONTRACT.md, "Fail closed"): true when a step must be refused if Aimiru
 * cannot answer. The six classes above, and every step the connector marks sensitive whatever its
 * class: a program the agent wrote that the maker's own sandbox does not hold (code.new_program), a
 * host known only when the step runs, inline code that reaches the network, a change to the maker's
 * settings or Aimiru's own files, and anything the connector cannot read. The classifier marks them
 * (classify.mjs); every connector decides offline with this function and nothing else.
 * An unknown or missing class is treated as fail-closed (the conservative reading, spec §0.1.5).
 */
export function isFailClosed(cls, { sensitive = false } = {}) {
  if (sensitive) return true;
  if (!ACTION_CLASSES.includes(cls)) return true;
  return FAIL_CLOSED_CLASSES.includes(cls);
}

/**
 * Where a connector was installed from, sent with each heartbeat (`install_source`; the first
 * heartbeat is the install Aimiru counts, ADR-0041). One of INSTALL_SOURCES.
 */
export const INSTALL_SOURCES = Object.freeze([
  'marketplace',
  'clawhub',
  'npm',
  'pypi',
  'hermes-catalog',
  'pair',
  'unknown',
]);

/**
 * Works out the install source on this computer, never over the network:
 *   1. AIMIRU_INSTALL_SOURCE, when it names one of INSTALL_SOURCES (an installer, or pairing,
 *      sets it; anything else is ignored);
 *   2. `hint`, what the host says about the install (OpenClaw's own install record);
 *   3. the connector's own folder: inside ~/.claude/plugins (the Claude Code plugin
 *      marketplace), a ClawHub folder, node_modules or the npx cache (npm);
 *   4. otherwise unknown (a copy of the folder, a local link, a test).
 * Nothing about the path is sent, only the one word.
 */
export function installSource({ env = process.env, modulePath = '', hint = null } = {}) {
  const pick = (v) => {
    const s = typeof v === 'string' ? v.trim().toLowerCase() : '';
    return INSTALL_SOURCES.includes(s) && s !== 'unknown' ? s : null;
  };
  const fromEnv = pick(setting(env, 'INSTALL_SOURCE'));
  if (fromEnv) return fromEnv;
  const fromHost = pick(hint);
  if (fromHost) return fromHost;
  let where = typeof modulePath === 'string' ? modulePath : '';
  if (where.startsWith('file:')) {
    try {
      where = decodeURIComponent(new URL(where).pathname);
    } catch {
      where = '';
    }
  }
  where = where.replace(/\\/g, '/').toLowerCase();
  if (where.includes('/.claude/plugins/')) return 'marketplace';
  if (/\/(\.?clawhub)\//.test(where)) return 'clawhub';
  if (where.includes('/node_modules/') || where.includes('/_npx/')) return 'npm';
  return 'unknown';
}

export const DEFAULT_TIMEOUTS = Object.freeze({
  checkMs: 10_000, // CONTRACT.md: connectors use 10 s for check
  requestMs: 10_000,
  longPollSlackMs: 5_000, // extra time on top of ?wait=N for the response to arrive
  maxRetryAfterMs: 2_000, // a 429 with a longer retry-after is not waited on inside check
});

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

/** Normalises the Aimiru base URL: no trailing slash, no trailing /v1. Throws on a bad or non-https URL. */
export function normaliseBaseUrl(raw) {
  if (!raw || typeof raw !== 'string') throw new Error('missing');
  let u;
  try {
    u = new URL(raw.trim());
  } catch {
    throw new Error('not a URL');
  }
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && LOOPBACK_HOSTS.has(u.hostname))) {
    // The key must never travel over plain http to another machine.
    throw new Error('must use https');
  }
  u.hash = '';
  u.search = '';
  let p = u.pathname.replace(/\/+$/, '');
  if (p.endsWith('/v1')) p = p.slice(0, -3);
  u.pathname = p || '/';
  return u.toString().replace(/\/+$/, '');
}

/**
 * True when an error response is Aimiru's own answer: JSON with error.code, or a decision or explain
 * (CONTRACT.md "Errors"; the paused body has both). Anything else came from something between this
 * computer and Aimiru (a firewall, a login wall, the host's edge refusing the request, seen live as an
 * HTML page with Cloudflare error 1010): Aimiru never saw the request, so it is not Aimiru's answer.
 */
export function isAimiruAnswer(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return false;
  return (typeof data.error?.code === 'string' && data.error.code !== '') || typeof data.decision === 'string' || typeof data.explain === 'string';
}

/**
 * How long one approvals long-poll may ask Aimiru to wait, given the time left. Room is kept for the
 * answer to travel back: a poll still in flight when the time runs out is cut off and its answer
 * lost (seen live: a "still waiting" answer took over a second to arrive from a fresh process).
 */
export function longPollSeconds(remainingMs) {
  const slackMs = remainingMs >= 6_000 ? 3_000 : 1_000;
  return Math.max(0, Math.min(25, Math.floor((remainingMs - slackMs) / 1_000)));
}

// ---------------------------------------------------------------------------
// How long an ask waits for the person (ADR-0094)
// ---------------------------------------------------------------------------

/** The wait when the person has a phone with Aimiru's alerts on: 5 minutes. */
export const PHONE_WAIT_MS = 300_000;
/** The wait otherwise, and for a session whose last 5 minute wait went unanswered: 35 seconds. */
export const SHORT_WAIT_MS = 35_000;

/**
 * The person's reach as Aimiru reports it (an ask answer's `reach`, or GET /v1/me's): {push_ready,
 * quiet_until, last_answer_at}, each null when absent or malformed. Null when there is none at all
 * (an Aimiru from before this field), which sizes the wait as no phone.
 */
export function readReach(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const iso = (v) => (typeof v === 'string' && Number.isFinite(Date.parse(v)) ? v : null);
  return { push_ready: raw.push_ready === true, quiet_until: iso(raw.quiet_until), last_answer_at: iso(raw.last_answer_at) };
}

/**
 * How long a connector waits for the person's answer to an ask, in ms (ADR-0094):
 *   1. inside the person's quiet hours (`quietUntil`, the ask's person_quiet_until, else
 *      reach.quiet_until, still ahead): 0. Aimiru will not alert them, so nobody answers soon;
 *   2. else AIMIRU_ASK_BUDGET_MS when the person set it (overrideMs), else 35 s for a session whose
 *      last 5 minute wait went unanswered (shortWait), else 5 minutes when a phone has alerts on
 *      (reach.push_ready), else 35 s;
 *   3. never more than capMs, the time the connector's host leaves it.
 */
export function askWaitMs({ reach = null, quietUntil = null, capMs = Infinity, overrideMs = null, shortWait = false, now = Date.now() } = {}) {
  const quiet = Date.parse(quietUntil ?? reach?.quiet_until ?? '');
  if (Number.isFinite(quiet) && quiet > now) return 0;
  const override = Number(overrideMs);
  let base = SHORT_WAIT_MS;
  if (overrideMs != null && Number.isFinite(override) && override > 0) base = override;
  else if (!shortWait && reach?.push_ready === true) base = PHONE_WAIT_MS;
  const cap = Number(capMs);
  return Math.max(0, Math.floor(Math.min(base, Number.isFinite(cap) ? cap : base)));
}

/** The quiet hours an ask answer names (person_quiet_until, else reach.quiet_until) while still ahead, else null. */
export function quietUntilOf(d, now = Date.now()) {
  const raw = d?.quietUntil ?? d?.reach?.quiet_until ?? null;
  const t = Date.parse(raw ?? '');
  return Number.isFinite(t) && t > now ? raw : null;
}

/** Whole seconds for `waiting_s` (GET /v1/approvals/{id}): 0 to 600. */
export function waitingSecondsOf(ms) {
  const s = Math.ceil(Math.max(0, Number(ms) || 0) / 1000);
  return Math.min(600, s);
}

// ---------------------------------------------------------------------------
// Ask and move on (ADR-0145): Aimiru for Claude Code and Codex's check, from 0.3.0
// ---------------------------------------------------------------------------

/**
 * The most an ask holds a step, in ms (ADR-0145; Rohit's choice of 28 Oct, R4 option b). A yes in
 * those seconds lets the step go ahead at once. After them the step is refused for now: the agent
 * carries on with its other work and tries the same step again later, and the person's yes, whenever
 * it comes before the question ends, lets that exact step through then.
 */
export const ASK_HOLD_MS = 4_000;

/**
 * How long Aimiru for Claude Code and Codex's check hold a step on an ask, in ms (ADR-0145):
 *   1. inside the person's quiet hours (`quietUntil`, else reach.quiet_until, still ahead): 0, since
 *      Aimiru alerts nobody before they end;
 *   2. else ASK_HOLD_MS, whatever the reach: a phone with alerts on no longer lengthens it;
 *   3. AIMIRU_ASK_BUDGET_MS (overrideMs) only ever shortens it, and capMs, the time the check has
 *      left, bounds it.
 * The go-between and OpenClaw keep askWaitMs, which waits for the person.
 */
export function askHoldMs({ reach = null, quietUntil = null, capMs = Infinity, overrideMs = null, now = Date.now() } = {}) {
  const quiet = Date.parse(quietUntil ?? reach?.quiet_until ?? '');
  if (Number.isFinite(quiet) && quiet > now) return 0;
  let ms = ASK_HOLD_MS;
  const override = Number(overrideMs);
  if (overrideMs != null && Number.isFinite(override) && override > 0) ms = Math.min(ms, override);
  const cap = Number(capMs);
  if (Number.isFinite(cap)) ms = Math.min(ms, cap);
  return Math.max(0, Math.floor(ms));
}

/** One line per ask, and per later yes that let the step through (ADR-0145): asks-trace.jsonl. */
export const ASKS_TRACE_FILE = 'asks-trace.jsonl';
/** Every pause this connector learned of, its acknowledgement, holds and their ends (ADR-0142). */
export const PAUSE_TRACE_FILE = 'pause-trace.jsonl';

/**
 * Appends one JSON line to a trace in the connector's own data folder (asks-trace.jsonl,
 * pause-trace.jsonl), readable only by the person: ids, times and outcomes, never a key, a step's
 * input or Aimiru's words. Kept to about maxBytes: past it, the older half goes. Never throws, and a
 * trace that cannot be written changes no answer.
 */
export function appendTrace(dir, file, entry, { maxBytes = 256 * 1024, now = Date.now() } = {}) {
  if (!dir || !file) return false;
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const f = path.join(dir, file);
    fs.appendFileSync(f, `${JSON.stringify({ at: new Date(now).toISOString(), ...entry })}\n`, { mode: 0o600 });
    if (fs.statSync(f).size > maxBytes) {
      const lines = fs.readFileSync(f, 'utf8').split('\n').filter(Boolean);
      const tmp = `${f}.${process.pid}.${Date.now()}.tmp`;
      fs.writeFileSync(tmp, `${lines.slice(Math.floor(lines.length / 2)).join('\n')}\n`, { mode: 0o600 });
      fs.renameSync(tmp, f);
    }
    return true;
  } catch {
    return false;
  }
}

/** The lines of a trace, oldest first (a torn line is skipped). */
export function readTrace(dir, file) {
  try {
    return fs
      .readFileSync(path.join(dir, file), 'utf8')
      .split('\n')
      .filter(Boolean)
      .flatMap((l) => {
        try {
          return [JSON.parse(l)];
        } catch {
          return [];
        }
      });
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Evidence (ADR-0094): a keyed MAC of the whole input, ahead of the 1,000 character cut
// ---------------------------------------------------------------------------

/** JSON with every object's keys sorted, so the same input always gives the same text. */
export function canonicalJson(value, depth = 0) {
  if (depth > 64) return 'null';
  if (value === null || typeof value !== 'object') {
    const s = JSON.stringify(value);
    return s === undefined ? 'null' : s;
  }
  if (Array.isArray(value)) return `[${value.map((v) => canonicalJson(v === undefined ? null : v, depth + 1)).join(',')}]`;
  const keys = Object.keys(value).filter((k) => value[k] !== undefined && typeof value[k] !== 'function').sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k], depth + 1)}`).join(',')}}`;
}

/**
 * HMAC-SHA256 of a tool call's whole input (canonical JSON, before any redaction or cut), keyed by
 * the agent key: two calls that differ anywhere, even after the evidence is cut at 1,000
 * characters, never share an evidence hash, and nobody without the key can tell what the input
 * was from it. Null without a key.
 */
export function inputMac(key, input) {
  const k = typeof key === 'string' ? key.trim() : '';
  if (!k) return null;
  return createHmac('sha256', k).update(canonicalJson(input ?? null), 'utf8').digest('hex');
}

/**
 * The evidence text a check sends (ADR-0094): {tool, input_mac, programs?, sandbox?, input} in that
 * order, redacted, cut at 1,000 characters. `input_mac` sits ahead of the input, so the cut never
 * removes it; the programs' fingerprints too (ADR-0090).
 */
export function evidenceText(tool, input, { key = null, programs = null, sandbox = undefined } = {}) {
  const mac = inputMac(key, input);
  const value = { tool, ...(mac ? { input_mac: mac } : {}), ...(programs ? { programs, sandbox: sandbox === true } : {}), input: input ?? null };
  return truncate(redactSecrets(JSON.stringify(redactDeep(value))), 1000);
}

/**
 * The input a command's evidence carries: the command and Claude Code's sandbox switch only, the
 * fields that decide what runs. The model's own description and timeout change between tries, so
 * leaving them out lets a retry of the same command match (ADR-0035, ADR-0094).
 */
export function shellEvidenceInput(ti) {
  const t = ti && typeof ti === 'object' ? ti : {};
  return {
    command: Array.isArray(t.command) ? t.command.map(String) : typeof t.command === 'string' ? t.command : String(t.command ?? ''),
    ...(t.dangerouslyDisableSandbox !== undefined ? { dangerouslyDisableSandbox: t.dangerouslyDisableSandbox } : {}),
  };
}

// ---------------------------------------------------------------------------
// A Never inside a mixed command (Decision 9, ADR-0096)
// ---------------------------------------------------------------------------

/** The check body's `parts`: at most 3 {class, resource, text}, each well formed, else none. */
export function wireParts(parts) {
  if (!Array.isArray(parts)) return [];
  const out = [];
  for (const p of parts) {
    if (!p || typeof p !== 'object' || !ACTION_CLASSES.includes(p.class)) continue;
    const resource = typeof p.resource === 'string' && p.resource ? p.resource.slice(0, 200) : null;
    const text = truncate(redactSecrets(String(p.text ?? '').replace(/\s+/g, ' ').trim()), 120);
    if (!resource || !text) continue;
    out.push({ class: p.class, resource, text });
    if (out.length === 3) break;
  }
  return out;
}

/** Waits ms milliseconds. */
export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}

export function sha256Hex(text) {
  return createHash('sha256').update(String(text ?? ''), 'utf8').digest('hex');
}

/** Cuts text to max characters; marks a cut with "..." (docs/04 allows it only for truncation). */
export function truncate(text, max = 280) {
  const s = String(text ?? '');
  if (s.length <= max) return s;
  return `${s.slice(0, Math.max(0, max - 3))}...`;
}

/** A run id for check (ADR-0042): trimmed, 1 to 200 characters, no control characters; else null. */
export function runIdOf(raw) {
  if (typeof raw !== 'string' && typeof raw !== 'number') return null;
  const id = String(raw).trim();
  if (id === '' || id.length > 200 || /[\u0000-\u001f\u007f]/.test(id)) return null;
  return id;
}

/** What the run is called (a project folder, a task), redacted and cut to 60; null when empty. */
export function runLabelOf(raw) {
  if (typeof raw !== 'string') return null;
  const s = redactSecrets(raw).replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
  return s === '' ? null : s.slice(0, 60);
}

/**
 * True only for a job the person started in Aimiru, whole (ADR-0157): Aimiru marks it from_person,
 * names no agent it came from, and it is part of no other task. Aimiru gives such a job as its own
 * lead step (ADR-0124: step.lead, asked by the person, the step being this very task), or with no
 * step at all; any other step (one an agent asked for, or a later step of a job) is not the
 * person's own job. A connector gives an agent nothing else unless the person turned work handed
 * between agents on (defence in depth beside Aimiru's own filter for agents on the computer).
 */
export function personsOwnJob(task) {
  if (!task || typeof task !== 'object' || task.from_person !== true) return false;
  if (task.from_agent !== null && task.from_agent !== undefined) return false;
  for (const k of ['parent_task_id', 'parent_id']) if (task[k] !== null && task[k] !== undefined) return false;
  const id = taskIdOf(task.id);
  if (id === null) return false;
  const step = task.step;
  if (step === null || step === undefined) return true;
  return typeof step === 'object' && step.lead === true && step.asked_by?.person === true && taskIdOf(step.step_id) === id;
}

/** A task id as Aimiru gives it (a UUID), trimmed; null for anything else (ADR-0157). */
export function taskIdOf(raw) {
  if (typeof raw !== 'string') return null;
  const id = raw.trim();
  return /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(id) ? id : null;
}

// ---------------------------------------------------------------------------
// The person's brief (ADR-0151, ADR-0157; contract C2)
// ---------------------------------------------------------------------------

/**
 * The longest brief text a connector passes on: a longer one is treated as no brief, never cut (the
 * text goes on byte for byte). Aimiru renders at most 20 lines of at most 120 characters, about 6,150
 * characters at the very most (each line learned from every agent Aimiru names), so a longer text is
 * not one Aimiru sent. It also fits Claude Code's 10,000 characters for one hook's context
 * (code.claude.com/docs/en/hooks; beyond it Claude gets a file path and a preview, not the text):
 * the usual paragraph and the longest brief stay under it together, and Claude Code's session start
 * leaves the brief out whole when a job or a late yes would push its context over (quality review).
 */
export const BRIEF_MAX_CHARS = 8_000;

/** A brief's version as a connector keeps it and sends it back in If-None-Match. */
const BRIEF_VERSION_RE = /^[A-Za-z0-9:._-]{1,128}$/;

/**
 * What a GET /v1/brief answer means for a connector: {state, text, version, count}, where state is
 *   given   200 with text: the agent gets `text` exactly as Aimiru wrote it;
 *   empty   200 with text "": nothing to give (the version still says which brief that is);
 *   same    304: the version sent in If-None-Match still holds;
 *   closed  403 or 404 from Aimiru (a door not open to this agent, or an Aimiru from before the
 *           brief): not asked again in this session;
 *   none    anything else (423 while paused, an error, a time limit, a malformed answer).
 * Only `given` puts anything in front of the agent. `lines` and `withheld` never do.
 */
export function briefOf(r) {
  const none = (state = 'none') => ({ state, text: '', version: null, count: 0 });
  if (!r || typeof r !== 'object') return none();
  if (r.ok === true && r.status === 200) {
    const b = r.data?.brief;
    if (!b || typeof b !== 'object' || Array.isArray(b) || typeof b.text !== 'string' || b.text.length > BRIEF_MAX_CHARS) return none();
    if (typeof b.version !== 'string' || !BRIEF_VERSION_RE.test(b.version)) return none();
    const count = Number.isInteger(b.count) && b.count >= 0 ? b.count : Array.isArray(b.lines) ? b.lines.length : 0;
    if (b.text === '') return { state: 'empty', text: '', version: b.version, count: 0 };
    return { state: 'given', text: b.text, version: b.version, count };
  }
  if (r.ok === false && r.kind === 'http' && r.status === 304) return none('same');
  if (r.ok === false && r.kind === 'http' && (r.status === 403 || r.status === 404) && r.fromAimiru !== false) return none('closed');
  return none();
}

// ---------------------------------------------------------------------------
// Projects (ADR-0056)
// ---------------------------------------------------------------------------

/**
 * A project's label as Aimiru keeps it (the same as normaliseProjectLabel in Aimiru's own code): accents
 * dropped, lower case, spaces as "-", only a to z, 0 to 9, ".", "_" and "-", no separator at
 * either end, at most 60. Null when nothing is left.
 */
export function projectLabelOf(raw) {
  if (typeof raw !== 'string') return null;
  let s = redactSecrets(raw)
    .replace(/\[redacted\]/g, ' ')
    .normalize('NFKC')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9._-]+/g, '')
    .replace(/-{2,}/g, '-')
    .replace(/^[-._]+|[-._]+$/g, '');
  if (s.length > 60) s = s.slice(0, 60).replace(/[-._]+$/g, '');
  return s === '' ? null : s;
}

/**
 * The project this agent works in (ADR-0056), for check and record: {label, hash}. The label is
 * what the person reads and names in rules ("Never deploy in project client-a"): AIMIRU_PROJECT
 * when the person set it, else the folder's name. The hash is sha256 of the folder's full path,
 * worked out here: the path itself never leaves this computer, and Aimiru keeps the hash to itself.
 * Null without a folder or a label, and for the home folder or the disk's root.
 */
export function projectOf(dir, { env = process.env } = {}) {
  if (typeof dir !== 'string' || dir.trim() === '') return null;
  let full;
  try {
    full = path.resolve(dir.trim());
  } catch {
    return null;
  }
  // The home folder or the disk's root is where an app starts when it names no project: no project.
  if (full === path.parse(full).root || full === path.resolve(os.homedir())) return null;
  const label = projectLabelOf(setting(env, 'PROJECT') ?? '') ?? projectLabelOf(path.basename(full));
  if (!label) return null;
  return { label, hash: sha256Hex(full) };
}

/** A project as check and record send it: {label, hash} with a usable label, else null. */
function wireProject(project) {
  if (!project || typeof project !== 'object') return null;
  const label = projectLabelOf(project.label);
  if (!label) return null;
  const hash = typeof project.hash === 'string' && /^[0-9a-f]{64}$/.test(project.hash) ? project.hash : null;
  return { label, hash };
}

// ---------------------------------------------------------------------------
// Secret redaction
// ---------------------------------------------------------------------------

const R = '[redacted]';
const SECRET_NAME =
  '(?:[A-Za-z0-9_.-]*(?:password|passwd|passphrase|pwd|secret|token|api[_-]?key|apikey|access[_-]?key|private[_-]?key|client[_-]?secret|auth[_-]?key|credential|session[_-]?id|cookie|signature)[A-Za-z0-9_.-]*)';

// Order matters: specific shapes first, then generic name=value shapes.
const REDACTIONS = [
  // PEM private keys (multi-line)
  [/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|$)/g, `-----BEGIN PRIVATE KEY----- ${R} -----END PRIVATE KEY-----`],
  // Authorization headers and bearer/basic credentials
  [/\b(authorization\s*[:=]\s*["']?\s*)(bearer|basic|token|digest)\s+[^\s"',;]+/gi, `$1$2 ${R}`],
  [/\b(bearer)\s+[A-Za-z0-9._~+/=-]{8,}/gi, `$1 ${R}`],
  // Aimiru's own keys: a word, _agt_ or _key_, then the key, whatever word a release gives them
  // (devrel review of wk/connectors-flow: a copy installed now never updates, so it hides every
  // prefix a key has had or may have, ADR-0164).
  [/\b[a-z][a-z0-9]{1,15}_(?:agt|key)_[A-Za-z0-9_-]{6,}/g, R],
  // Vendor key shapes
  [/\bsk-ant-[A-Za-z0-9_-]{10,}/g, R],
  [/\bsk-(?:proj-|live-|test-)?[A-Za-z0-9_-]{16,}/g, R],
  [/\b(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{8,}/g, R],
  [/\bwhsec_[A-Za-z0-9]{16,}/g, R],
  [/\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}/g, R],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}/g, R],
  [/\bglpat-[A-Za-z0-9_-]{16,}/g, R],
  [/\bxox[abprsoe]-[A-Za-z0-9-]{10,}/g, R],
  [/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, R],
  [/\bAIza[0-9A-Za-z_-]{30,}/g, R],
  [/\bya29\.[0-9A-Za-z_-]{20,}/g, R],
  [/\bnpm_[A-Za-z0-9]{30,}/g, R],
  [/\bSG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}/g, R],
  [/\bAC[a-f0-9]{32}:[a-f0-9]{32}\b/g, R],
  [/\b(?:hf|gsk|figd|dop_v1|shpat|shpss|shpca|lin_api|ntn)_[A-Za-z0-9_-]{20,}/g, R],
  [/\b(?:xai|pplx)-[A-Za-z0-9_-]{20,}/g, R],
  // Secrets that live inside an address: chat bot keys, Slack and Discord incoming-message addresses
  [/\b(bot)?\d{6,12}:[A-Za-z0-9_-]{30,}/g, `$1${R}`],
  [/(hooks\.slack\.com\/(?:services|workflows|triggers)\/)[^\s"'`?#)]+/gi, `$1${R}`],
  [/(discord(?:app)?\.com\/api\/(?:v\d+\/)?webhooks\/\d+\/)[A-Za-z0-9_.-]+/gi, `$1${R}`],
  [/([?&](?:key|sig|code)=)[^&\s"'#]{8,}/gi, `$1${R}`],
  // mysql -pPASSWORD (the password is glued to the flag)
  [/\b((?:mysql|mysqldump|mysqladmin|mariadb|mariadb-dump)\b[^\n;&|]*?\s-p)(?=[^\s-])("[^"]*"|'[^']*'|[^\s"']+)/g, `$1${R}`],
  // Card numbers: 13 to 19 digits that pass the Luhn check, spaces or dashes allowed between them
  // (checkout asks Aimiru, ADR-0065: a card never leaves this computer, not even hashed).
  [/\b\d(?:[ -]?\d){12,18}\b/g, (m) => (holdsCard(m) ? R : m)],
  // JSON web tokens
  [/\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, R],
  // user:password@host in URLs
  [/\b([a-z][a-z0-9+.-]*:\/\/[^\s:/@]+):[^\s@/]+@/gi, `$1:${R}@`],
  // curl -u user:pass / --user user:pass
  [/(\s(?:-u|--user)\s+["']?[^\s:"']+):[^\s"']+/g, `$1:${R}`],
  // --password value / --token=value style flags
  [new RegExp(`(--?${SECRET_NAME}(?:=|\\s+))("[^"]*"|'[^']*'|[^\\s"']+)`, 'gi'), `$1${R}`],
  // "secret_name": "value" (JSON)
  [new RegExp(`("${SECRET_NAME}"\\s*:\\s*)"(?:[^"\\\\]|\\\\.)*"`, 'gi'), `$1"${R}"`],
  // secret_name=value / secret_name: value (env, headers, query strings, YAML)
  [new RegExp(`(\\b${SECRET_NAME}\\s*[:=]\\s*)("[^"]*"|'[^']*'|[^\\s&"',;]+)`, 'gi'), `$1${R}`],
  // header form "X-Api-Key: value" inside quotes
  [/(\bx-[a-z0-9-]*(?:key|token|secret|auth)[a-z0-9-]*\s*:\s*)[^\s"',;]+/gi, `$1${R}`],
];

/**
 * True when a run of digits holds a card number: the whole run, or (when the run has spaces or
 * dashes) any stretch of its groups, so a card followed by its expiry or code ("4242 4242 4242 4242
 * 06/29") or preceded by another number is still found. The whole run is removed.
 */
function holdsCard(run) {
  if (luhnValid(run.replace(/[ -]/g, ''))) return true;
  const groups = run.split(/[ -]/);
  for (let i = 0; i < groups.length; i += 1) {
    let digits = '';
    for (let j = i; j < groups.length; j += 1) {
      digits += groups[j];
      if (digits.length > 19) break;
      if (digits.length >= 13 && (i > 0 || j < groups.length - 1) && luhnValid(digits)) return true;
    }
  }
  return false;
}

/** True for 13 to 19 digits that pass the Luhn check (a card number). */
function luhnValid(digits) {
  if (!/^\d{13,19}$/.test(digits)) return false;
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i -= 1) {
    let d = digits.charCodeAt(i) - 48;
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return sum % 10 === 0;
}

/** Replaces obvious secrets in text with "[redacted]". Never throws. */
export function redactSecrets(text) {
  if (text == null) return text;
  let s = String(text);
  for (const [re, replacement] of REDACTIONS) s = s.replace(re, replacement);
  // Collapse accidental double redactions such as "[redacted][redacted]".
  return s.replace(/(\[redacted\])(?:\s*\[redacted\])+/g, '$1');
}

const SECRET_KEY_RE = new RegExp(`^${SECRET_NAME}$`, 'i');

/** Deep-redacts strings inside a JSON-like value; keys that name secrets have their values replaced. */
export function redactDeep(value, depth = 0) {
  if (depth > 8) return '[cut]';
  if (typeof value === 'string') return redactSecrets(value);
  if (Array.isArray(value)) return value.map((v) => redactDeep(v, depth + 1));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = SECRET_KEY_RE.test(k) && v != null && typeof v !== 'object' ? R : redactDeep(v, depth + 1);
    }
    return out;
  }
  return value;
}

// ---------------------------------------------------------------------------
// Spool: a durable JSONL queue of requests to replay (records, mostly)
// ---------------------------------------------------------------------------

const SPOOL_FILE = 'spool.jsonl';
const LOCK_FILE = 'spool.lock';
const INFLIGHT_DIR = 'inflight';
const FLUSHING_RE = /^spool\.flushing-.*\.jsonl$/;
const STALE_LOCK_MS = 60_000;
/** An in-flight record older than this belongs to a process that was killed before it finished. */
const STALE_INFLIGHT_MS = 60_000;

export function createSpool(dir, { maxEntries = 5_000, maxAgeMs = 30 * 24 * 3600_000, staleInflightMs = STALE_INFLIGHT_MS } = {}) {
  const file = path.join(dir, SPOOL_FILE);
  const lockFile = path.join(dir, LOCK_FILE);
  const inflightDir = path.join(dir, INFLIGHT_DIR);

  function ensureDir() {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }

  function makeLine(entry) {
    return JSON.stringify({ id: randomUUID(), ts: new Date().toISOString(), attempts: 0, ...entry });
  }

  function append(entry) {
    ensureDir();
    fs.appendFileSync(file, `${makeLine(entry)}\n`, { mode: 0o600 });
  }

  /**
   * Write-ahead for one request: the entry is on disk before the request starts, so a process that is
   * killed mid-request (Claude Code kills background work when a `-p` run ends) does not lose it.
   * end(ticket) removes it once the request is done or the entry has been spooled.
   */
  function begin(entry) {
    try {
      fs.mkdirSync(inflightDir, { recursive: true, mode: 0o700 });
      const ticket = path.join(inflightDir, `${randomUUID()}.json`);
      fs.writeFileSync(ticket, makeLine(entry), { mode: 0o600 });
      return ticket;
    } catch {
      return null;
    }
  }

  function end(ticket) {
    if (!ticket) return;
    try {
      fs.rmSync(ticket, { force: true });
    } catch {
      // ignore
    }
  }

  function listDir(d) {
    try {
      return fs.readdirSync(d);
    } catch {
      return [];
    }
  }

  /** Leftovers of killed processes: flush working files and stale in-flight entries. */
  function orphans(now = Date.now()) {
    const flushing = listDir(dir).filter((n) => FLUSHING_RE.test(n)).map((n) => path.join(dir, n));
    const inflight = listDir(inflightDir)
      .filter((n) => n.endsWith('.json'))
      .map((n) => path.join(inflightDir, n))
      .filter((f) => {
        try {
          return now - fs.statSync(f).mtimeMs > staleInflightMs;
        } catch {
          return false;
        }
      });
    return { flushing, inflight };
  }

  /** Moves orphaned entries back into the spool. Call only while holding the lock. */
  function adoptOrphans() {
    const { flushing, inflight } = orphans();
    for (const f of flushing) {
      const lines = readLines(f);
      if (lines.length) fs.appendFileSync(file, lines.map((e) => JSON.stringify(e)).join('\n') + '\n', { mode: 0o600 });
      fs.rmSync(f, { force: true });
    }
    for (const f of inflight) {
      const lines = readLines(f);
      if (lines.length) fs.appendFileSync(file, lines.map((e) => JSON.stringify(e)).join('\n') + '\n', { mode: 0o600 });
      fs.rmSync(f, { force: true });
    }
  }

  function readLines(f) {
    let raw = '';
    try {
      raw = fs.readFileSync(f, 'utf8');
    } catch {
      return [];
    }
    const out = [];
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try {
        out.push(JSON.parse(line));
      } catch {
        // A torn line from a crash: drop it rather than block the queue.
      }
    }
    return out;
  }

  /** Records waiting: the spool, plus leftovers of killed processes that the next flush picks up. */
  function size() {
    const { flushing } = orphans();
    const inflightAll = listDir(inflightDir).filter((n) => n.endsWith('.json')).length;
    return readLines(file).length + flushing.reduce((n, f) => n + readLines(f).length, 0) + inflightAll;
  }

  function entries() {
    return readLines(file);
  }

  function acquireLock() {
    ensureDir();
    try {
      fs.writeFileSync(lockFile, String(process.pid), { flag: 'wx', mode: 0o600 });
      return true;
    } catch {
      try {
        const age = Date.now() - fs.statSync(lockFile).mtimeMs;
        if (age > STALE_LOCK_MS) {
          fs.rmSync(lockFile, { force: true });
          fs.writeFileSync(lockFile, String(process.pid), { flag: 'wx', mode: 0o600 });
          return true;
        }
      } catch {
        // someone else won the race
      }
      return false;
    }
  }

  function releaseLock() {
    try {
      fs.rmSync(lockFile, { force: true });
    } catch {
      // ignore
    }
  }

  /**
   * Replays spooled entries through send(entry) => Promise<'done'|'retry'|'drop'>.
   * Only one flusher runs at a time; appends during a flush are never lost.
   */
  async function flush(send, { budgetMs = 5_000, max = 100 } = {}) {
    const result = { sent: 0, dropped: 0, kept: 0, skipped: false };
    const left = orphans();
    if (!fs.existsSync(file) && !left.flushing.length && !left.inflight.length) return result;
    if (!acquireLock()) {
      result.skipped = true;
      return result;
    }
    const working = path.join(dir, `spool.flushing-${process.pid}-${Date.now()}.jsonl`);
    try {
      try {
        adoptOrphans();
      } catch {
        // keep going with what is in the spool
      }
      try {
        fs.renameSync(file, working);
      } catch {
        return result;
      }
      const start = Date.now();
      const items = readLines(working);
      const initialCount = items.length;
      const keep = [];
      let processed = 0;
      for (const item of items) {
        const tooOld = Date.now() - Date.parse(item.ts || 0) > maxAgeMs;
        if (tooOld) {
          result.dropped += 1;
          continue;
        }
        if (processed >= max || Date.now() - start > budgetMs) {
          keep.push(item);
          continue;
        }
        processed += 1;
        let verdict = 'retry';
        try {
          verdict = await send(item);
        } catch {
          verdict = 'retry';
        }
        if (verdict === 'done') result.sent += 1;
        else if (verdict === 'drop') result.dropped += 1;
        else keep.push({ ...item, attempts: (item.attempts || 0) + 1 });
      }
      return settle(working, initialCount, keep, result);
    } finally {
      releaseLock();
    }
  }

  /**
   * Puts back what was not sent, and anything appended to the working file after it was read (a
   * writer that opened the old path just before the rename), then removes the working file.
   */
  function settle(working, initialCount, keep, result) {
    const late = readLines(working).slice(initialCount);
    const survivors = [...keep, ...late].slice(-maxEntries);
    result.kept = survivors.length;
    if (survivors.length) {
      fs.appendFileSync(file, survivors.map((e) => JSON.stringify(e)).join('\n') + '\n', { mode: 0o600 });
    }
    fs.rmSync(working, { force: true });
    return result;
  }

  /**
   * Replays spooled entries in batches (POST /v1/checks/local takes up to 50 at once, ADR-0095):
   * sendBatch(entries) => Promise<Array<'done'|'retry'|'drop'>>, one verdict per entry in order.
   * `cut(entries)` may shorten a batch (to the number of entries that fit). A batch whose entries
   * all come back 'retry' (Aimiru busy or unreachable) stops the flush; the rest wait for the next.
   * Same lock, working file and leftovers as flush.
   */
  async function flushBatches(sendBatch, { budgetMs = 5_000, batchMax = 50, maxBatches = 4, cut = null } = {}) {
    const result = { sent: 0, dropped: 0, kept: 0, skipped: false, batches: 0 };
    const left = orphans();
    if (!fs.existsSync(file) && !left.flushing.length && !left.inflight.length) return result;
    if (!acquireLock()) {
      result.skipped = true;
      return result;
    }
    const working = path.join(dir, `spool.flushing-${process.pid}-${Date.now()}.jsonl`);
    try {
      try {
        adoptOrphans();
      } catch {
        // keep going with what is in the spool
      }
      try {
        fs.renameSync(file, working);
      } catch {
        return result;
      }
      const start = Date.now();
      const items = readLines(working);
      const initialCount = items.length;
      const fresh = [];
      for (const item of items) {
        if (Date.now() - Date.parse(item.ts || 0) > maxAgeMs) result.dropped += 1;
        else fresh.push(item);
      }
      const keep = [];
      let i = 0;
      while (i < fresh.length) {
        if (result.batches >= maxBatches || Date.now() - start > budgetMs) {
          keep.push(...fresh.slice(i));
          break;
        }
        let n = Math.min(Math.max(1, batchMax), fresh.length - i);
        if (typeof cut === 'function') {
          try {
            n = Math.max(1, Math.min(n, Math.floor(Number(cut(fresh.slice(i, i + n))) || n)));
          } catch {
            // the whole batch
          }
        }
        const batch = fresh.slice(i, i + n);
        i += n;
        result.batches += 1;
        let verdicts = null;
        try {
          verdicts = await sendBatch(batch);
        } catch {
          verdicts = null;
        }
        let retried = 0;
        batch.forEach((item, k) => {
          const v = Array.isArray(verdicts) ? verdicts[k] : 'retry';
          if (v === 'done') result.sent += 1;
          else if (v === 'drop') result.dropped += 1;
          else {
            retried += 1;
            keep.push({ ...item, attempts: (item.attempts || 0) + 1 });
          }
        });
        if (retried === batch.length) {
          keep.push(...fresh.slice(i));
          break;
        }
      }
      return settle(working, initialCount, keep, result);
    } finally {
      releaseLock();
    }
  }

  /**
   * When the oldest entry waiting was written (ms since the epoch), or null when none waits. Leftovers
   * of a killed process count as written long ago, so they go at the next flush.
   */
  function oldestMs() {
    const { flushing, inflight } = orphans();
    if (flushing.length || inflight.length) return 0;
    let oldest = null;
    for (const e of readLines(file)) {
      const t = Date.parse(e.ts || '');
      if (Number.isFinite(t) && (oldest === null || t < oldest)) oldest = t;
    }
    return oldest;
  }

  return { dir, file, append, begin, end, flush, flushBatches, size, entries, oldestMs };
}

// ---------------------------------------------------------------------------
// Pause memory: what this connector last heard about Pause (ADR-0022)
// ---------------------------------------------------------------------------

const PAUSE_FILE = 'paused.json';

/**
 * Remembers that Aimiru said this agent must stop (a 423, pause_status or the heartbeat), so the
 * connector stops on its own and stays stopped if Aimiru then cannot be reached. Kept in memory,
 * and in `dir` when given (next to the spool), so a connector that starts a new process for every
 * step (Claude Code) knows too. Only an answer from Aimiru clears it.
 *
 * `since` is when this connector first heard of the pause it holds now (ADR-0142): a later answer
 * that says the same pause goes on keeps it, and keeps Aimiru's sentence when it brings none (the
 * Pause acknowledgement's answer has no sentence), so the pause watch can tell one pause from the next.
 */
export function createPauseMemory(dir) {
  const file = dir ? path.join(dir, PAUSE_FILE) : null;
  let held = null;

  function get() {
    if (!file) return held;
    try {
      const v = JSON.parse(fs.readFileSync(file, 'utf8'));
      return v && v.paused === true ? { paused: true, explain: typeof v.explain === 'string' ? v.explain : null, at: v.at ?? null, since: v.since ?? v.at ?? null } : null;
    } catch {
      // No file (or a torn one): fall back to what this process heard itself.
      return held;
    }
  }

  function remember(explain) {
    const before = get();
    const now = new Date().toISOString();
    const said = typeof explain === 'string' && explain.trim() ? explain.trim() : null;
    held = { paused: true, explain: said ?? before?.explain ?? null, at: now, since: before?.since ?? now };
    if (!file) return;
    try {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      // Written whole, then moved into place: the watcher and the checks read it from other
      // processes, and a torn file would read as no pause in them.
      const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(held), { mode: 0o600 });
      fs.renameSync(tmp, file);
    } catch {
      // A read-only disk keeps the memory in this process only.
    }
  }

  function forget() {
    held = null;
    if (!file) return;
    try {
      fs.rmSync(file, { force: true });
    } catch {
      // ignore
    }
  }

  return { file, get, remember, forget };
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

/** Error codes that mean the connection was refused or dropped before Aimiru answered. */
const DROPPED_CODES = new Set(['ECONNRESET', 'ECONNREFUSED', 'EPIPE', 'UND_ERR_SOCKET']);

/**
 * True when a failed fetch was a refused or reset connection (wave 10: seen once on a first call,
 * "Aimiru is unreachable" for a step that a moment later went through). Looks through the error's
 * causes, and the errors of a connection tried on several addresses.
 */
export function isDroppedConnection(e, depth = 0) {
  if (!e || typeof e !== 'object' || depth > 4) return false;
  if (typeof e.code === 'string' && DROPPED_CODES.has(e.code)) return true;
  if (Array.isArray(e.errors) && e.errors.some((x) => isDroppedConnection(x, depth + 1))) return true;
  return isDroppedConnection(e.cause, depth + 1);
}

/**
 * True when the connection was refused before it opened, so nothing of the request was sent: every
 * address tried refused it. A reset or a broken pipe can come after Aimiru took the request and acted
 * on it, so it is not one (wave 10 review).
 */
export function isRefusedConnection(e, depth = 0) {
  if (!e || typeof e !== 'object' || depth > 4) return false;
  if (Array.isArray(e.errors) && e.errors.length) return e.errors.every((x) => isRefusedConnection(x, depth + 1));
  if (e.code === 'ECONNREFUSED') return true;
  return isRefusedConnection(e.cause, depth + 1);
}

/** The idempotency key a request carries, in its body or its Idempotency-Key header, or null. */
function idempotencyKeyIn(body, headers) {
  const fromBody = body && typeof body === 'object' && typeof body.idempotency_key === 'string' ? body.idempotency_key.trim() : '';
  if (fromBody) return fromBody;
  for (const [k, v] of Object.entries(headers || {})) if (k.toLowerCase() === 'idempotency-key' && typeof v === 'string' && v.trim()) return v.trim();
  return null;
}

/**
 * True for Aimiru's answer that the key belonged to a demo whose time is over (wave 10, shapes 1):
 * a 401 from Aimiru itself with the code demo_ended. A revoked or unknown key keeps invalid_token.
 */
export function isDemoEnded(r) {
  return Boolean(r) && r.ok === false && r.kind === 'http' && r.status === 401 && r.fromAimiru !== false && r.code === 'demo_ended';
}

/** The shortest retry worth starting after a dropped connection, in ms. */
const RETRY_MIN_MS = 250;

/**
 * @param {object} opts
 * @param {string} opts.baseUrl      Aimiru base URL (CONTRACT.md "Base and auth")
 * @param {string} opts.token        agent key, aimiru_agt_...
 * @param {string} opts.connector    "<name>/<version>", sent as x-aimiru-connector
 * @param {string} [opts.agentLabel] how the agent is named in person-facing sentences
 * @param {string} [opts.spoolDir]   where records are spooled when Aimiru cannot take them
 * @param {object} [opts.timeouts]   overrides for DEFAULT_TIMEOUTS
 * @param {Function} [opts.fetch]    fetch implementation (tests)
 * @param {string} [opts.connect]    how a person connects this connector, said when it has no key or
 *                                   address yet (default DEFAULT_CONNECT; Claude Code: CLAUDE_CODE_CONNECT)
 * @param {string} [opts.undoLine]   the line that removes this connector, said when a demo has ended
 *                                   (default: UNDO_LINES for this connector's name)
 */
export function createAimiruClient(opts = {}) {
  const timeouts = { ...DEFAULT_TIMEOUTS };
  for (const [k, v] of Object.entries(opts.timeouts || {})) {
    // A bad value (NaN, 0, negative, text) keeps the default instead of breaking every request.
    if (k in DEFAULT_TIMEOUTS && Number.isFinite(Number(v)) && Number(v) > 0) timeouts[k] = Number(v);
  }
  const fetchImpl = opts.fetch || globalThis.fetch;
  const connector = opts.connector || 'unknown/0.0.0';
  const agentLabel = opts.agentLabel || 'This agent';
  const connectHow = typeof opts.connect === 'string' && opts.connect.trim() ? opts.connect.trim() : DEFAULT_CONNECT;
  const undoLine = typeof opts.undoLine === 'string' && opts.undoLine.trim() ? opts.undoLine.trim() : undoLineFor(connector);
  /** What every refusal says once Aimiru answers that the demo has ended (wave 10, snag 12). */
  const demoEndedText = MESSAGES.demoEnded(undoLine);
  const token = typeof opts.token === 'string' ? opts.token.trim() : '';
  let baseUrl = null;
  let configError = null;
  try {
    baseUrl = normaliseBaseUrl(opts.baseUrl);
  } catch (e) {
    configError = `base URL ${e.message}`;
  }
  if (!token) configError = configError ? `${configError}; key missing` : 'key missing';
  const spool = opts.spoolDir ? createSpool(opts.spoolDir) : null;
  const pauseMemory = createPauseMemory(opts.spoolDir || null);

  const configured = !configError;

  /** Learns from a pause_status or heartbeat answer: {paused: true, explain} or {paused: false}. */
  function notePause(r) {
    if (!r?.ok || !r.data || typeof r.data.paused !== 'boolean') return;
    if (r.data.paused) pauseMemory.remember(r.data.explain ?? null);
    else pauseMemory.forget();
  }

  /**
   * One HTTP call to Aimiru. Never throws: every failure comes back as { ok: false, kind, ... }.
   * A connection refused before it opened is tried once more at once, inside the same time limit
   * (wave 10): nothing was sent. A connection reset or broken before Aimiru answered is tried again
   * only when sending it twice cannot act twice: a GET, or a request with an idempotency key, which
   * Aimiru answers the second time with its first answer (wave 10 review: a payment checked twice
   * was two actions and two asks, and a second take handed this agent a second task). If the second
   * try fails too, the failure comes back as before, so the fail-closed rule still applies.
   */
  async function request(method, pathname, { body, timeoutMs = timeouts.requestMs, headers = {} } = {}) {
    const requestId = randomUUID();
    if (!configured) {
      return { ok: false, kind: 'not_configured', status: 0, code: 'not_configured', message: configError, requestId };
    }
    const ms = Number.isFinite(Number(timeoutMs)) ? Math.max(1, Math.floor(Number(timeoutMs))) : timeouts.requestMs;
    const until = Date.now() + ms;
    const sendTwiceSafe = method === 'GET' || method === 'HEAD' || idempotencyKeyIn(body, headers) !== null;
    let res;
    let text = '';
    for (let attempt = 1; ; attempt += 1) {
      try {
        const init = {
          method,
          headers: {
            accept: 'application/json',
            authorization: `Bearer ${token}`,
            'x-aimiru-connector': connector,
            'x-request-id': requestId,
            ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
            ...headers,
          },
          body: body !== undefined ? JSON.stringify(body) : undefined,
          signal: AbortSignal.timeout(attempt === 1 ? ms : Math.max(1, until - Date.now())),
          redirect: 'error', // never forward the key to another host
        };
        res = await fetchImpl(`${baseUrl}${pathname}`, init);
        text = await res.text();
        break;
      } catch (e) {
        const name = e?.name || '';
        const kind = name === 'TimeoutError' || name === 'AbortError' ? 'timeout' : 'network';
        // Only before any answer arrived: a body cut off after Aimiru answered is not sent again.
        const again = isRefusedConnection(e) || (sendTwiceSafe && isDroppedConnection(e));
        if (kind === 'network' && attempt === 1 && !res && again && until - Date.now() >= RETRY_MIN_MS) continue;
        return { ok: false, kind, status: 0, code: kind, message: kind === 'timeout' ? 'timed out' : 'could not connect', requestId };
      }
    }
    let data = null;
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        data = null;
      }
    }
    const serverRequestId = res.headers.get('x-aimiru-request-id');
    if (res.ok) return { ok: true, status: res.status, data, requestId, serverRequestId, replay: res.headers.get('x-aimiru-replay') === 'true' };
    const ra = res.headers.get('retry-after');
    let retryAfterMs = null;
    if (ra) {
      const secs = Number(ra);
      retryAfterMs = Number.isFinite(secs) ? secs * 1000 : Math.max(0, Date.parse(ra) - Date.now());
    }
    const code = typeof data?.error?.code === 'string' && data.error.code ? data.error.code : null;
    return {
      ok: false,
      kind: 'http',
      status: res.status,
      code,
      message: data?.error?.message ?? null,
      fromAimiru: isAimiruAnswer(data),
      data,
      retryAfterMs,
      requestId,
      serverRequestId,
    };
  }

  /**
   * POST /v1/check. Returns the raw result; see decide() for the contract's rules applied.
   * run: {id, label} names the run (session) the call belongs to, so Aimiru can hold the agent to
   * the person's budget for each run and cap on runs at once (ADR-0042). project: {label, hash}
   * from projectOf names the project or client folder the agent works in (ADR-0056).
   */
  function check(action, { context, idempotencyKey, run, project, parts, taskId, timeoutMs = timeouts.checkMs } = {}) {
    const body = { action };
    if (idempotencyKey) body.idempotency_key = idempotencyKey;
    if (context) body.context = context;
    // The person's job this step belongs to (ADR-0157), so they can follow it live. An Aimiru from
    // before it drops the field unread.
    const task = taskIdOf(taskId);
    if (task) body.task_id = task;
    const named = wireProject(project);
    if (named) body.project = named;
    const runId = runIdOf(run?.id);
    if (runId) {
      body.run_id = runId;
      const label = runLabelOf(run?.label);
      if (label) body.run_label = label;
    }
    // The steps of a mixed command that name their own resource (Decision 9, ADR-0096): Aimiru
    // refuses the whole command when one of them is something the person's rules never allow.
    const named9 = wireParts(parts);
    if (named9.length) body.parts = named9;
    return request('POST', '/v1/check', { body, timeoutMs });
  }

  /**
   * GET /v1/approvals/{id}?wait=N (long-poll up to 25 s). waitingS: how much longer this connector
   * keeps waiting, in whole seconds (0 to 600), so the person sees how long the agent waits for
   * them and when it stopped (ADR-0094). An older Aimiru ignores it.
   */
  function approvalsWait(exceptionId, waitSeconds = 25, { timeoutMs, waitingS } = {}) {
    const wait = Math.max(0, Math.min(25, Math.floor(waitSeconds)));
    const t = timeoutMs ?? wait * 1000 + timeouts.longPollSlackMs;
    const waiting = waitingS === undefined || waitingS === null ? '' : `&waiting_s=${waitingSecondsOf(Number(waitingS) * 1000)}`;
    return request('GET', `/v1/approvals/${encodeURIComponent(exceptionId)}?wait=${wait}${waiting}`, { timeoutMs: t });
  }


  function me({ timeoutMs } = {}) {
    return request('GET', '/v1/me', { timeoutMs: timeoutMs ?? timeouts.requestMs });
  }

  /**
   * GET /v1/brief (ADR-0157, contract C2): the person's brief for this agent; read it with briefOf.
   * ifNoneMatch: the version this session was given, sent as If-None-Match, so Aimiru answers 304
   * while it still holds. Never spooled, never retried here.
   */
  function brief({ timeoutMs, ifNoneMatch = null } = {}) {
    const headers = typeof ifNoneMatch === 'string' && BRIEF_VERSION_RE.test(ifNoneMatch) ? { 'if-none-match': ifNoneMatch } : {};
    return request('GET', '/v1/brief', { timeoutMs: timeoutMs ?? timeouts.requestMs, headers });
  }

  /**
   * POST /v1/memory (the memory_propose tool, ADR-0125): one plain line about the person that this
   * agent noticed, for Aimiru to keep as learned or hold for the person (ADR-0157). how: 'noticed' (in
   * this work) or 'instructions' (what the agent's own instructions or memory already say). Never
   * spooled: a line Aimiru did not take is said at once, never sent later behind the person's back.
   */
  async function memoryPropose({ text, topic = null, how = null } = {}, { timeoutMs } = {}) {
    const body = { text: String(text ?? '') };
    if (typeof topic === 'string' && topic) body.topic = topic;
    if (how === 'noticed' || how === 'instructions') body.how = how;
    return notePausedAnswer(await request('POST', '/v1/memory', { body, timeoutMs: timeoutMs ?? timeouts.requestMs }));
  }

  /**
   * POST /v1/approvals/late (ADR-0094): the person's yeses to this computer's own waiting questions
   * that came in after the agent stopped waiting, each offered once. exceptionIds: at most 20.
   */
  function lateAnswers({ project = null, exceptionIds = [] } = {}, { timeoutMs } = {}) {
    const ids = [...new Set((Array.isArray(exceptionIds) ? exceptionIds : []).filter((x) => typeof x === 'string' && /^[0-9a-fA-F-]{36}$/.test(x)))].slice(0, 20);
    const named = wireProject(project);
    return request('POST', '/v1/approvals/late', { body: { project: named, exception_ids: ids }, timeoutMs: timeoutMs ?? timeouts.requestMs });
  }

  /** POST /v1/checks/local (ADR-0095): actions decided on this computer, for Aimiru to check again and record. */
  function postLocalChecks(body, { timeoutMs } = {}) {
    return request('POST', '/v1/checks/local', { body, timeoutMs: timeoutMs ?? timeouts.requestMs });
  }

  async function pause({ timeoutMs } = {}) {
    const r = await request('GET', '/v1/pause', { timeoutMs: timeoutMs ?? timeouts.requestMs });
    notePause(r);
    return r;
  }

  /**
   * POST /v1/pause/ack (ADR-0142): this connector confirms the pause in force, once per pause, as
   * soon as it learns of it. learnedBy: 'watch' (outside the step path: the watcher, a heartbeat, a
   * session start) or 'held' (at a step the agent tried, which its check held or, where its maker
   * cannot hold, refused). stepsAfter: the steps let through since the last read that showed no
   * pause, a whole number up to 1000, or null when this connector cannot say. Only the connector's
   * own process sends it, never the agent. The answer is a read of the pause too ({paused,
   * acknowledged, first, pause_at, ms_after_tap}), so it writes or clears the pause memory like
   * pause() does. Never answered 423; an Aimiru from before it answers 404.
   */
  async function pauseAck({ learnedBy, stepsAfter = null } = {}, { timeoutMs } = {}) {
    const body = { learned_by: learnedBy === 'held' ? 'held' : 'watch' };
    if (Number.isInteger(stepsAfter) && stepsAfter >= 0) body.steps_after = Math.min(1000, stepsAfter);
    const r = await request('POST', '/v1/pause/ack', { body, timeoutMs: timeoutMs ?? timeouts.requestMs });
    notePause(r);
    return r;
  }

  /**
   * A read another process of this connector made (its watcher's GET /v1/pause, ADR-0142) said this
   * agent is no longer paused: this process forgets the pause too. Aimiru's own answer, read through
   * the watcher's record of it, never a guess.
   */
  function forgetPause() {
    pauseMemory.forget();
  }

  async function heartbeat(body, { timeoutMs } = {}) {
    const r = await request('POST', '/v1/heartbeat', { body, timeoutMs: timeoutMs ?? timeouts.requestMs });
    notePause(r);
    return r;
  }

  /** A 423 paused answer from any route: this agent is paused until Aimiru says otherwise (ADR-0022). */
  function notePausedAnswer(r) {
    if (!r.ok && r.kind === 'http' && r.status === 423 && r.fromAimiru !== false) {
      pauseMemory.remember(r.data?.explain ?? null);
    }
    return r;
  }

  /**
   * POST /v1/tasks/take (the take_task tool): the oldest task another agent handed to this one,
   * marked taken, with the person's details it may read, or {task: null} (ADR-0016, ADR-0043).
   * When the task carries model time (a hand-off rule's budget, ADR-0055) the answer's budget holds
   * a temporary key, shown this once; withBudget false says this agent cannot use a key of its own,
   * so none is made.
   */
  async function takeTask({ timeoutMs, withBudget, runner } = {}) {
    const body = typeof withBudget === 'boolean' ? { with_budget: withBudget } : {};
    // The runner on this computer (ADR-0161): its id and the kind of computer; busy while a job runs
    // (it only says the runner is on, and takes nothing), leaving when it stops. Nothing else of it.
    if (runner && typeof runner === 'object' && typeof runner.id === 'string') {
      body.runner = {
        id: runner.id,
        device: String(runner.device ?? ''),
        ...(runner.busy === true ? { busy: true } : {}),
        ...(runner.leaving === true ? { leaving: true } : {}),
      };
    }
    return notePausedAnswer(await request('POST', '/v1/tasks/take', { body, timeoutMs: timeoutMs ?? timeouts.requestMs }));
  }

  /**
   * POST /v1/tasks/handoff (the report_cant tool): a task this agent cannot do, handed to another
   * agent by the person's rules, or the person asked. body: {task: {description, class?, amount_cap?,
   * currency?, context_fields?}, reason?, idempotency_key?}.
   */
  async function reportCant(body, { timeoutMs } = {}) {
    const key = typeof body?.idempotency_key === 'string' && body.idempotency_key ? body.idempotency_key : null;
    return notePausedAnswer(
      await request('POST', '/v1/tasks/handoff', {
        body,
        timeoutMs: timeoutMs ?? timeouts.requestMs,
        headers: key ? { 'idempotency-key': key } : {},
      }),
    );
  }

  /**
   * GET /v1/tasks/{task_id} (the get_task tool, ADR-0060): one task this agent handed on or was
   * handed, with its result once it is ready (held back whole when it holds a detail this agent may
   * not read, ADR-0077). Only a task id goes in the address; anything else is refused here.
   */
  async function getTask(taskId, { timeoutMs } = {}) {
    const id = typeof taskId === 'string' ? taskId.trim() : '';
    if (!/^[0-9a-fA-F-]{36}$/.test(id)) {
      return { ok: false, kind: 'invalid', status: 0, code: 'bad_request', message: 'task_id must be the id Aimiru gave the task.' };
    }
    return notePausedAnswer(await request('GET', `/v1/tasks/${id}`, { timeoutMs: timeoutMs ?? timeouts.requestMs }));
  }

  /** POST /v1/context (the get_context tool): the person's details this agent may read, by name. */
  async function getContext(body, { timeoutMs } = {}) {
    return notePausedAnswer(await request('POST', '/v1/context', { body: body ?? { fields: [] }, timeoutMs: timeoutMs ?? timeouts.requestMs }));
  }

  /** What this connector last heard: {paused: true, explain, at} while stopped, else null. */
  function pausedLocally() {
    return pauseMemory.get();
  }

  /**
   * For a connector that reads Aimiru's answers itself (OpenClaw's own approval wait): Aimiru
   * answered 423, so this agent is paused until Aimiru says otherwise (ADR-0022).
   */
  function rememberPause(explain) {
    pauseMemory.remember(explain ?? null);
  }

  function postReceipt(receipt, { timeoutMs } = {}) {
    return request('POST', '/v1/receipts', {
      body: receipt,
      timeoutMs: timeoutMs ?? timeouts.requestMs,
      headers: receipt.idempotency_key ? { 'idempotency-key': receipt.idempotency_key } : {},
    });
  }

  /** Whether a failed receipt should be kept for later (true) or dropped (false). */
  function retryable(r) {
    if (r.ok) return false;
    if (r.kind !== 'http') return true; // network, timeout, not_configured
    if (r.fromAimiru === false) return true; // refused before it reached Aimiru: try again later
    return r.status >= 500 || r.status === 429 || r.status === 401 || r.status === 423 || r.status === 408;
  }

  /**
   * POST /v1/receipts, spooling it when Aimiru cannot take it now.
   * Always sets an idempotency_key so a replay from the spool never writes twice.
   */
  async function record(receipt, { spoolOnFailure = true, timeoutMs } = {}) {
    const body = {
      action_id: receipt.action_id ?? null,
      outcome: receipt.outcome || 'completed',
      ...receipt,
      idempotency_key: receipt.idempotency_key || randomUUID(),
    };
    if (body.summary) body.summary = truncate(redactSecrets(body.summary), 280);
    // The project (ADR-0056) as check sends it; a receipt for an action keeps that action's.
    if ('project' in body) {
      const named = wireProject(body.project);
      if (named) body.project = named;
      else delete body.project;
    }
    if (body.evidence) body.evidence = redactSecrets(body.evidence);
    // On disk before the request starts: a process killed mid-request leaves it for the next flush.
    const ticket = spoolOnFailure && spool ? spool.begin({ kind: 'record', body }) : null;
    const r = await postReceipt(body, { timeoutMs });
    if (r.ok) {
      spool?.end(ticket);
      return { ...r, spooled: false };
    }
    if (spoolOnFailure && spool && retryable(r)) {
      try {
        spool.append({ kind: 'record', body });
        spool.end(ticket);
      } catch {
        // the in-flight copy stays on disk and is picked up later
      }
      return { ...r, spooled: true };
    }
    spool?.end(ticket);
    return { ...r, spooled: false };
  }

  /** Replays spooled records. */
  async function flushSpool({ budgetMs = 5_000, max = 100 } = {}) {
    if (!spool) return { sent: 0, dropped: 0, kept: 0, skipped: true };
    if (!configured) return { sent: 0, dropped: 0, kept: spool.size(), skipped: true };
    return spool.flush(
      async (entry) => {
        if (entry.kind !== 'record' || !entry.body) return 'drop';
        const r = await postReceipt(entry.body, { timeoutMs: Math.min(timeouts.requestMs, budgetMs) });
        if (r.ok) return 'done';
        return retryable(r) ? 'retry' : 'drop';
      },
      { budgetMs, max },
    );
  }

  /** Builds a deny or fail-open answer for when Aimiru did not give one. */
  function failByClass(action, reason, explain, extra = {}) {
    if (isFailClosed(action?.class, { sensitive: action?.sensitive === true })) {
      return { decision: 'deny', reason, explain, failClosed: true, ...extra };
    }
    return { decision: 'allow', reason, explain: null, failOpen: true, ...extra };
  }

  /**
   * check() with the contract's client rules applied.
   * Resolves to { decision: allow|ask|deny, reason, explain, exceptionId, actionId, pollAfterMs, expiresAt,
   *               failOpen?, failClosed?, status, requestId }.
   * reason is one of: aimiru, paused, invalid_token, demo_ended, outside_grant, conflict, rate_limited,
   *                   unreachable, bad_response, not_configured.
   */
  async function decide(action, opts = {}) {
    const d = await decideOnce(action, opts);
    if (d.reason === 'paused') {
      pauseMemory.remember(d.explain);
      return d;
    }
    // Aimiru answered with a decision, which it never does while this agent is paused.
    if (d.reason === 'aimiru') {
      pauseMemory.forget();
      return d;
    }
    // Any other refusal from Aimiru stands on its own.
    if (d.decision === 'deny' && !d.failClosed) return d;
    // Aimiru did not answer. An agent Aimiru said is paused takes no step at all until Aimiru
    // says otherwise, reads included (ADR-0022).
    const held = configured ? pauseMemory.get() : null;
    if (held) {
      return {
        decision: 'deny',
        reason: 'paused',
        explain: held.explain || MESSAGES.stillPaused,
        failClosed: true,
        remembered: true,
        status: d.status ?? 0,
        requestId: d.requestId ?? null,
        serverRequestId: d.serverRequestId ?? null,
      };
    }
    return d;
  }

  async function decideOnce(action, { context, idempotencyKey: given, deadlineMs, run, project, parts, taskId } = {}) {
    // One key for this decision, made here when the caller has none: a second try after a dropped
    // connection, or after a 429, is then a replay Aimiru answers with its first answer, never a
    // second action and a second question (wave 10 review).
    const idempotencyKey = typeof given === 'string' && given.trim() ? given : randomUUID();
    const wire = { ...action };
    delete wire.sensitive; // local-only hint
    // A mixed command's named steps (ADR-0096): given, or kept on the action out of sight (neverParts).
    const steps = wireParts(parts ?? action?.neverParts);
    const named9 = steps.length ? steps : undefined;
    const cls = action?.class;
    if (!configured) {
      return failByClass(action, 'not_configured', MESSAGES.notConfigured(agentLabel, cls, connectHow), { status: 0 });
    }
    // With a deadline (a Claude Code check has a hard time limit), no request may run past it:
    // a check still running when the caller is killed is a check whose answer nobody applies.
    const checkTimeout = () => (deadlineMs ? Math.min(timeouts.checkMs, deadlineMs - Date.now()) : timeouts.checkMs);
    if (checkTimeout() < 250) {
      return failByClass(action, 'unreachable', MESSAGES.unreachable(cls), { status: 0, requestId: null, serverRequestId: null });
    }
    // The person's job this step belongs to, when there is one (ADR-0157): only a well-formed id goes.
    let task = taskIdOf(taskId);
    let r = await check(wire, { context, idempotencyKey, run, project, parts: named9, taskId: task, timeoutMs: checkTimeout() });
    // An Aimiru that refused the field as a bad request (one from before it drops it unread): the
    // same step is checked again without it, so a check never fails because of the job's id.
    if (task && !r.ok && r.kind === 'http' && (r.status === 400 || r.status === 422) && r.fromAimiru !== false && checkTimeout() >= 250) {
      task = null;
      r = await check(wire, { context, idempotencyKey, run, project, parts: named9, timeoutMs: checkTimeout() });
    }
    if (!r.ok && r.kind === 'http' && r.status === 429) {
      const wait = r.retryAfterMs ?? 1000;
      const left = deadlineMs ? deadlineMs - Date.now() - 1_000 : Infinity;
      if (wait <= timeouts.maxRetryAfterMs && wait < left) {
        await sleep(wait);
        if (checkTimeout() >= 250) r = await check(wire, { context, idempotencyKey, run, project, parts: named9, taskId: task, timeoutMs: checkTimeout() });
      }
    }
    const base = { status: r.status, requestId: r.requestId, serverRequestId: r.serverRequestId ?? null };
    if (r.ok) {
      const d = r.data || {};
      if (!['allow', 'ask', 'deny'].includes(d.decision)) {
        return failByClass(action, 'bad_response', MESSAGES.unreachable(cls), base);
      }
      if (d.decision === 'ask' && !d.exception_id) {
        // An ask with nothing to wait on cannot be answered: treat as no.
        return { decision: 'deny', reason: 'bad_response', explain: d.explain || MESSAGES.doNotAct, ...base };
      }
      return {
        decision: d.decision,
        reason: 'aimiru',
        explain: d.explain ?? (d.rule?.text ? d.rule.text : null),
        rule: d.rule ?? null,
        actionId: d.action_id ?? null,
        exceptionId: d.exception_id ?? null,
        pollAfterMs: d.poll_after_ms ?? null,
        expiresAt: d.expires_at ?? null,
        remainingToday: d.remaining_today ?? null,
        remainingRun: d.remaining_run ?? null,
        record: d.record ?? null,
        // On an ask (ADR-0094): whether a phone can be reached now and when quiet hours end, and
        // whether a yes can still be used by the agent's next identical check. An older Aimiru
        // sends neither: no reach (the wait is sized as no phone) and no promise about a retry.
        reach: readReach(d.reach),
        reuse: d.reuse === 'next_try' || d.reuse === 'none' ? d.reuse : null,
        quietUntil: typeof d.person_quiet_until === 'string' && Number.isFinite(Date.parse(d.person_quiet_until)) ? d.person_quiet_until : null,
        ...base,
      };
    }
    if (r.kind === 'http' && r.fromAimiru === false && r.status !== 429) {
      // Refused on the way (not Aimiru's JSON answer): Aimiru did not decide, so the fail-closed rule applies.
      return failByClass(action, 'unreachable', MESSAGES.unreachable(cls), base);
    }
    if (r.kind === 'http') {
      const explain = r.data?.explain || r.message || null;
      switch (r.status) {
        case 423:
          return { decision: 'deny', reason: 'paused', explain: r.data?.explain || MESSAGES.paused, ...base };
        case 401:
          // A demo whose time is over says so, with how to remove this connector (wave 10, snag 12).
          if (isDemoEnded(r)) return { decision: 'deny', reason: 'demo_ended', explain: demoEndedText, ...base };
          return { decision: 'deny', reason: 'invalid_token', explain: MESSAGES.reconnect(agentLabel), ...base };
        case 403:
          return { decision: 'deny', reason: 'outside_grant', explain: explain || MESSAGES.outsideGrant, ...base };
        case 409:
          return { decision: 'deny', reason: 'conflict', explain: MESSAGES.doNotAct, ...base };
        case 429:
          return failByClass(action, 'rate_limited', MESSAGES.busy(cls), base);
        default:
          return failByClass(action, 'unreachable', MESSAGES.unreachable(cls), base);
      }
    }
    return failByClass(action, 'unreachable', MESSAGES.unreachable(cls), base);
  }

  /**
   * Waits for the person's answer on an exception, within budgetMs.
   * Resolves to { status: allowed|denied|expired|waiting, explain, reason }.
   * Anything but "allowed" means do not act.
   */
  /**
   * Reads one answer of GET /v1/approvals/{id}: {status: allowed|denied|expired, explain, reason}
   * when it settles the question, {status: 'waiting', explain} while it still waits, or null for
   * trouble on the way (network, 5xx, a refusal from something between here and Aimiru).
   */
  function approvalAnswerOf(r) {
    if (r.ok) {
      const d = r.data || {};
      // A no in either field wins; a yes needs the status to say so (or no status at all).
      if (d.status === 'denied' || d.decision === 'deny') return { status: 'denied', explain: d.explain ?? null, reason: 'aimiru' };
      if (d.status === 'expired') return { status: 'expired', explain: d.explain ?? null, reason: 'aimiru' };
      // When the person said yes (Aimiru's clock), so a yes given before a Pause is never used after
      // it (ADR-0035, ADR-0142); null from an Aimiru that does not say.
      if (d.status === 'allowed' || (d.status == null && d.decision === 'allow')) {
        return { status: 'allowed', explain: d.explain ?? null, reason: 'aimiru', answeredAt: typeof d.answered_at === 'string' ? d.answered_at : null };
      }
      return { status: 'waiting', explain: d.explain ?? null, reason: 'waiting' };
    }
    const aimiru = r.kind === 'http' && r.fromAimiru !== false;
    if (aimiru && r.status === 423) {
      pauseMemory.remember(r.data?.explain || null);
      return { status: 'denied', explain: r.data?.explain || MESSAGES.paused, reason: 'paused' };
    }
    if (aimiru && r.status === 401) {
      return isDemoEnded(r) ? { status: 'denied', explain: demoEndedText, reason: 'demo_ended' } : { status: 'denied', explain: MESSAGES.reconnect(agentLabel), reason: 'invalid_token' };
    }
    if (aimiru && (r.status === 404 || r.status === 403 || r.status === 410)) return { status: 'expired', explain: null, reason: 'gone' };
    return null;
  }

  /**
   * One look at a question without waiting (ADR-0094): `?wait=0&waiting_s=0` by default, which
   * also tells Aimiru this connector is not waiting (quiet hours), so the person sees at once that
   * the agent stopped. Resolves like waitForApproval; trouble on the way reads as still waiting.
   */
  async function approvalNow(exceptionId, { timeoutMs = 3_000, waitingS = 0 } = {}) {
    const r = await approvalsWait(exceptionId, 0, { timeoutMs, waitingS });
    return approvalAnswerOf(r) ?? { status: 'waiting', explain: null, reason: 'timeout' };
  }

  async function waitForApproval(exceptionId, { budgetMs = 35_000, pollAfterMs = 2_000 } = {}) {
    const deadline = Date.now() + budgetMs;
    let lastExplain = null;
    for (;;) {
      const remaining = deadline - Date.now();
      if (remaining < 1_000) return { status: 'waiting', explain: lastExplain, reason: 'timeout' };
      const waitS = longPollSeconds(remaining);
      const started = Date.now();
      // Each poll says how much longer this connector waits (ADR-0094), so the person's countdown
      // ends when the agent stops, not when the question does.
      const r = await approvalsWait(exceptionId, waitS, { timeoutMs: Math.max(500, deadline - Date.now()), waitingS: Math.ceil(remaining / 1000) });
      const a = approvalAnswerOf(r);
      if (a && a.status !== 'waiting') return a;
      if (a) {
        lastExplain = a.explain ?? lastExplain;
        // waiting: if the server answered early, do not spin
        if (Date.now() - started < 1_000) await sleep(Math.min(pollAfterMs, Math.max(0, deadline - Date.now() - 500)));
        continue;
      }
      // network trouble, 5xx, or a refusal on the way while waiting: try again shortly while time remains
      await sleep(Math.min(1_000, Math.max(0, deadline - Date.now() - 500)));
    }
  }

  return {
    configured,
    configError,
    baseUrl,
    connector,
    undoLine,
    demoEndedText,
    connectHow,
    spool,
    request,
    check,
    decide,
    approvalsWait,
    approvalNow,
    waitForApproval,
    lateAnswers,
    postLocalChecks,
    record,
    flushSpool,
    heartbeat,
    me,
    brief,
    memoryPropose,
    pause,
    pauseAck,
    pausedLocally,
    rememberPause,
    forgetPause,
    takeTask,
    reportCant,
    getTask,
    getContext,
  };
}
