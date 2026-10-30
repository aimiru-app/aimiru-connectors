// GENERATED COPY of connectors/shared/import-lines.mjs. Do not edit here: edit shared/ and run `node scripts/sync-shared.mjs`.
// What the person's agent already knows about them, brought into Aimiru (ADR-0162; design_draft D2,
// "both": the agent's own files first, with the person's OK, on the computer, each line with its
// source; then what the agent says it knows, at its first brief).
//
//   importSources   the files an import reads, and only those (Claude Code: the person's CLAUDE.md,
//                   the project's CLAUDE.md, Claude Code's own notes on the project; Codex: the
//                   person's AGENTS.md and the project's)
//   pickLines       reads them (regular files only, never through a link) and picks short facts
//                   about the person, each with its source; code, commands, paths, links, lines
//                   spoken to the agent, permissions, lines about someone else, and anything shaped
//                   like a key, a password or an address are left out, and those last are never shown
//   sendLines       sends each through memory_propose (POST /v1/memory) with how=instructions, and
//                   stops at the first answer that says the rest cannot go now
//   import state    <data>/import.json, owner-only: whether the person was asked, the lines shown and
//                   waiting for their choice (30 minutes at most), and a fingerprint (sha256 of the
//                   folded words, never the words) of every line sent, so a later import sends only
//                   what is new and never brings back a line the person removed in Aimiru
//
// Aimiru reads every line again with its line rules (packages/core normaliseMemoryLine): keys first,
// instructions, links, numbers and secrets refused, private lines waiting for the person. This file
// only keeps the obvious out before anything leaves the computer.

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
// A phone, card or account number (contacts.mjs, which the runner's notes and results use too).
import { hasLongNumber } from './contacts.mjs';
import { redactSecrets } from './aimiru-client.mjs';

/** The most lines one import sends: also the most one agent may add to Memory in a day. */
export const IMPORT_MAX = 30;
/** The longest line Aimiru keeps (packages/core MEMORY_LIMITS.text). */
export const LINE_MAX = 120;
/** A file larger than this is not read. */
export const FILE_MAX_BYTES = 256 * 1024;
/** The most notes read from Claude Code's notes folder. */
export const NOTES_MAX = 40;
/** How long the lines shown wait for the person's choice. */
export const PENDING_MS = 30 * 60_000;
const STATE_FILE = 'import.json';

/** The question asked once, before anything is read (ADR-0162). */
export function importQuestion(agent) {
  return `Bring in what ${agent} already knows about you? It reads these files on this computer, shows you the lines, and sends only the ones you keep.`;
}

// ---------------------------------------------------------------------------
// Which files

function homeOf(env) {
  return env.HOME || env.USERPROFILE || os.homedir();
}

/** Claude Code's settings folder: CLAUDE_CONFIG_DIR when set, else ~/.claude. */
function claudeDir(env) {
  return env.CLAUDE_CONFIG_DIR ? path.resolve(env.CLAUDE_CONFIG_DIR) : path.join(homeOf(env), '.claude');
}

/** The folder name Claude Code keeps a project's notes under: every character not a letter or a digit becomes "-". */
export function claudeProjectKey(dir) {
  return path.resolve(dir).replace(/[^A-Za-z0-9]/g, '-');
}

/**
 * The files an import reads, and only those, each with its source in plain words.
 * @param {{agent: 'claude-code'|'codex', env?: object, projectDir?: string}} o
 * @returns {Array<{key: string, source: string, dir?: string, file?: string}>}
 */
export function importSources({ agent, env = process.env, projectDir = process.cwd() }) {
  const project = path.resolve(projectDir);
  if (agent === 'codex') {
    const codexHome = env.CODEX_HOME || path.join(homeOf(env), '.codex');
    return [
      { key: 'own', source: 'your instructions for Codex', file: path.join(codexHome, 'AGENTS.md') },
      { key: 'project', source: "this project's instructions", file: path.join(project, 'AGENTS.md') },
    ];
  }
  const base = claudeDir(env);
  return [
    { key: 'own', source: 'your instructions for Claude Code', file: path.join(base, 'CLAUDE.md') },
    { key: 'project', source: "this project's instructions", file: path.join(project, 'CLAUDE.md') },
    { key: 'notes', source: "Claude Code's own notes on this project", dir: path.join(base, 'projects', claudeProjectKey(project), 'memory') },
  ];
}

// Opened without following a link and without waiting on a pipe, where the system has the flags.
const OPEN_FLAGS = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0);

/**
 * A regular file's text, or null (missing, a link, not a regular file, too large, unreadable). A
 * link is never followed (the security review of 29 Oct): a project's CLAUDE.md that links to any
 * file the person can read would otherwise show that file's lines as the project's instructions.
 * Checked before it is opened, opened without following a link, and checked again once open.
 */
function readSmall(file) {
  let fd = null;
  try {
    const st = fs.lstatSync(file);
    if (!st.isFile() || st.size > FILE_MAX_BYTES) return null;
    fd = fs.openSync(file, OPEN_FLAGS);
    const open = fs.fstatSync(fd);
    if (!open.isFile() || open.size > FILE_MAX_BYTES || open.ino !== st.ino || open.dev !== st.dev) return null;
    return fs.readFileSync(fd, 'utf8');
  } catch {
    return null;
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {
        // Closed already.
      }
    }
  }
}

