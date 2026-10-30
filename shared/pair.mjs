// Connect by pairing (ADR-0034, workers/agent-api/CONTRACT.md "Pairing"), for every connector:
// the agent asks Aimiru for a code with no key, shows its person the code and the link, polls until
// the person picks that code in Aimiru and taps Connect, and keeps the key it gets, once, in a file
// only the person can read. Then it waits on the practice request Aimiru made from it, which only an
// alert brings to the person: when the poll's answer says it reaches nobody (practice.reaches_nobody,
// read, never the words), it says so and does not wait.
//
// ADR-0150 (Mac run part 1, 28 Oct 2026): a connector may hand pairAgent an opener that opens the
// page in the person's browser (Claude Code and Codex do, from open-page.mjs, which this file never
// imports: OpenClaw carries this file and must start no program); the wait can say each minute how
// long the request has left; a stop (a shell's time limit) ends the wait between polls, never while
// a poll that may carry the key is on its way; and the request can be kept owner-only so the next
// run waits on the same code.
//
// Zero dependencies: Node 18+ built-ins only. Vendored into each connector by
// scripts/sync-shared.mjs. Edit it only in connectors/shared/ and run `node scripts/sync-shared.mjs`.
//
// Never prints or logs the key or the poll secret.

import fs from 'node:fs';
import path from 'node:path';
import { createAimiruClient, normaliseBaseUrl, sleep as realSleep } from './aimiru-client.mjs';

/** Seconds between polls the server asks for, and its floor (it answers slow_down under 300 ms). */
export const PAIR_INTERVAL_MS = 3_000;
/** A request lasts 10 minutes; a little more, so the last poll can land. */
export const PAIR_MAX_WAIT_MS = 10.5 * 60_000;
/**
 * After the person taps Connect, Aimiru keeps the key for the first poll up to 10 minutes
 * (CONTRACT.md "Pairing": 410 expired ten minutes after an approval nobody polled). A kept request is
 * polled once more for that long after its own 10 minutes, so a Connect tapped near the end, after a
 * run had stopped, still gives its key to the next run.
 */
export const PAIR_KEY_KEPT_MS = 10 * 60_000;
/** How long the first run waits on the practice request before saying it is still waiting. */
export const PRACTICE_WAIT_MS = 90_000;

/** "9 minutes", "1 minute", "less than a minute". */
function minutesText(minutes) {
  if (typeof minutes === 'number' && minutes < 1) return 'less than a minute';
  return minutes === 1 ? '1 minute' : `${minutes} minutes`;
}

/** What a connector prints at each step (docs/04: plain words, no dashes, no technical words). */
export const PAIR_MESSAGES = Object.freeze({
  open: (url) => `Open this on your phone: ${url}`,
  /** The page is open in the person's browser on this computer; the same link works on a phone. */
  opened: (url) => `Opened this page in your browser, or open it on your phone: ${url}`,
  pick: (code) => `Pick ${code} there, then tap Connect. Tap Not mine if you did not start this.`,
  waiting: 'Waiting for you to connect it. This runs out in 10 minutes.',
  /** Said each minute while it waits (remindEveryMs), and when a run waits on a kept request again. */
  waitingLeft: (minutes) => `Waiting for you to connect it. This runs out in ${minutesText(minutes)}.`,
  stillWaiting: 'Still waiting for you to connect it. Run this again to keep waiting with the same code.',
  /** This run stopped waiting while the request still lasts; `command` waits on the same code. */
  stillWaitingRun: (command) => `Still waiting: run ${command} again to keep waiting with the same code.`,
  connected: (name) => `Connected to Aimiru as ${name}.`,
  savedKey: (file) => `Saved the key to ${file}, readable only by you.`,
  practice: 'Aimiru sent you a practice request as an alert. Answer it from that alert: nothing happens either way.',
  practiceAnswered: (seconds) => `You answered in ${seconds} s.`,
  practiceWaiting: 'The practice request is still waiting. Answer it from the alert when you can.',
  /** Aimiru has no device of the person's to alert, so nothing brings the practice request to them. */
  practiceNowhere:
    'Aimiru has no device of yours to alert, so the practice request reaches nobody. Turn on alerts in Aimiru, under Settings, Notifications. Once a phone is paired, Aimiru alerts only that phone, so turn them on there.',
  declined: 'You said this request is not yours, or picked another code, so nothing was connected.',
  expired: 'The request ran out of time. Run this again to get a new code.',
  used: 'This request was already used. Run this again to get a new code.',
  limited: (seconds) => `Too many requests to connect from this network. Try again in ${seconds} seconds.`,
  noAddress: 'Set the Aimiru address first, the one your Aimiru shows, starting with https://.',
  badAddress: (why) => `The Aimiru address ${why}.`,
  unreachable: 'Aimiru could not be reached. Check the address and your connection, then try again.',
  refused: (status) =>
    `Something between this computer and Aimiru refused the request (${status}), so Aimiru never saw it. Check the Aimiru address, and any firewall or network filter on this computer.`,
});

