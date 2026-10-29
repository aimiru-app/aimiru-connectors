// aimiru-codex remember "<one plain line>" [--topic <topic>] [--how <noticed|instructions>] (ADR-0157): Codex suggests one line about
// the person it noticed, for Aimiru to keep. Codex has none of Aimiru's tools, so this is how its
// lines reach memory_propose (POST /v1/memory, CONTRACT.md), with Codex's own key. Aimiru reads the
// line first and refuses instructions, permissions, links, secrets and anything long; a line it takes
// is learned (used for the person's own jobs, kept for good once the person says so) or waits for the
// person. One plain sentence says which. A line holding a secret never leaves the computer, and a
// line Aimiru did not take is never kept here to send later.
//
// Codex's own check reads this command like any other (the live check is not changed for it).

import { redactSecrets } from '../vendor/sayso-client.mjs';
import { PACKAGE_NAME, loadSettings, makeClient } from './runtime.mjs';
import { JOB_WORDS } from './words.mjs';

/** The topics a line from Codex can have: the ones a brief carries (packages/core BRIEF_TOPICS). */
export const REMEMBER_TOPICS = Object.freeze(['name', 'style', 'values', 'preference', 'schedule']);
/** How Codex came by the line: noticed in its work, or from its own instructions or memory. */
export const REMEMBER_HOWS = Object.freeze(['noticed', 'instructions']);
/** The longest line sent (Aimiru keeps 120 characters and says so above that). */
export const REMEMBER_MAX = 400;
// No tag and no version in a line the person types (Rohit, 29 Oct 23:50).
const INSTALL = `npx ${PACKAGE_NAME} init`;

/** Aimiru's own sentence from an answer, on one line, at most 300 characters. */
function said(r) {
  const m = String(r?.message ?? '')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029\p{Cf}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return m.slice(0, 300);
}

/**
 * @param {object} o
 * @param {string} o.line  the line, as given
 * @param {string|null} [o.topic]
 * @param {string|null} [o.how] noticed or instructions
 * @param {object} [o.env] @param {(s: string) => void} [o.print]
 * @returns {Promise<number>} 0 when Aimiru took the line, 1 when it did not, 2 for a line or topic that cannot be sent
 */
export async function remember(o = {}) {
  const env = o.env || process.env;
  const print = o.print || ((s) => process.stdout.write(`${s}\n`));
  const text = String(o.line ?? '').trim();
  const topic = typeof o.topic === 'string' && o.topic.trim() ? o.topic.trim().toLowerCase() : null;
  const how = typeof o.how === 'string' && o.how.trim() ? o.how.trim().toLowerCase() : null;
  if (!text) {
    print(JOB_WORDS.rememberEmpty);
    return 2;
  }
  if (topic !== null && !REMEMBER_TOPICS.includes(topic)) {
    print(JOB_WORDS.rememberTopic(REMEMBER_TOPICS.join(', ')));
    return 2;
  }
  if (how !== null && !REMEMBER_HOWS.includes(how)) {
    print(JOB_WORDS.rememberHow(REMEMBER_HOWS.join(' or ')));
    return 2;
  }
  if (text.length > REMEMBER_MAX) {
    print(JOB_WORDS.rememberTooLong);
    return 1;
  }
  // A secret never leaves the computer, not even to be refused.
  if (redactSecrets(text) !== text) {
    print(JOB_WORDS.rememberRefused('It holds what looks like a secret, so it was not sent.'));
    return 1;
  }
  const settings = loadSettings(env);
  if (!settings.token || !settings.baseUrl) {
    print(JOB_WORDS.rememberNoKey(INSTALL));
    return 1;
  }
  const client = makeClient(settings, { spool: false });
  const r = await client.memoryPropose({ text, topic, how }, { timeoutMs: 10_000 });
  if (r.ok) {
    const state = r.data?.state;
    print(state === 'kept' ? JOB_WORDS.rememberKept : state === 'learned' ? JOB_WORDS.rememberLearned : JOB_WORDS.rememberWaiting);
    return 0;
  }
  if (r.kind === 'http' && r.fromSayso !== false) {
    if ([409, 422, 429].includes(r.status) && said(r)) {
      print(JOB_WORDS.rememberRefused(said(r)));
      return 1;
    }
    if (r.status === 403 || r.status === 404) {
      print(JOB_WORDS.rememberNotOpen);
      return 1;
    }
    if (r.status === 423) {
      print(JOB_WORDS.rememberPaused);
      return 1;
    }
    if (r.status === 401) {
      print(r.code === 'demo_ended' ? client.demoEndedText : JOB_WORDS.rememberReconnect(INSTALL));
      return 1;
    }
  }
  print(JOB_WORDS.rememberUnreachable);
  return 1;
}