/** A note's front matter (between --- lines at its top) and the text after it. */
export function splitFrontMatter(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  if (!m) return { meta: {}, body: text };
  const meta = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(line);
    if (kv) meta[kv[1].toLowerCase()] = kv[2].trim().replace(/^["']|["']$/g, '');
  }
  return { meta, body: text.slice(m[0].length) };
}

/** Notes about the project or a reference are not about the person. */
const NOTE_TYPES_LEFT_OUT = new Set(['project', 'reference']);

/**
 * The notes an import reads from a notes folder, by name: regular files only, never its index, at
 * most NOTES_MAX. A folder or a note reached through a link is never read.
 */
function notesIn(dir) {
  try {
    if (!fs.lstatSync(dir).isDirectory()) return [];
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isFile() && d.name.toLowerCase().endsWith('.md') && d.name !== 'MEMORY.md')
      .map((d) => d.name)
      .sort()
      .slice(0, NOTES_MAX);
  } catch {
    return [];
  }
}

/** Whether a file is one an import would read (a regular file, not a link, small enough), without reading it. */
function readable(file) {
  try {
    const st = fs.lstatSync(file);
    return st.isFile() && st.size <= FILE_MAX_BYTES;
  } catch {
    return false;
  }
}

/** The files an import would read that are on this computer, without reading any: for the question. */
export function presentSources({ agent, env = process.env, projectDir = process.cwd() }) {
  return importSources({ agent, env, projectDir }).map((src) => ({
    ...src,
    files: src.file ? (readable(src.file) ? [src.file] : []) : notesIn(src.dir).map((n) => path.join(src.dir, n)).filter(readable),
  }));
}

/** Reads one source: its texts, and the files actually read. */
function readSource(src) {
  if (src.file) {
    const text = readSmall(src.file);
    // Front matter is a file's settings ("name: ..."), never a fact about the person.
    return text === null ? { texts: [], read: [] } : { texts: [splitFrontMatter(text).body], read: [src.file] };
  }
  const names = notesIn(src.dir);
  if (names.length === 0) return { texts: [], read: [] };
  const texts = [];
  const read = [];
  for (const name of names) {
    const file = path.join(src.dir, name);
    const raw = readSmall(file);
    if (raw === null) continue;
    read.push(file);
    const { meta, body } = splitFrontMatter(raw);
    if (NOTE_TYPES_LEFT_OUT.has(String(meta.type || '').toLowerCase())) continue;
    texts.push(body);
  }
  return { texts, read };
}

// ---------------------------------------------------------------------------
// Picking lines

// A run a key is made of (packages/core memory.ts carriesKey): 24 or more of these, with a letter and a digit.
const KEY_RUN = /[A-Za-z0-9_+/=-]{24,}/g;
// eslint-disable-next-line no-control-regex
const INVISIBLE = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f­​-‏‪-‮⁠-⁩﻿]/g;
// A password by any name, or the words that unlock an account or a wallet (packages/core SECRET_WORDS).
const SECRET_WORDS =
  /\b(passwords?|passcodes?|passwd|pass ?phrases?|pin|otp|cvv|cvc|ssn|iban|routing number|account number|api key|secret|private key|log-?ins?|credentials?|seed (?:words?|phrases?)|recovery (?:codes?|phrases?|words?|keys?)|backup codes?|mnemonic)\b/i;