function headersFor(connector) {
  return {
    accept: 'application/json',
    'content-type': 'application/json',
    // Some hosts turn default user agents away before Aimiru sees the request (llms.txt).
    'user-agent': `${connector || 'aimiru-connector'} (pairing)`,
    'x-aimiru-connector': connector || 'unknown/0.0.0',
  };
}

async function post(fetchImpl, url, body, connector, timeoutMs = 10_000) {
  let res;
  let text = '';
  try {
    res = await fetchImpl(url, {
      method: 'POST',
      headers: headersFor(connector),
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
      redirect: 'error',
    });
    text = await res.text();
  } catch {
    return { status: 0, data: null, fromAimiru: false, retryAfter: null };
  }
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }
  const fromAimiru = Boolean(data && typeof data === 'object' && (typeof data.status === 'string' || typeof data.error?.code === 'string' || typeof data.pair_id === 'string'));
  const ra = Number(res.headers.get('retry-after'));
  return { status: res.status, data, fromAimiru, retryAfter: Number.isFinite(ra) ? ra : null };
}

/**
 * POST /v1/pair. Returns {ok: true, pairId, pollSecret, code, approveUrl, intervalMs, expiresIn}
 * or {ok: false, reason: 'no_address' | 'bad_address' | 'limited' | 'refused' | 'unreachable' | 'bad_request', message}.
 */
export async function startPairing({ baseUrl, agent, connector, personEmail = null, templateHint = null, fetch: fetchImpl = globalThis.fetch } = {}) {
  if (!baseUrl) return { ok: false, reason: 'no_address', message: PAIR_MESSAGES.noAddress };
  let base;
  try {
    base = normaliseBaseUrl(baseUrl);
  } catch (e) {
    return { ok: false, reason: 'bad_address', message: PAIR_MESSAGES.badAddress(e.message) };
  }
  const connectorLabel = connector?.name ? `${connector.name}/${connector.version || '0'}` : null;
  const body = {
    agent: { name: agent?.name, kind: agent?.kind || 'custom', ...(agent?.host ? { host: String(agent.host).slice(0, 80) } : {}) },
    ...(connector ? { connector } : {}),
    ...(personEmail ? { person_email: personEmail } : {}),
    ...(templateHint ? { template_hint: templateHint } : {}),
  };
  const r = await post(fetchImpl, `${base}/v1/pair`, body, connectorLabel);
  if (r.status === 200 && r.data?.pair_id && r.data?.poll_secret && r.data?.code) {
    return {
      ok: true,
      baseUrl: base,
      pairId: r.data.pair_id,
      pollSecret: r.data.poll_secret,
      code: r.data.code,
      approveUrl: r.data.approve_url,
      intervalMs: Math.max(1_000, Number(r.data.interval) * 1000 || PAIR_INTERVAL_MS),
      expiresIn: Number(r.data.expires_in) || 600,
    };
  }
  if (r.status === 0) return { ok: false, reason: 'unreachable', message: PAIR_MESSAGES.unreachable };
  if (!r.fromAimiru) return { ok: false, reason: 'refused', message: PAIR_MESSAGES.refused(r.status) };
  if (r.status === 429) return { ok: false, reason: 'limited', message: PAIR_MESSAGES.limited(r.retryAfter ?? 60) };
  if (r.status === 400) return { ok: false, reason: 'bad_request', message: r.data?.error?.message || PAIR_MESSAGES.unreachable };
  return { ok: false, reason: 'unreachable', message: PAIR_MESSAGES.unreachable };
}

