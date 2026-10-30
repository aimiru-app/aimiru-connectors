// What the person sees of a job while Codex works on it (ADR-0157): short notes made from the events
// `codex exec --json` prints (openai/codex rust-v0.165.0, codex-rs/exec/src/exec_events.rs), sent to
// Aimiru with the job's id and shown on the terminal, the same lines in both places. At most one every
// 3 s (a burst keeps only its latest), at most 120 a run, each one line of at most 160 characters,
// with secrets taken out by the shared redaction, then email addresses and phone numbers
// (vendor/contacts.mjs; legal, 30 Oct, item 7). Never a command's output, never the model's
// reasoning, never a file's contents.

import path from 'node:path';
import { redactContacts } from '../vendor/contacts.mjs';
import { redactSecrets, truncate } from '../vendor/aimiru-client.mjs';

/** The least time between two notes. */
export const PROGRESS_GAP_MS = 3_000;
/** The most notes one run sends. */
export const PROGRESS_MAX = 120;
/** The longest note. */
export const NOTE_MAX = 160;

/** Untrusted text on one line, secrets taken out, then email addresses and phone numbers, at most max characters. */
function oneLine(text, max = NOTE_MAX) {
  const t = redactSecrets(String(text ?? ''))
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029\p{Cf}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return truncate(redactContacts(t), max);
}

/** A command as Codex runs it, without the shell Codex wraps it in (`/bin/zsh -lc "..."`). */
export function shownCommand(command) {
  const c = String(command ?? '').trim();
  const m = /^(?:\S*\/)?(?:ba|z|da|k)?sh\s+-l?c\s+(["'])([\s\S]*)\1$/.exec(c);
  if (!m) return oneLine(c, 100);
  return oneLine(m[1] === '"' ? m[2].replace(/\\(["\\$`])/g, '$1') : m[2], 100);
}

/** A file Codex changed, as the person knows it: relative to the job's folder when it is inside. */
function shownFile(p, dir) {
  const f = String(p ?? '');
  if (dir && path.isAbsolute(f)) {
    const rel = path.relative(dir, f);
    if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) return rel;
  }
  return f;
}

/**
 * The note one `codex exec --json` event makes, or null. dir: the job's folder.
 * @param {object} ev  one event line, parsed
 */
export function noteForEvent(ev, { dir = null } = {}) {
  if (!ev || typeof ev !== 'object') return null;
  if (ev.type === 'turn.failed') return oneLine(`Codex stopped: ${ev.error?.message ?? 'no reason given'}`);
  if (ev.type === 'error') return oneLine(`Codex had a problem: ${ev.message ?? ''}`);
  if (ev.type !== 'item.started' && ev.type !== 'item.completed') return null;
  const item = ev.item && typeof ev.item === 'object' ? ev.item : {};
  const done = ev.type === 'item.completed';
  switch (item.type) {
    case 'command_execution': {
      const c = shownCommand(item.command);
      if (!c) return null;
      if (!done) return oneLine(`Running ${c}`);
      if (item.status === 'declined') return oneLine(`Not run: ${c}`);
      if (item.status === 'failed' || (Number.isInteger(item.exit_code) && item.exit_code !== 0)) return oneLine(`${c} ended with an error`);
      return oneLine(`Ran ${c}`);
    }
    case 'file_change': {
      if (!done) return null;
      const files = (Array.isArray(item.changes) ? item.changes : []).map((ch) => shownFile(ch?.path, dir)).filter(Boolean);
      if (!files.length) return null;
      const list = `${files.slice(0, 3).join(', ')}${files.length > 3 ? ` and ${files.length - 3} more` : ''}`;
      if (item.status === 'failed') return oneLine(`Could not change ${list}`);
      return oneLine(files.length === 1 ? `Changed ${list}` : `Changed ${files.length} files: ${list}`);
    }
    case 'mcp_tool_call':
      return done ? oneLine(`Used ${item.tool ?? 'a tool'} from ${item.server ?? 'a tool server'}`) : null;
    case 'web_search':
      return done ? oneLine(item.query ? `Searched the web for ${item.query}` : 'Searched the web') : null;
    case 'todo_list': {
      const items = Array.isArray(item.items) ? item.items : [];
      if (!items.length) return null;
      return oneLine(`Plan: ${items.filter((i) => i?.completed === true).length} of ${items.length} done`);
    }
    case 'agent_message': {
      if (!done) return null;
      const first = String(item.text ?? '').split('\n').map((l) => l.trim()).find(Boolean);
      return first ? oneLine(`Codex: ${first}`) : null;
    }
    case 'error':
      return done ? oneLine(`Codex had a problem: ${item.message ?? ''}`) : null;
    default:
      // reasoning, and anything newer: not shown.
      return null;
  }
}

/**
 * The notes of one run: note(line) shows and sends a line now, or keeps it (the latest wins) until 3 s
 * after the last one; close() drops a line still kept inside the gap and waits for the sends.
 * @param {object} o
 * @param {(line: string) => Promise<unknown>} o.send  sends one note to Aimiru (never throws here)
 * @param {(line: string) => void} o.print  shows one note on the terminal
 */
export function createProgress({ send, print, gapMs = PROGRESS_GAP_MS, max = PROGRESS_MAX, now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  let last = -Infinity;
  let pending = null;
  let timer = null;
  let sent = 0;
  const inflight = new Set();
  const emit = (line) => {
    if (sent >= max) return;
    sent += 1;
    last = now();
    try {
      print(line);
    } catch {
      // the terminal went away; the note still goes to Aimiru
    }
    const p = Promise.resolve()
      .then(() => send(line))
      .catch(() => null);
    inflight.add(p);
    p.finally(() => inflight.delete(p));
  };
  return {
    note(line) {
      if (typeof line !== 'string' || !line || sent >= max) return;
      const wait = last + gapMs - now();
      if (wait <= 0 && !timer) {
        emit(line);
        return;
      }
      pending = line;
      if (!timer) {
        timer = setTimer(() => {
          timer = null;
          const l = pending;
          pending = null;
          if (l) emit(l);
        }, Math.max(0, wait));
      }
    },
    async close() {
      if (timer) clearTimer(timer);
      timer = null;
      pending = null;
      await Promise.allSettled([...inflight]);
    },
    get sent() {
      return sent;
    },
  };
}