// A street address or a postcode, which belong in Vault, never Memory (packages/core STREET and
// POSTCODE), and a home given by its number ("Lives at 12", "flat 4B").
const STREET =
  /\b\d{1,5}[A-Za-z]?,?\s+(?:\p{Lu}[\p{L}\p{M}'.-]*\s+){1,4}(?:[Ss]treet|St|[Rr]oad|Rd|[Aa]venue|Ave|[Ll]ane|Ln|[Dd]rive|[Bb]oulevard|Blvd|[Hh]ighway|Hwy|[Pp]arkway|Pkwy|Marg|Nagar)\b/u;
const POSTCODE = /\b(?:[A-Z]{1,2}\d[A-Z\d]?\s?\d[A-Z]{2}|[A-Z]{2}\s\d{5}(?:-\d{4})?)\b/;
const HOME_NUMBER = /\b(?:(?:lives?|living|stays?|staying)\s+at\s+\d|(?:flat|apartment|apt|unit|suite|house|door|plot)\s*(?:no\.?|number|#)?\s*\d)/i;
const MARKUP = /[<>{}[\]`\\|]/;
const LINK = /(\b[a-z][a-z0-9+.-]*:\/\/|\bwww\.|\b[a-z0-9-]+\.(com|net|org|io|app|ai|co|in|uk|dev|me|ly|xyz|info|biz|link|site|shop)\b)/i;
const PATHLIKE =
  /(^|[\s("'])(~|\.{1,2})?\/[\w.~-]|\S+\/\S+\/\S+|\b(?:[a-z0-9_-]+|[A-Z0-9_-]{3,})\.(md|mdx|ts|tsx|js|jsx|mjs|cjs|json|jsonc|toml|yaml|yml|sh|zsh|py|rb|rs|go|java|kt|swift|txt|lock|env|sql|css|scss|html|xml|ini|cfg|conf|plist)\b/;
const COMMAND = /^(\$|>|sudo|npm|npx|bun|bunx|pnpm|yarn|git|node|deno|python3?|pip3?|cargo|make|docker|kubectl|curl|wget|brew|cd|ls|rm|mv|cp|cat|grep|rg|sed|awk|chmod|chown|export|echo|ssh|scp|gh)\s/i;
const SHELLISH = /(\s--?[a-z][\w-]*|&&|\|\||\b[A-Z][A-Z0-9_]{2,}=|\w\(\))/;
// Words for the person's permissions, or Aimiru itself (packages/core PERMISSION_TALK and INSTRUCTION).
const PERMISSION_TALK =
  /\b(aimiru|approv\w*|permission\w*|bypass\w*|force[- ]?push\w*|authori[sz]\w*|pre-?approv\w*|unlimited|spending limit|spend limit|spending cap|spend cap|unasked|unprompted|unreviewed|unattended|dangerously|yolo|auto-?(?:approv|accept|merg|deploy|publish)\w*)\b|\bbudget\s+(is|of|for|limit|cap|up to)\b|\b(pay|spend|buy)\s+up\s+to\b/i;
/**
 * A step said to happen with no look from the person: a standing permission dressed as a preference
 * ("Prefers deletes to run unasked", "Prefers that payments under 500 go through", "Prefers
 * publishing without waiting"). Learned, it would reach every agent's brief as if the person had
 * said yes once for all (the security review of 29 Oct).
 */
const UNATTENDED = [
  /\bskips?\s+(?:the\s+|a\s+|any\s+|every\s+)?(?:reviews?|checks?|confirmations?|tests?|look)\b/i,
  /\bwithout\s+(?:a\s+|any\s+|my\s+)?(?:reviews?|reviewing|look|looking|waiting|asking|checks?|checking|confirm\w*|tests?|testing)\b/i,
  /\b(?:payments?|purchases?|charges?|orders?|transfers?|refunds?|deletes?|deletions?|deploys?|deployments?|releases?|publish\w*|merges?|pushes|installs?|spend\w*)\b.*\b(?:go(?:es)?\s+(?:ahead|through|straight)|run\s+(?:on\s+(?:its|their)\s+own|by\s+(?:it|them)sel(?:f|ves)|freely)|happen\s+(?:on\s+(?:its|their)\s+own|automatically)|automatically)\b/i,
  /\b(?:payments?|purchases?|charges?|orders?|transfers?|refunds?|spend\w*)\s+(?:under|below|up\s+to|less\s+than|of\s+up\s+to)\b/i,
];
/**
 * A line about someone else: a relation ("my wife", "my patient", "colleagues"), or a person's name
 * after with, by, or report to ("Works with Priya Sharma"). Aimiru holds such a line for the
 * person's OK; the import leaves it on the computer. A name that is a tool ("TypeScript", "AWS")
 * is no one: a capital inside a word, or all capitals.
 */
const RELATION =
  /\b(wife|wives|husband|spouse|fianc[eé]e?|girlfriends?|boyfriends?|sons?|daughters?|kids?|children|child|mother|father|mom|mum|dad|parents?|brothers?|sisters?|siblings?|cousins?|aunts?|uncles?|nephews?|nieces?|grand(?:mother|father|ma|pa|parents?|kids?|children|sons?|daughters?)|in-laws?|co-?founders?|roommates?|flatmates?|colleagues?|co-?workers?|team ?mates?|patients|friends?)\b/i;
const MY_PERSON =
  /\b(my|our|his|her|their)\s+(partner|boss|manager|lead|clients?|customers?|doctor|patient|team|family|neighbou?rs?|landlord|landlady|tenants?|nanny|students?|employees?|reports|mentor|coach|baby|babies)\b/i;
const NAMED_PERSON =
  /(?:\b(?:with|alongside|by)\s+|\b(?:reports?|reporting|married|engaged|talks?|talking|cares?|caring|cooks?|cooking)\s+(?:to|for)\s+)(?:(?:my|our)\s+[a-z]+\s+)?\p{Lu}\p{Ll}+(?:\s+\p{Lu}\p{Ll}+)?\b/u;
/** Spoken to the agent, or shaped like a permission: never a fact about the person, before or after shaping. */
const INSTRUCTION = [
  /\b(ignore|disregard)\s+(all|any|the|your|previous|prior|above|earlier|every)\b/i,
  /\b(instructions?|prompt|jailbreak)\b/i,
  /\b(system|assistant|developer|user)\s*:/i,
  /\b(you|your|yours|yourself|agents?|assistants?|bots?)\b/i,
  /\b(no need to|without|don'?t|do not|never)\s+(ask|asking|check|checking|confirm|confirming)\b/i,
  /\b(allowed|permitted|free|cleared)\s+to\b/i,
];
/** An order as a line opens ("Always use bun"): read after shaping, so "I always use bun" is a fact. */
const ORDER = /^(always|never|only)\s+(?!(?:prefers|likes|loves|enjoys|uses|works|lives|speaks|wants|needs|hates|dislikes|avoids|wakes|sleeps|reads|writes|travels|codes|builds|ships|tests|plans|starts|keeps|goes)\b)[a-z]+/i;
/** Opening words that give the agent an order: an instruction, never a fact about the person. */
const IMPERATIVE =
  /^(always|never|do|don'?t|dont|use|run|make|keep|avoid|ensure|check|read|write|add|create|follow|remember|ask|note|see|try|put|set|update|commit|push|test|build|deploy|install|edit|open|start|stop|refer|treat|apply|return|give|show|tell|say|reply|respond|answer|explain|include|skip|ignore|prefix|end|begin|wrap|format|must|should|only|when|if|before|after|prefer to|be sure|make sure|please)\b/i;

/**
 * Third-person words a fact about the person opens with, after an adverb or not. Only words that
 * are no noun as well ("Tests ship with the change" is about a project, not a person): the rest come
 * in only from a sentence that says I (THIRD_PERSON).
 */
const FACT_OPENERS =
  /^(?:(?:always|usually|often|mostly|rarely|never|sometimes|generally|mainly)\s+)?(prefers|likes|loves|enjoys|uses|works|lives|speaks|wants|needs|hates|dislikes|avoids|values|cares about|believes|goes by|based in|wakes|sleeps|is a|is an|is based)\b/i;

/** "I prefer" to "Prefers": the verbs a first-person line may open with. */
const THIRD_PERSON = {
  prefer: 'prefers',
  like: 'likes',
  love: 'loves',
  enjoy: 'enjoys',
  use: 'uses',
  work: 'works',
  live: 'lives',
  speak: 'speaks',
  want: 'wants',
  need: 'needs',
  hate: 'hates',
  dislike: 'dislikes',
  avoid: 'avoids',
  wake: 'wakes',
  sleep: 'sleeps',
  read: 'reads',
  write: 'writes',
  travel: 'travels',
  code: 'codes',
  build: 'builds',
  ship: 'ships',
  test: 'tests',
  plan: 'plans',
  start: 'starts',
  keep: 'keeps',
  value: 'values',
  care: 'cares',
  believe: 'believes',
  go: 'goes',
};
const ADVERBS = new Set(['always', 'usually', 'often', 'mostly', 'generally', 'rarely', 'sometimes', 'never', 'really', 'strongly', 'mainly']);

const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
const tidy = (s) => s.replace(/\s+/g, ' ').trim().replace(/[.;,:]+$/, '').trim();

/** A labelled fact ("Name: Ro") as a line, when its label is about the person. */
function labelled(text) {
  const m = /^(name|preferred name|nickname|pronouns|time ?zone|timezone|location|city|based in|home city|role|job|title|languages?|editor|shell|os|operating system|working hours|hours|diet)\s*[:=]\s*(.+)$/i.exec(text);
  if (!m) return null;
  const label = m[1].toLowerCase().replace(/\s+/g, ' ');
  const value = tidy(m[2]);
  if (!value) return null;
  if (['name', 'preferred name', 'nickname'].includes(label)) return { text: `Goes by ${value}`, topic: 'name' };
  if (label === 'pronouns') return { text: `Pronouns: ${value}`, topic: 'name' };
  if (label === 'time zone' || label === 'timezone') return { text: `Time zone: ${value}`, topic: 'schedule' };
  if (['location', 'city', 'based in', 'home city'].includes(label)) return { text: `Based in ${value}`, topic: 'place' };
  if (['role', 'job', 'title'].includes(label)) return { text: `Role: ${value}`, topic: null };
  if (label === 'language' || label === 'languages') return { text: `Speaks ${value}`, topic: 'preference' };
  if (['editor', 'shell', 'os', 'operating system'].includes(label)) return { text: `Uses ${value}`, topic: 'preference' };
  if (label === 'working hours' || label === 'hours') return { text: `Works ${value}`, topic: 'schedule' };
  return { text: `Diet: ${value}`, topic: null };
}

/**
 * A line in a plain fact shape the import may rewrite, or the words as they are when already a fact.
 * A project's own file speaks of the project ("Uses Postgres"), so from it only a sentence with the
 * person as its subject comes in (personal false): I, my, call me, be.
 */
function factShape(text, personal) {
  let m;
  // "Call me Ro", "My name is Ro", "I go by Ro", "People call me Ro"
  if ((m = /^(?:please\s+)?call\s+me\s+([\p{L}][\p{L}\p{M}.' -]{0,40})$/iu.exec(text))) return { text: `Goes by ${tidy(m[1])}`, topic: 'name' };
  if ((m = /^(?:my\s+name\s+is|my\s+name'?s|i'?m\s+called|i\s+go\s+by|people\s+call\s+me)\s+([\p{L}][\p{L}\p{M}.' -]{0,40})$/iu.exec(text))) return { text: `Goes by ${tidy(m[1])}`, topic: 'name' };
  if ((m = /^my\s+(pronouns|time ?zone|timezone)\s+(?:is|are)\s+(.+)$/i.exec(text))) return labelled(`${m[1]}: ${m[2]}`);
  // "Be brief", "Be direct and short" (packages/core memoryFactSuggestion's shape)
  if ((m = /^(?:please\s+)?(?:always\s+)?be\s+([a-z][a-z-]*(?:(?:\s+and\s+|,\s*|\s+)(?!with\b)[a-z][a-z-]*){0,2})(?:\s+with\s+me)?$/i.exec(text))) {
    return { text: `Prefers ${m[1].toLowerCase()} answers`, topic: 'style' };
  }
  // "Prefer X over Y": a preference said as an order, said as a fact.
  if (personal && (m = /^prefer\s+(.+)$/i.exec(text)) && !/^to\b/i.test(m[1])) return { text: `Prefers ${m[1]}`, topic: null };
  // "The user prefers X", "User likes X": how Claude Code's own notes speak of the person.
  // In a project's file, "the user" is the project's users, never the person.
  if (personal && (m = /^(?:the\s+)?(?:user|person|human)\s+(.+)$/i.exec(text)) && FACT_OPENERS.test(m[1])) return { text: cap(m[1]), topic: null };
  // "I prefer X", "I always want X", "I'm a designer", "I'm based in Pune"
  if ((m = /^i'?m\s+based\s+in\s+(.+)$/i.exec(text)) || (m = /^i\s+am\s+based\s+in\s+(.+)$/i.exec(text))) return { text: `Based in ${m[1]}`, topic: 'place' };
  if ((m = /^(?:i'?m|i\s+am)\s+(an?\s+.+)$/i.exec(text))) return { text: `Is ${m[1]}`, topic: null };
  if ((m = /^i\s+(.+)$/i.exec(text))) {
    const words = m[1].split(' ');
    const adverb = ADVERBS.has(words[0].toLowerCase()) ? words.shift().toLowerCase() : null;
    const verb = THIRD_PERSON[(words[0] || '').toLowerCase()];
    if (!verb) return null;
    words[0] = verb;
    return { text: cap([adverb, ...words].filter(Boolean).join(' ')), topic: null };
  }
  if (personal && FACT_OPENERS.test(text)) return { text, topic: null };
  return personal ? labelled(text) : null;
}

const NAME_WORDS = /^(goes by|pronouns)\b/i;
const VALUE_WORDS = /\b(matters?|cares? about|values|believes?|important to)\b/i;
const STYLE_WORDS =
  /\b(answers?|responses?|replies|reply|tone|concise|brief|terse|blunt|direct|verbose|detailed|explanations?|explain\w*|emojis?|jargon|formal|casual|plain english|bullets?|summar(?:y|ies)|wording|writing|dashes|short|long)\b/i;
const SCHEDULE_WORDS =
  /\b(time ?zone|ist|pst|pdt|est|edt|cet|bst|utc|gmt|mornings?|evenings?|nights?|weekends?|weekdays?|mondays?|tuesdays?|wednesdays?|thursdays?|fridays?|saturdays?|sundays?|am|pm|hours|o'?clock|late|early|deadlines?)\b/i;
const PREFERENCE_OPENERS = /^(prefers|likes|loves|enjoys|uses|wants|needs|hates|dislikes|avoids|speaks|usually|always|often|mostly|rarely)\b/i;

/** The topic a line is sent with (packages/core MEMORY_TOPICS), or null for Aimiru to read one. */
export function topicOf(text, given = null) {
  if (given === 'name' || NAME_WORDS.test(text)) return 'name';
  if (VALUE_WORDS.test(text)) return 'values';
  if (given === 'place' || /^based in\b|^lives in\b/i.test(text)) return 'place';
  if (STYLE_WORDS.test(text) && PREFERENCE_OPENERS.test(text)) return 'style';
  if (given === 'style') return 'style';
  if (given === 'schedule' || SCHEDULE_WORDS.test(text)) return 'schedule';
  if (given === 'preference' || PREFERENCE_OPENERS.test(text)) return 'preference';
  return given;
}

/** Whether words hold what looks like a key, as a reader sees them. */
export function looksLikeKey(text) {
  const seen = String(text).normalize('NFKC').replace(INVISIBLE, '');
  if (redactSecrets(seen) !== seen) return true;
  for (const [run] of seen.matchAll(KEY_RUN)) {
    if (/[A-Za-z]/.test(run) && /\d/.test(run)) return true;
  }
  return false;
}

/**
 * One sentence as a line the import may send, or why it is left out:
 * key (a key, a password, a long number, a street address or postcode: never shown), code (code, a
 * command, a path, a link), instruction (spoken to the agent, an order, a permission), person (about
 * someone else), other (not a short fact about the person). personal: false for a project's own
 * file (factShape).
 * @returns {{ok: true, text: string, topic: string|null} | {ok: false, why: 'key'|'code'|'instruction'|'person'|'other'}}
 */
export function shapeLine(raw, { personal = true } = {}) {
  const said = String(raw ?? '');
  if (looksLikeKey(said)) return { ok: false, why: 'key' };
  const text = tidy(said.normalize('NFKC').replace(INVISIBLE, '').replace(/[\u2018\u2019]/g, "'"));
  if (!text) return { ok: false, why: 'other' };
  // Nothing this long can become a line (LINE_MAX), so no word rule reads it: one long line in a
  // project's file must not hold the import up (some rules below look across the whole sentence).
  if (text.length > LINE_MAX * 2) return { ok: false, why: 'other' };
  if (SECRET_WORDS.test(text) || text.includes('@') || hasLongNumber(text) || STREET.test(text) || POSTCODE.test(text) || HOME_NUMBER.test(text)) return { ok: false, why: 'key' };
  if (MARKUP.test(text) || LINK.test(text) || PATHLIKE.test(text) || COMMAND.test(text) || SHELLISH.test(text)) return { ok: false, why: 'code' };
  if (asPermission(text)) return { ok: false, why: 'instruction' };
  if (RELATION.test(text) || MY_PERSON.test(text) || NAMED_PERSON.test(text)) return { ok: false, why: 'person' };
  const shaped = factShape(text, personal);
  if (!shaped) return { ok: false, why: IMPERATIVE.test(text) ? 'instruction' : 'other' };
  const line = tidy(shaped.text);
  const words = line.split(' ').length;
  if (line.length > LINE_MAX || words < 2 || words > 22) return { ok: false, why: 'other' };
  if (ORDER.test(line) || asPermission(line)) return { ok: false, why: 'instruction' };
  return { ok: true, text: line, topic: topicOf(line, shaped.topic) };
}

/** Spoken to the agent, or a permission however it is dressed. */
function asPermission(text) {
  return PERMISSION_TALK.test(text) || INSTRUCTION.some((re) => re.test(text)) || UNATTENDED.some((re) => re.test(text));
}

/**
 * The sentences a file's text offers, with how many code blocks and other skipped lines it held.
 * Headings, tables, quotes, comments, imports and indented code are skipped; a list item's marker
 * and bold or italic marks are taken off; a long line is split into its sentences.
 */
export function sentencesOf(text) {
  const out = [];
  let code = 0;
  let inFence = false;
  const body = String(text).replace(/\r\n?/g, '\n').replace(/<!--[\s\S]*?-->/g, '');
  for (const rawLine of body.split('\n')) {
    if (/^\s*(```|~~~)/.test(rawLine)) {
      if (!inFence) code += 1;
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    if (!rawLine.trim()) continue;
    const listItem = /^\s*([-*+]|\d+[.)])\s+/.test(rawLine);
    if (!listItem && /^(\t| {4,})/.test(rawLine)) {
      code += 1;
      continue;
    }
    let line = rawLine.trim();
    if (/^(#|\||>|@|<|---|===|\*\*\*)/.test(line)) continue;
    line = line
      .replace(/^([-*+]|\d+[.)])\s+/, '')
      .replace(/^\[[ xX]\]\s+/, '')
      .replace(/(\*\*|__)(.+?)\1/g, '$2')
      .replace(/(^|[\s(])[*_]([^*_\s][^*_]*?)[*_](?=[\s).,;:!?]|$)/g, '$1$2')
      .trim();
    if (!line) continue;
    // One sentence per line kept: "I'm Ro. I prefer short answers." gives two.
    for (const s of line.split(/(?<=[.!?])\s+(?=[A-Z])/)) if (s.trim()) out.push(s.trim());
  }
  return { sentences: out, code };
}

/** The words of a line folded the way Aimiru compares two copies of a fact (packages/core foldMemoryWords). */
export function foldWords(text) {
  return String(text)
    .normalize('NFKC')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
    .replace(/[.!]+$/u, '')
    .trimEnd();
}

/** The fingerprint the computer keeps of a line it sent: a hash of the folded words, never the words. */
export function lineFingerprint(text) {
  return createHash('sha256').update(foldWords(text)).digest('hex');
}

/**
 * Reads the import's files and picks the lines: at most IMPORT_MAX, in the order of the sources,
 * each once, none sent before from this computer.
 * @param {{agent: 'claude-code'|'codex', env?: object, projectDir?: string, sent?: Iterable<string>}} o
 */
export function pickLines({ agent, env = process.env, projectDir = process.cwd(), sent = [] }) {
  const sentBefore = new Set(sent);
  const sources = importSources({ agent, env, projectDir });
  const left = { key: 0, code: 0, instruction: 0, person: 0, other: 0 };
  const lines = [];
  const seen = new Set();
  let already = 0;
  let more = 0;
  const read = [];
  for (const src of sources) {
    const { texts, read: files } = readSource(src);
    read.push({ ...src, files });
    for (const text of texts) {
      const { sentences, code } = sentencesOf(text);
      left.code += code;
      for (const s of sentences) {
        const r = shapeLine(s, { personal: src.key !== 'project' });
        if (!r.ok) {
          left[r.why] += 1;
          continue;
        }
        const fp = lineFingerprint(r.text);
        if (seen.has(fp)) continue;
        seen.add(fp);
        if (sentBefore.has(fp)) {
          already += 1;
          continue;
        }
        if (lines.length >= IMPORT_MAX) {
          more += 1;
          continue;
        }
        lines.push({ n: lines.length + 1, text: r.text, topic: r.topic, source: src.source });
      }
    }
  }
  return { sources: read, lines, left, already, more };
}

// ---------------------------------------------------------------------------
// The import's state on the computer

/** <data>/import.json, or a fresh state. */
export function readImportState(dataDir) {
  try {
    const s = JSON.parse(fs.readFileSync(path.join(dataDir, STATE_FILE), 'utf8'));
    if (!s || typeof s !== 'object') throw new Error('bad');
    return {
      asked: typeof s.asked === 'string' ? s.asked : null,
      answer: s.answer === 'yes' || s.answer === 'no' ? s.answer : null,
      sent: Array.isArray(s.sent) ? s.sent.filter((x) => typeof x === 'string' && /^[0-9a-f]{64}$/.test(x)) : [],
      pending: s.pending && typeof s.pending === 'object' && Array.isArray(s.pending.lines) ? s.pending : null,
    };
  } catch {
    return { asked: null, answer: null, sent: [], pending: null };
  }
}

/** Writes the state, owner-only. */
export function writeImportState(dataDir, state) {
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const file = path.join(dataDir, STATE_FILE);
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(state)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, file);
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    // Kept as written.
  }
}