/** POST /v1/pair/poll once: {status: 'waiting' | 'slow_down' | 'approved' | 'declined' | 'expired' | 'used' | 'not_found' | 'error', data}. */
export async function pollPairing({ baseUrl, pairId, pollSecret, connector, fetch: fetchImpl = globalThis.fetch } = {}) {
  const r = await post(fetchImpl, `${baseUrl}/v1/pair/poll`, { pair_id: pairId, poll_secret: pollSecret }, connector);
  if (r.status === 200 && typeof r.data?.agent_key === 'string') return { status: 'approved', data: r.data };
  if (r.status === 428) return { status: 'waiting', data: r.data };
  if (r.status === 429) return { status: 'slow_down', data: r.data };
  if (r.status === 403 && r.fromAimiru) return { status: 'declined', data: r.data };
  if (r.status === 410 && r.fromAimiru) return { status: r.data?.status === 'used' ? 'used' : 'expired', data: r.data };
  if (r.status === 404 && r.fromAimiru) return { status: 'not_found', data: r.data };
  return { status: 'error', data: r.data, httpStatus: r.status };
}

/** Calls a connector's opener; any failure counts as not opened. */
async function tryOpen(openPage, url) {
  try {
    return (await openPage(url)) === true;
  } catch {
    return false;
  }
}

/** Sleeps, unless `signal` stops it first. Resolves true when stopped. */
function sleepUnlessStopped(sleep, ms, signal) {
  if (!signal) return sleep(ms).then(() => false);
  if (signal.aborted) return Promise.resolve(true);
  return new Promise((resolve) => {
    const onStop = () => resolve(true);
    signal.addEventListener('abort', onStop, { once: true });
    sleep(ms).then(() => {
      signal.removeEventListener('abort', onStop);
      resolve(false);
    });
  });
}

/** Whole minutes a request has left, rounded up ("This runs out in 9 minutes"). */
function minutesLeft(expiresAt, now) {
  return Math.ceil(Math.max(0, expiresAt - now) / 60_000);
}

/** pairAgent's answer for a poll that brought the key. */
function approvedResult(r, baseUrl, agent) {
  return {
    ok: true,
    baseUrl,
    agentKey: r.data.agent_key,
    agentId: r.data.agent_id,
    name: r.data.name || agent?.name,
    tier: r.data.tier || 'advised',
    practice: r.data.practice && r.data.practice.exception_id ? r.data.practice : null,
  };
}

/**
 * The whole exchange: start, tell the person (say), poll until an answer or the request runs out.
 * Returns {ok: true, agentKey, agentId, name, tier, practice, baseUrl} or {ok: false, reason, message}
 * (reason 'waiting', with `started`, when this run stopped while the request still lasts).
 * The key is returned to the caller only; nothing here prints it.
 *
 * openPage(url): the connector's opener (ADR-0150), called once for a new request with the page's
 * address; true when the page opened in the person's browser. remindEveryMs: say how long the
 * request has left this often while waiting (0: never). signal: an AbortSignal that ends the wait
 * between polls; a poll already on its way is always read, so a key it carries is never dropped.
 * resume: a kept request (resumeFrom); past its 10 minutes but within PAIR_KEY_KEPT_MS it is polled
 * once, silently, for a key the person's Connect left, and only then does a new request start.
 */
