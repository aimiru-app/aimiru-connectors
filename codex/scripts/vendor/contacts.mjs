// GENERATED COPY of connectors/shared/contacts.mjs. Do not edit here: edit shared/ and run `node scripts/sync-shared.mjs`.
// Email addresses and phone numbers, found on the computer before anything about a job leaves it
// (legal's read of 30 Oct, item 7).
//
//   hasLongNumber   the import's rule (import-lines.mjs, packages/core hasLongNumber): a phone, card
//                   or account number is 9 digits or more in a run, or 7 or more that are not a
//                   date. The import holds such a line back whole.
//   redactContacts  the same rules made fit for replacing in place, in the runner's notes (a command,
//                   a file, a search) and a job's result: each email address becomes [email] and
//                   each phone number [phone]. Inside commands and summaries a run of digits is more
//                   often something else, so these stay as they are: dates and times (2026-10-30,
//                   2026-10-30 19:55, 30.10.2026, 20261030, 1793300000), version numbers (2.1.312,
//                   react@18.3.1), decimals, IP addresses, years and line ranges (2020-2026,
//                   1200-1340), numbers inside a word, a path or an id, and a run of 7 or 8 digits
//                   alone (a short commit id or a count). A git remote's git@host is no one's
//                   address.
//
// Run after the shared redaction (aimiru-client.mjs redactSecrets), so keys and card numbers are
// already out. Never used on what Aimiru checks step by step: that is unchanged.
// Claude Code and Codex carry a copy (TARGET_ONLY_FILES in scripts/sync-shared.mjs).

export const EMAIL_MARK = '[email]';
export const PHONE_MARK = '[phone]';

/** A date is no number to keep out: 2026-10-24, 24.10.2026, 10/24/26 (packages/core DATE_SHAPE). */
export const DATE_SHAPE = /^(?:\d{4}[-./]\d{1,2}[-./]\d{1,2}|\d{1,2}[-./]\d{1,2}[-./]\d{2,4})$/;
/** A run of digits, spaces, dots, dashes and brackets (packages/core hasLongNumber). */
const NUMBER_RUN = /[+\d][\d\s().-]{4,}\d/g;
/** As many digits as make a phone, card or account number in any run, and in a run that is not a date. */
export const LONG_DIGITS = 9;
export const SHORT_DIGITS = 7;

/** A phone, card or account number: 9 digits or more in a run, or 7 or more that are not a date (packages/core hasLongNumber). */
export function hasLongNumber(text) {
  for (const m of String(text ?? '').matchAll(NUMBER_RUN)) {
    const digits = (m[0].match(/\d/g) || []).length;
    if (digits >= LONG_DIGITS || (digits >= SHORT_DIGITS && !DATE_SHAPE.test(m[0].trim()))) return true;
  }
  return false;
}

/**
 * An email address: a name, @, and a domain whose last part is letters (so pkg@1.2.3 is a version).
 * The name is at most 64 characters, as an address's may be, which keeps a long text quick to read.
 */
const EMAIL = /[\p{L}\p{N}_.%+-]{1,64}@(?:[\p{L}\p{N}](?:[\p{L}\p{N}-]{0,61}[\p{L}\p{N}])?\.)+\p{L}{2,24}(?![\p{L}\p{N}_-])/gu;
/** git@github.com:org/repo and the like: a remote, never a person. */
const GIT_REMOTE = /^git@/i;

/**
 * NUMBER_RUN in place: never inside a word, a path or an id (nothing of one just before or after),
 * one space at most between groups and never a line break, a bracket only around a group, and at
 * most 32 characters, as long as a written phone number gets.
 */
const PHONE_RUN = /(?<![\p{L}\p{N}_/+]|[\p{L}\p{N}_][.-])(?:\+|\(\+?(?=\d{1,5}\)))?\d(?:[\d().-]|[ \t](?=[\d(])){4,30}\d(?![\p{L}\p{N}_/]|[.:-][\p{L}\p{N}_])/gu;
/** A date stamp written solid: 20261030, 2026103019, 202610301955, 20261030195500. */
const STAMP = /^(?:19|20)\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])(?:(?:[01]\d|2[0-3])(?:[0-5]\d){0,2})?$/;
/** A time in seconds or milliseconds since 1970 (2001 to 2033): ten or thirteen digits that start with 1. */
const EPOCH = /^1(?:\d{9}|\d{12})$/;
const DECIMAL = /^\d+\.\d+$/;
const IPV4 = /^\d{1,3}(?:\.\d{1,3}){3}$/;
/** Two years, or two line numbers, joined: 2020-2026, 1200-1340. */
const RANGE = /^(\d{4})-(\d{4})$/;
/** The most digits a phone number has (E.164). */
const PHONE_DIGITS_MAX = 15;

/** Whether a run PHONE_RUN found is a phone number. */
function isPhone(run) {
  const digits = run.replace(/\D/g, '').length;
  if (digits < SHORT_DIGITS || digits > PHONE_DIGITS_MAX) return false;
  if (/^\d+$/.test(run)) return digits >= LONG_DIGITS && !STAMP.test(run) && !EPOCH.test(run);
  if (/^\(?\+/.test(run)) return true;
  if (DATE_SHAPE.test(run) || DECIMAL.test(run) || IPV4.test(run)) return false;
  const range = RANGE.exec(run);
  if (range && Number(range[1]) <= Number(range[2])) return false;
  return true;
}

/**
 * Text with each email address as [email] and each phone number as [phone]; anything else as it was.
 * null and undefined come back as they are, like redactSecrets.
 */
export function redactContacts(text) {
  if (text == null) return text;
  let s = String(text);
  if (s.includes('@')) s = s.replace(EMAIL, (m) => (GIT_REMOTE.test(m) ? m : EMAIL_MARK));
  return s.replace(PHONE_RUN, (m) => (isPhone(m) ? PHONE_MARK : m));
}