/** Keeps that the person was asked, and their answer when they gave one ('yes' or 'no'). */
export function markAsked(dataDir, answer = null, now = new Date()) {
  const state = readImportState(dataDir);
  writeImportState(dataDir, { ...state, asked: state.asked ?? now.toISOString(), answer: answer ?? state.answer });
}

/** The lines shown and waiting for the person's choice, while they last; else null. */
export function pendingLines(state, now = Date.now()) {
  const p = state?.pending;
  if (!p || !Array.isArray(p.lines)) return null;
  const at = Date.parse(p.at);
  if (!Number.isFinite(at) || now - at > PENDING_MS || now < at - 60_000) return null;
  return p.lines.filter((l) => l && typeof l.text === 'string' && Number.isInteger(l.n));
}

/** "2 5", "2,5", "2, 5": the numbers the person leaves out. */
export function parseLeaveOut(words) {
  const out = new Set();
  for (const w of String(words ?? '').split(/[\s,]+/)) {
    if (/^\d{1,3}$/.test(w)) out.add(Number(w));
  }
  return out;
}

/**
 * The person's answer to choose, as typed: all (or yes), none (or no, or nothing typed), or the
 * numbers to leave out. Anything else sends nothing.
 * @returns {{send: boolean, leaveOut: Set<number>}}
 */