export async function pairAgent({
  baseUrl,
  agent,
  connector,
  personEmail = null,
  templateHint = null,
  say = (line) => process.stdout.write(`${line}\n`),
  fetch: fetchImpl = globalThis.fetch,
  sleep = realSleep,
  now = () => Date.now(),
  maxWaitMs = PAIR_MAX_WAIT_MS,
  resume = null,
  onStarted = null,
  openPage = null,
  remindEveryMs = 0,
  signal = null,
} = {}) {
  const connectorLabel = connector?.name ? `${connector.name}/${connector.version || '0'}` : null;
  const kept = Boolean(resume && resume.pairId && resume.pollSecret && Number.isFinite(resume.expiresAt));
  // A request started earlier (still within its 10 minutes) is polled again rather than replaced.
  const resumed = kept && resume.expiresAt > now();
  // One that ran out a moment ago may still hold the key of a Connect tapped near its end: one poll.
  if (kept && !resumed && resume.expiresAt + PAIR_KEY_KEPT_MS > now()) {
    const last = await pollPairing({ baseUrl: resume.baseUrl, pairId: resume.pairId, pollSecret: resume.pollSecret, connector: connectorLabel, fetch: fetchImpl });
    if (last.status === 'approved') return approvedResult(last, resume.baseUrl, agent);
  }
  const started = resumed
    ? { ok: true, ...resume }
    : await startPairing({ baseUrl, agent, connector, personEmail, templateHint, fetch: fetchImpl });
  if (!started.ok) return started;
  if (!started.expiresAt) started.expiresAt = now() + started.expiresIn * 1000;
  if (onStarted && !resumed) onStarted(started);
  // A kept request's page is open already (the run before opened it): only a new one is opened.
  const opened = !resumed && typeof openPage === 'function' ? await tryOpen(openPage, started.approveUrl) : false;
  say(opened ? PAIR_MESSAGES.opened(started.approveUrl) : PAIR_MESSAGES.open(started.approveUrl));
  say(PAIR_MESSAGES.pick(started.code));
  say(resumed ? PAIR_MESSAGES.waitingLeft(minutesLeft(started.expiresAt, now())) : PAIR_MESSAGES.waiting);
  const deadline = Math.min(now() + maxWaitMs, started.expiresAt + 30_000);
  let interval = started.intervalMs;
  let failures = 0;
  let nextReminder = remindEveryMs > 0 ? now() + remindEveryMs : Infinity;
  while (now() < deadline) {
    if (await sleepUnlessStopped(sleep, interval, signal)) break;
    if (now() >= nextReminder && now() < started.expiresAt) {
      say(PAIR_MESSAGES.waitingLeft(minutesLeft(started.expiresAt, now())));
      while (nextReminder <= now()) nextReminder += remindEveryMs;
    }
    // Never abandoned once sent: the answer that carries the key comes only once.
    const r = await pollPairing({ baseUrl: started.baseUrl, pairId: started.pairId, pollSecret: started.pollSecret, connector: connectorLabel, fetch: fetchImpl });
    if (r.status === 'approved') return approvedResult(r, started.baseUrl, agent);
    if (r.status === 'waiting') {
      failures = 0;
      continue;
    }
    if (r.status === 'slow_down') {
      interval = Math.min(interval + 1_000, 10_000);
      continue;
    }
    if (r.status === 'declined') return { ok: false, reason: 'declined', message: PAIR_MESSAGES.declined };
    if (r.status === 'expired') return { ok: false, reason: 'expired', message: PAIR_MESSAGES.expired };
    if (r.status === 'used') return { ok: false, reason: 'used', message: PAIR_MESSAGES.used };
    if (r.status === 'not_found') return { ok: false, reason: 'expired', message: PAIR_MESSAGES.expired };
    // Network trouble or Aimiru down for a moment: keep trying while the request lasts, a little slower.
    failures += 1;
    if (failures >= 20) return { ok: false, reason: 'unreachable', message: PAIR_MESSAGES.unreachable };
  }
  // Out of this run's time while the request still lasts: the caller may poll again (resume).
  if (now() < started.expiresAt) return { ok: false, reason: 'waiting', message: PAIR_MESSAGES.stillWaiting, started };
  return { ok: false, reason: 'expired', message: PAIR_MESSAGES.expired };
}

/**
 * Waits on the practice request with the new key, and says how it went. Returns
 * {status: 'allowed' | 'denied' | 'expired' | 'waiting' | 'nowhere' | 'none', seconds}.
 * A practice request is in no list in Aimiru, so only an alert brings it to the person: when the
 * poll's answer says Aimiru has no device of theirs to alert (practice.reaches_nobody), it says so,
 * never that one was sent, and asks Aimiru nothing more ('nowhere').
 */
export async function waitForPractice({ baseUrl, agentKey, practice, connector, say = (line) => process.stdout.write(`${line}\n`), fetch: fetchImpl, budgetMs = PRACTICE_WAIT_MS, now = () => Date.now() } = {}) {
  if (!practice?.exception_id) return { status: 'none', seconds: null };
  if (practice.reaches_nobody === true) {
    say(PAIR_MESSAGES.practiceNowhere);
    return { status: 'nowhere', seconds: null };
  }
  say(PAIR_MESSAGES.practice);
  const client = createAimiruClient({ baseUrl, token: agentKey, connector: connector || 'unknown/0.0.0', ...(fetchImpl ? { fetch: fetchImpl } : {}) });
  const t0 = now();
  const answer = await client.waitForApproval(practice.exception_id, { budgetMs });
  const seconds = Math.max(1, Math.round((now() - t0) / 1000));
  if (answer.status === 'allowed' || answer.status === 'denied') {
    say(PAIR_MESSAGES.practiceAnswered(seconds));
    return { status: answer.status, seconds };
  }
  say(PAIR_MESSAGES.practiceWaiting);
  return { status: answer.status, seconds: null };
}