export function parseChoice(words) {
  const w = String(words ?? '').trim().toLowerCase();
  if (w === 'all' || w === 'a' || w === 'y' || w === 'yes') return { send: true, leaveOut: new Set() };
  if (/^\d{1,3}([\s,]+\d{1,3})*$/.test(w)) return { send: true, leaveOut: parseLeaveOut(w) };
  return { send: false, leaveOut: new Set() };
}

/** Forgets the lines shown, sending nothing. */
export function dropPending(dataDir) {
  const state = readImportState(dataDir);
  if (state.pending) writeImportState(dataDir, { ...state, pending: null });
}

// ---------------------------------------------------------------------------
// Sending

/** Aimiru's own sentence from an answer, on one line, at most 300 characters. */
function said(r) {
  return String(r?.message ?? '')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029\p{Cf}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 300);
}

/**
 * Sends each line through memory_propose with how=instructions. Each result is one of learned,
 * kept, waits, already (Aimiru had the same words) or refused (with Aimiru's sentence); the send
 * stops at the first answer that says the rest cannot go now, with stop set to why: limit (the day's
 * lines), off (learning is off for this agent), paused, reconnect, ended (a demo's hour) or
 * unreachable. A line is never kept to send later.
 * @returns {Promise<{results: Array<{n: number, text: string, result: string, said?: string}>, stop: string|null, sent: string[]}>}
 */
export async function sendLines({ client, lines, timeoutMs = 10_000 }) {
  const results = [];
  const sent = [];
  for (const line of lines) {
    // The key check runs here again: nothing that looks like a key leaves the computer.
    if (looksLikeKey(line.text)) continue;
    const r = await client.memoryPropose({ text: line.text, topic: line.topic ?? null, how: 'instructions' }, { timeoutMs });
    if (r.ok) {
      const state = r.data?.state;
      const result = r.data?.duplicate === true ? 'already' : state === 'kept' ? 'kept' : state === 'learned' ? 'learned' : 'waits';
      results.push({ n: line.n, text: line.text, result });
      sent.push(lineFingerprint(line.text));
      continue;
    }
    const fromAimiru = r.kind === 'http' && r.fromAimiru !== false;
    if (fromAimiru && r.status === 422) {
      results.push({ n: line.n, text: line.text, result: 'refused', said: said(r) });
      // Refused once is refused again: not sent from this computer a second time.
      sent.push(lineFingerprint(line.text));
      continue;
    }
    const stop = !fromAimiru
      ? 'unreachable'
      : r.status === 429
        ? 'limit'
        : r.status === 403 || r.status === 404
          ? 'off'
          : r.status === 423
            ? 'paused'
            : r.status === 401
              ? r.code === 'demo_ended'
                ? 'ended'
                : 'reconnect'
              : r.status === 409 && r.code === 'memory_full'
                ? 'full'
                : 'unreachable';
    return { results, stop, sent };
  }
  return { results, stop: null, sent };
}