/** Writes {key, base_url, agent_id, name} to a file only its owner can read (folder 0700, file 0600). */
export function writeKeyFile(file, { agentKey, baseUrl, agentId = null, name = null }) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify({ key: agentKey, base_url: baseUrl, agent_id: agentId, name, saved_at: new Date().toISOString() }, null, 2)}\n`, { mode: 0o600 });
  try {
    fs.chmodSync(tmp, 0o600);
  } catch {
    // not supported on this system
  }
  fs.renameSync(tmp, file);
}

/**
 * Reads a key file written by writeKeyFile: {key, baseUrl, agentId, name}, or null when it is
 * missing, unreadable, not a key, or readable by others (on systems with permissions), so a key
 * someone else could have written or read is never used. A key is a short lower-case word, _agt_,
 * then 43 characters: keys Aimiru issues now start aimiru_agt_, and one issued before the product's
 * rename keeps its own word and keeps working (ADR-0164). Aimiru, not this shape, decides whether a
 * key is good.
 */
export function readKeyFile(file) {
  try {
    const st = fs.statSync(file);
    if (process.platform !== 'win32' && (st.mode & 0o077) !== 0) return null;
    const v = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!v || typeof v.key !== 'string' || !/^[a-z]{3,12}_agt_[A-Za-z0-9_-]{43}$/.test(v.key)) return null;
    return { key: v.key, baseUrl: typeof v.base_url === 'string' ? v.base_url : null, agentId: v.agent_id ?? null, name: v.name ?? null };
  } catch {
    return null;
  }
}

/**
 * Keeps a request a run started (ADR-0150), so the next run waits on the same code and collects the
 * key Aimiru makes for it even when this run ended first: {base_url, pair_id, poll_secret, code,
 * approve_url, interval_ms, expires_at}, in a file only its owner can read (folder 0700, file 0600).
 */
export function writePendingPairing(file, started) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(
    tmp,
    JSON.stringify({
      base_url: started.baseUrl,
      pair_id: started.pairId,
      poll_secret: started.pollSecret,
      code: started.code,
      approve_url: started.approveUrl,
      interval_ms: started.intervalMs,
      expires_at: started.expiresAt,
    }),
    { mode: 0o600 },
  );
  try {
    fs.chmodSync(tmp, 0o600);
  } catch {
    // not supported on this system
  }
  fs.renameSync(tmp, file);
}

/**
 * The request writePendingPairing kept, or null when there is none, it cannot be read, or others
 * could read or change it (on systems with permissions): only a request this computer's own run
 * kept is waited on again.
 */
export function readPendingPairing(file) {
  try {
    if (process.platform !== 'win32' && (fs.statSync(file).mode & 0o077) !== 0) return null;
    const v = JSON.parse(fs.readFileSync(file, 'utf8'));
    return v && typeof v === 'object' && !Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
}

/** Forgets a kept request (connected, declined, used or run out). */
export function dropPendingPairing(file) {
  try {
    fs.rmSync(file, { force: true });
  } catch {
    // nothing to remove
  }
}

/**
 * The kept request to wait on again, as pairAgent's `resume`: only one for this address that still
 * lasts, or that ran out less than PAIR_KEY_KEPT_MS ago (pairAgent polls that one once more for a
 * key the person's Connect left); else null (a new request starts).
 */
export function resumeFrom(pending, baseUrl, now = Date.now()) {
  if (!pending || pending.base_url !== baseUrl || !pendingLasts(pending, now)) return null;
  if (typeof pending.pair_id !== 'string' || typeof pending.poll_secret !== 'string' || typeof pending.code !== 'string') return null;
  return {
    baseUrl,
    pairId: pending.pair_id,
    pollSecret: pending.poll_secret,
    code: pending.code,
    approveUrl: pending.approve_url,
    intervalMs: Number(pending.interval_ms) || PAIR_INTERVAL_MS,
    expiresAt: Number(pending.expires_at),
  };
}

/**
 * True while a kept request is still worth a poll: within its 10 minutes, or less than
 * PAIR_KEY_KEPT_MS after them. The next run turns to it (its address first) before starting another.
 */
export function pendingLasts(pending, now = Date.now()) {
  return Boolean(pending && typeof pending.base_url === 'string' && typeof pending.pair_id === 'string' && Number(pending.expires_at) + PAIR_KEY_KEPT_MS > now);
}