// ---------------------------------------------------------------------------
// What the person reads on the terminal (docs/04: plain words, no dashes)

/** Home written as ~, so a path reads as the person knows it. */
function shown(file, env) {
  const home = homeOf(env);
  return file === home ? '~' : file.startsWith(home + path.sep) ? `~${file.slice(home.length)}` : file;
}

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

export const IMPORT_WORDS = {
  askRun: (command) => `To bring them in, run ${command}. Nothing is read until you do.`,
  askLater: (command) => `Nothing was read. To bring them in later, run ${command}`,
  askYesNo: 'Bring them in now? Type y for yes, anything else for no: ',
  readHead: 'Aimiru read these files on this computer, and only these:',
  readFile: (source, where) => `  ${cap(source)}: ${where}`,
  readNotes: (source, n, where) => `  ${cap(source)}: ${plural(n, 'note', 'notes')} in ${where}`,
  notFound: (where) => `  Not there, so not read: ${where}`,
  noneRead: (agent) => `None of ${agent}'s files that Aimiru reads are on this computer, so there is nothing to bring in.`,
  picked: (n) => `${plural(n, 'line', 'lines')} about you, picked on this computer. Nothing has been sent.`,
  nonePicked: 'No line in these files reads as a short fact about you, so nothing is sent. Your agents can still tell Aimiru what they know as you work.',
  line: (n, text) => `${String(n).padStart(4)}. ${text}`,
  from: (source) => `      from ${source}`,
  leftOut: (left) => {
    const parts = [];
    if (left.instruction) parts.push(`${left.instruction} read as instructions to the agent`);
    if (left.code) parts.push(`${left.code} ${left.code === 1 ? 'was' : 'were'} code, commands, paths or links`);
    if (left.person) parts.push(`${left.person} ${left.person === 1 ? 'was' : 'were'} about someone else`);
    if (left.other) parts.push(`${left.other} ${left.other === 1 ? 'was' : 'were'} not a short fact about you`);
    if (left.key) parts.push(`${left.key} looked like a key, a password, a number or an address, and ${left.key === 1 ? 'stays' : 'stay'} on this computer unshown`);
    return parts.length ? `Left out: ${parts.join('; ')}.` : null;
  },
  already: (n) => `${plural(n, 'line', 'lines')} went to Aimiru from this computer before, so not again.`,
  more: (n, max) => `${plural(n, 'more line', 'more lines')} could come in. Aimiru takes ${max} at a time: run the import again tomorrow for the rest.`,
  choose: 'Which of these may go to Aimiru: all of them, none, or all but some?',
  chooseRun: (send) =>
    `To send them all, run ${send}. To leave some out, add their numbers, such as ${send} --leave-out 2 5. To send none, do nothing: this computer forgets them in 30 minutes.`,
  choosePrompt: 'Type all to send them all, none to send none, or the numbers to leave out (such as 2 5): ',
  forgotten: 'Nothing was sent, and the lines shown are forgotten on this computer.',
  nothingWaiting: (look) => `No lines are waiting to be sent. To see them again, run ${look}`,
  sendHead: 'Sent to Aimiru, each with where it came from:',
  result: {
    learned: 'learned. Your agents get it.',
    kept: 'kept.',
    waits: 'waits for your OK in Aimiru, under Memory.',
    already: 'Aimiru already had it.',
    refused: (s) => `not kept. ${s}`,
  },
  stop: {
    limit: 'Aimiru takes no more lines from this agent today. Run the import again tomorrow for the rest.',
    off: (agent) => `Learning is off for ${agent} in Aimiru. Turn it on in Aimiru, under Memory, Who gets it, then run the import again.`,
    paused: 'Aimiru is paused, so nothing more was sent. Resume in Aimiru, then run the import again.',
    reconnect: (again) => `Aimiru did not know this agent's key. Connect it again with ${again}, then run the import again.`,
    ended: 'This demo has ended, so nothing more was sent.',
    full: 'Memory is full. Remove some lines in Aimiru, then run the import again.',
    unreachable: 'Aimiru could not be reached, so the rest were not sent. Nothing is kept here to send later; run the import again when you are online.',
  },
  noKey: (connect) => `Connect this agent to Aimiru first: ${connect}`,
  after: 'Open Aimiru, Memory: "Your agents already knew this" shows each line with where it came from, to keep or not.',
  noneSent: 'Nothing was sent.',
};

/**
 * The question asked once (ADR-0162, point 2), with the files the import would read that are on
 * this computer, and how to answer it; nothing when none of them is here. Reads no file.
 */
export function describeAsk({ agent, label, command, env = process.env, projectDir = process.cwd() }) {
  const present = presentSources({ agent, env, projectDir }).filter((s) => s.files.length > 0);
  if (present.length === 0) return [];
  const out = [importQuestion(label)];
  for (const s of present) {
    if (s.dir) out.push(IMPORT_WORDS.readNotes(s.source, s.files.length, shown(s.dir, env)));
    else out.push(IMPORT_WORDS.readFile(s.source, shown(s.file, env)));
  }
  if (command) out.push(IMPORT_WORDS.askRun(command));
  return out;
}

/** The lines that tell the person what was read and what was picked. */
export function describePick(pick, { agent, env = process.env } = {}) {
  const out = [];
  const read = pick.sources.filter((s) => s.files.length > 0);
  if (read.length === 0) {
    out.push(IMPORT_WORDS.noneRead(agent));
    return out;
  }
  out.push(IMPORT_WORDS.readHead);
  for (const s of pick.sources) {
    if (s.files.length === 0) continue;
    if (s.dir) out.push(IMPORT_WORDS.readNotes(s.source, s.files.length, shown(s.dir, env)));
    else out.push(IMPORT_WORDS.readFile(s.source, shown(s.file, env)));
  }
  out.push('');
  if (pick.lines.length === 0) out.push(IMPORT_WORDS.nonePicked);
  else {
    out.push(IMPORT_WORDS.picked(pick.lines.length));
    for (const l of pick.lines) {
      out.push(IMPORT_WORDS.line(l.n, l.text));
      out.push(IMPORT_WORDS.from(l.source));
    }
  }
  const leftOut = IMPORT_WORDS.leftOut(pick.left);
  if (leftOut) out.push(leftOut);
  if (pick.already > 0) out.push(IMPORT_WORDS.already(pick.already));
  if (pick.more > 0) out.push(IMPORT_WORDS.more(pick.more, IMPORT_MAX));
  return out;
}

/** The lines that tell the person what Aimiru did with each line sent. */
export function describeSend(sendResult, { agent, again }) {
  const out = [];
  if (sendResult.results.length > 0) {
    out.push(IMPORT_WORDS.sendHead);
    for (const r of sendResult.results) {
      const what = r.result === 'refused' ? IMPORT_WORDS.result.refused(r.said || '') : IMPORT_WORDS.result[r.result];
      out.push(`${IMPORT_WORDS.line(r.n, r.text)}: ${what}`.trimEnd());
    }
  } else out.push(IMPORT_WORDS.noneSent);
  if (sendResult.stop) {
    const s = IMPORT_WORDS.stop[sendResult.stop];
    out.push(typeof s === 'function' ? s(sendResult.stop === 'off' ? agent : again) : s);
  }
  if (sendResult.results.some((r) => r.result !== 'refused')) out.push(IMPORT_WORDS.after);
  return out;
}

/** The pick as kept for the person's choice: the exact lines shown, with when. */
export function pendingOf(pick, now = new Date()) {
  return { at: now.toISOString(), lines: pick.lines.map(({ n, text, topic, source }) => ({ n, text, topic, source })) };
}

/**
 * The lines shown, the computer's import state and the send, in one: what both connectors' import
 * commands run. look: read, pick, show, and keep the lines for the person's choice. send: send the
 * lines kept, less the numbers left out, then forget them and keep only their fingerprints.
 */
export function lookStep({ agent, label, dataDir, env = process.env, projectDir = process.cwd(), now = new Date() }) {
  const state = readImportState(dataDir);
  const pick = pickLines({ agent, env, projectDir, sent: state.sent });
  writeImportState(dataDir, { ...state, answer: 'yes', asked: state.asked ?? now.toISOString(), pending: pick.lines.length > 0 ? pendingOf(pick, now) : null });
  return { pick, lines: describePick(pick, { agent: label, env }) };
}

export async function sendStep({ client, label, dataDir, leaveOut = new Set(), again, now = Date.now() }) {
  const state = readImportState(dataDir);
  const lines = pendingLines(state, now);
  if (!lines) return { waiting: false, lines: [] };
  const chosen = lines.filter((l) => !leaveOut.has(l.n));
  const result = await sendLines({ client, lines: chosen });
  const sent = [...new Set([...state.sent, ...result.sent])];
  writeImportState(dataDir, { ...state, sent, pending: null });
  return { waiting: true, result, lines: describeSend(result, { agent: label, again }) };
}
