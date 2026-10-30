// Whether a program a command runs is new (ADR-0090): not in the commit the project was on when the
// session began. The classifier (classify.mjs) finds the programs a command runs; this module tells
// which of them are new, with the sha256 of each file's content (never its text) and hints from it.
// It also asks git where a push goes (CN7, pushTargetOf).
//
// It starts git (rev-parse, ls-tree, cat-file, symbolic-ref, config --list and remote get-url only:
// they run no hooks, filters or other programs a repository can name), so it is vendored only into
// the connectors that check newness: Claude Code, Codex and the go-between (scripts/sync-shared.mjs).
// OpenClaw's plugin store refuses a plugin that starts other programs, so OpenClaw does not carry it
// and does not check newness (ADR-0090).
//
// Vendored by scripts/sync-shared.mjs. Edit it only in connectors/shared/.

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { programHints, repositoryOf } from './classify.mjs';
import { redactSecrets, truncate } from './aimiru-client.mjs';

const GIT_TIMEOUT_MS = 3_000;
const PROGRAM_READ_LIMIT = 16 * 1024 * 1024;
/** A session's start reads at most this many repositories inside the project (the project's own first). */
const MAX_BASELINE_REPOS = 32;

function isWithin(p, dir) {
  if (!p || !dir) return false;
  if (p === dir) return true;
  return p.startsWith(dir.endsWith(path.sep) ? dir : dir + path.sep);
}

/**
 * git with a clean environment: no GIT_* variable from the session can point it at another
 * repository. The computer's own git settings are left out unless `system` (where a push goes reads
 * them, as the push itself does).
 */
export function gitRun(args, { system = false } = {}) {
  const env = { PATH: process.env.PATH || '/usr/bin:/bin', HOME: process.env.HOME || os.homedir(), LANG: 'C', GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' };
  if (!system) env.GIT_CONFIG_NOSYSTEM = '1';
  if (process.env.SYSTEMROOT) env.SYSTEMROOT = process.env.SYSTEMROOT;
  try {
    const r = spawnSync('git', ['--literal-pathspecs', ...args], { env, encoding: 'buffer', timeout: GIT_TIMEOUT_MS, maxBuffer: 1024 * 1024, windowsHide: true });
    return r.status === 0 && !r.error ? r.stdout : null;
  } catch {
    return null;
  }
}

function realOrNull(p) {
  try {
    return fs.realpathSync(p);
  } catch {
    return null;
  }
}

/** The top folder of the repository a folder is in (real path), or null outside any. */
export function repoTopOf(dir) {
  const out = gitRun(['-C', dir, 'rev-parse', '--show-toplevel']);
  const top = out ? out.toString('utf8').trim() : '';
  return top ? realOrNull(top) : null;
}

/** The commit a repository is on, or null before its first commit. */
function headOf(top) {
  const out = gitRun(['-C', top, 'rev-parse', '--verify', '-q', 'HEAD^{commit}']);
  const id = out ? out.toString('utf8').trim() : '';
  return /^[0-9a-f]{40}([0-9a-f]{24})?$/.test(id) ? id : null;
}

/** One entry of a tree at a commit: {mode, type, id}, or null when the commit does not have it. */
function entryAt(top, commit, rel) {
  if (!commit) return null;
  const ls = gitRun(['-C', top, 'ls-tree', '-z', commit, '--', rel.split(path.sep).join('/')]);
  if (!ls) return null;
  const m = /^(\d+) (blob|commit|tree) ([0-9a-f]{40}|[0-9a-f]{64})\t/.exec(ls.toString('utf8'));
  return m ? { mode: m[1], type: m[2], id: m[3] } : null;
}

/** A file's blob id at a commit (not a link), or null. */
function blobAt(top, commit, rel) {
  const e = entryAt(top, commit, rel);
  return e && e.type === 'blob' && e.mode !== '120000' ? e.id : null;
}

/**
 * What the session began with (ADR-0090), read once as it starts: the repository the project is in
 * and the ones inside the project folder (two levels down, at most MAX_BASELINE_REPOS), each with the
 * commit it was on. A program is new when it is not in that commit, so committing it during the
 * session, or starting a repository of its own beside it, does not make it known.
 */
export function sessionBaselineFor(projectDir, { budgetMs = 1_500, now = Date.now() } = {}) {
  const started = Date.now();
  const repos = [];
  const add = (top) => {
    if (!top || repos.some((r) => r.top === top) || repos.length >= MAX_BASELINE_REPOS) return;
    repos.push({ top, head: headOf(top) });
  };
  const project = projectDir ? realOrNull(path.resolve(String(projectDir))) : null;
  if (project) {
    add(repoTopOf(project));
    // Repositories inside the project folder, by their .git entry, skipping installed folders.
    const skip = new Set(['node_modules', '.venv', 'venv', '.tox', 'site-packages', 'dist', 'build', 'target']);
    const walk = (dir, depth) => {
      if (depth > 2 || Date.now() - started > budgetMs || repos.length >= MAX_BASELINE_REPOS) return;
      let names = [];
      try {
        names = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const d of names) {
        if (!d.isDirectory() || d.name.startsWith('.') || skip.has(d.name)) continue;
        const sub = path.join(dir, d.name);
        if (fs.existsSync(path.join(sub, '.git'))) {
          const top = repoTopOf(sub);
          if (top === sub) add(top);
        }
        walk(sub, depth + 1);
      }
    };
    walk(project, 1);
  }
  return { startedAt: now, project, repos };
}

/**
 * The commit a file's repository is compared with: the one it was on as the session began; a
 * repository inside another one, at the commit the outer one pins for it (a submodule); none for a
 * repository the session did not begin with. Without a record of the session's start, the commit
 * it is on now, and none for a repository inside the project's own that is not one of its submodules.
 */
function commitFor(top, { baseline, projectDir }) {
  const pinned = (outer, outerCommit) => {
    const e = entryAt(outer, outerCommit, path.relative(outer, top));
    return e && e.type === 'commit' && e.mode === '160000' ? e.id : null;
  };
  if (baseline && Array.isArray(baseline.repos)) {
    const own = baseline.repos.find((r) => r && r.top === top);
    if (own) return own.head || null;
    const outer = baseline.repos.filter((r) => r && r.head && r.top !== top && isWithin(top, r.top)).sort((a, b) => b.top.length - a.top.length)[0];
    return outer ? pinned(outer.top, outer.head) : null;
  }
  const project = projectDir ? realOrNull(path.resolve(String(projectDir))) : null;
  const projectTop = project ? repoTopOf(project) : null;
  if (!projectTop || projectTop === top || !isWithin(top, projectTop)) return 'HEAD';
  return pinned(projectTop, 'HEAD');
}

/**
 * The file's blob in the commit it is compared with (commitFor), read with git rev-parse and
 * git ls-tree only: {inRepo: false} outside any repository (or when git cannot answer), else
 * {inRepo: true, blob, top, rel, commit}, blob null when that commit does not have the file.
 */
export function committedBlobOf(abs, { baseline = null, projectDir = null } = {}) {
  const real = realOrNull(abs);
  if (!real) return { inRepo: false };
  const top = repoTopOf(path.dirname(real));
  if (!top) return { inRepo: false };
  const rel = path.relative(top, real);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return { inRepo: false };
  const commit = commitFor(top, { baseline, projectDir });
  return { inRepo: true, blob: commit ? blobAt(top, commit, rel) : null, top, rel, commit };
}

/** git's id for a blob with this content (sha1 or sha256 object format, from the length of the id it is compared with). */
function gitBlobId(content, length) {
  const h = createHash(length === 64 ? 'sha256' : 'sha1');
  h.update(`blob ${content.length}\0`);
  h.update(content);
  return h.digest('hex');
}

const NODE_EXTS = ['.js', '.json', '.node'];
const TS_EXTS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts', '.json'];
const MAKEFILES = ['GNUmakefile', 'makefile', 'Makefile'];

function kindOf(p) {
  try {
    const st = fs.statSync(p);
    return st.isFile() ? 'file' : st.isDirectory() ? 'dir' : 'other';
  } catch {
    return null;
  }
}

/**
 * The file an interpreter runs for an operand, the way it looks it up (ADR-0090 review):
 *   node      the file, then .js, .json and .node, then a folder's package.json main and index files
 *   bun, tsx  the file, then the TypeScript and JavaScript endings, then a folder's index files
 *   python    the file, or a folder's __main__.py
 *   makefile  the file, or in a folder GNUmakefile, makefile, Makefile (make's order)
 *   plain     the file only (bash, sh, ruby, perl, php, deno, a program run by its path)
 * {file} when one is found; {unclear: true} when something is there but Aimiru cannot tell which file
 * runs (not a regular file, or a name that only matches with an ending Aimiru does not look up);
 * null when nothing there can run.
 */
export function resolveProgramFile(abs, kind = 'plain') {
  const k = kindOf(abs);
  if (k === 'file') return { file: abs };
  const exts = kind === 'node' ? NODE_EXTS : kind === 'bun' ? TS_EXTS : [];
  for (const e of exts) if (kindOf(abs + e) === 'file') return { file: abs + e };
  if (k === 'dir') {
    if (kind === 'python') return kindOf(path.join(abs, '__main__.py')) === 'file' ? { file: path.join(abs, '__main__.py') } : null;
    if (kind === 'makefile') {
      // By the names in the folder: a folder that ignores case would answer "makefile" for a Makefile.
      let names = [];
      try {
        names = fs.readdirSync(abs);
      } catch {
        return null;
      }
      const n = MAKEFILES.find((x) => names.includes(x) && kindOf(path.join(abs, x)) === 'file');
      return n ? { file: path.join(abs, n) } : null;
    }
    if (kind === 'node' || kind === 'bun') {
      let main = null;
      try {
        const pkg = JSON.parse(fs.readFileSync(path.join(abs, 'package.json'), 'utf8'));
        if (pkg && typeof pkg.main === 'string' && pkg.main) main = path.resolve(abs, pkg.main);
      } catch {
        main = null;
      }
      if (main && isWithin(main, abs)) {
        const m = resolveProgramFile(main, kind);
        if (m) return m;
      } else if (main) return { unclear: true };
      for (const e of exts) if (kindOf(path.join(abs, `index${e}`)) === 'file') return { file: path.join(abs, `index${e}`) };
    }
    return null;
  }
  if (k === 'other') return { unclear: true };
  // Nothing by that name: a file with the same name and another ending may still be what runs.
  if (kind === 'node' || kind === 'bun') {
    try {
      const base = `${path.basename(abs)}.`;
      if (fs.readdirSync(path.dirname(abs)).some((n) => n.startsWith(base))) return { unclear: true };
    } catch {
      // no folder: nothing runs
    }
  }
  return null;
}

/** Folders whose programs a package manager installed, not the agent. */
const INSTALLED_PROGRAM_DIRS = /(^|\/)(node_modules|\.venv|venv|\.tox|site-packages)\//;

/** When a file (and what a link points at) last changed, which nothing on the computer can set back. */
function changedAtMs(file) {
  let t = 0;
  try {
    t = Math.max(t, fs.lstatSync(file).ctimeMs);
  } catch {
    return null;
  }
  try {
    t = Math.max(t, fs.statSync(file).ctimeMs);
  } catch {
    // a link to nothing: its own time
  }
  return t;
}

/** The scripts of a package.json, in a fixed order, as text; null when it is not one Aimiru can read. */
function scriptsText(content) {
  try {
    const pkg = JSON.parse(content.toString('utf8'));
    const s = pkg && typeof pkg.scripts === 'object' && pkg.scripts ? pkg.scripts : {};
    return JSON.stringify(Object.keys(s).sort().map((k) => [k, s[k]]));
  } catch {
    return null;
  }
}

/** A file's content at a commit (git cat-file, which runs no filter), or null. */
function contentAt(top, blob) {
  return blob ? gitRun(['-C', top, 'cat-file', 'blob', blob]) : null;
}

/**
 * Whether the program a command runs is new (ADR-0090), with the sha256 of what runs (for the Record;
 * its text never leaves the computer) and hints from its text. {exists: false} when nothing there
 * can run (a program the same command writes is counted by the classifier).
 *   new: not in the commit the session began with, changed since, committed during the session,
 *   outside any repository, in a repository the session did not begin with, a link, unreadable, or
 *   one Aimiru cannot tell which file runs. In an installed folder (node_modules, a virtual
 *   environment): new only when it changed after the session began.
 *   kind 'scripts': a package.json, new when its scripts are not the ones in that commit (its
 *   other fields, such as the packages it needs, do not count).
 */
export function inspectProgram(abs, { kind = 'plain', baseline = null, projectDir = null, committed = committedBlobOf } = {}) {
  const found = resolveProgramFile(abs, kind);
  if (!found) return { exists: false };
  if (found.unclear) return { exists: true, isNew: true, why: 'cannot tell which file runs', sha256: null, hints: [], file: abs };
  const file = found.file;
  let st;
  try {
    st = fs.lstatSync(file);
  } catch {
    return { exists: false };
  }
  const project = projectDir ? path.resolve(String(projectDir)) : null;
  const relToProject = project ? path.relative(project, file).split(path.sep).join('/') : '';
  if (project && !relToProject.startsWith('..') && INSTALLED_PROGRAM_DIRS.test(relToProject)) {
    // Installed before the session began: the package manager's, not the agent's. Without a record
    // of the session's start, as before: never counted as new.
    const at = changedAtMs(file);
    const since = baseline && Number.isFinite(baseline.startedAt) ? baseline.startedAt : null;
    if (since === null || (at !== null && at < since)) return { exists: true, isNew: false, why: 'installed before this session', sha256: null, hints: [], file };
    let content = null;
    try {
      content = fs.statSync(file).size <= PROGRAM_READ_LIMIT ? fs.readFileSync(file) : null;
    } catch {
      content = null;
    }
    return { exists: true, isNew: true, why: 'changed during this session', sha256: content ? createHash('sha256').update(content).digest('hex') : null, hints: programHints(content), file };
  }
  const readAll = () => fs.readFileSync(file);
  if (st.isSymbolicLink()) {
    let content = null;
    try {
      content = fs.statSync(file).size <= PROGRAM_READ_LIMIT ? readAll() : null;
    } catch {
      content = null;
    }
    return { exists: true, isNew: true, why: 'a link', sha256: content ? createHash('sha256').update(content).digest('hex') : null, hints: programHints(content), file };
  }
  if (!st.isFile()) return { exists: true, isNew: true, why: 'cannot tell which file runs', sha256: null, hints: [], file };
  if (st.size > PROGRAM_READ_LIMIT) return { exists: true, isNew: true, why: 'too large to read', sha256: null, hints: [], file };
  let content;
  try {
    content = readAll();
  } catch {
    return { exists: true, isNew: true, why: 'unreadable', sha256: null, hints: [], file };
  }
  let c;
  try {
    c = committed(file, { baseline, projectDir }) || { inRepo: false };
  } catch {
    c = { inRepo: false };
  }
  if (kind === 'scripts') {
    const now = scriptsText(content);
    if (now === null) return { exists: false }; // not a package.json the package manager can read: nothing runs
    const sha256 = createHash('sha256').update(now).digest('hex');
    const sameAt = (blob) => {
      if (!blob) return false;
      if (gitBlobId(content, blob.length) === blob) return true;
      const then = contentAt(c.top, blob);
      return then !== null && scriptsText(then) === now;
    };
    let why = null;
    if (!c.inRepo) why = 'not in a repository';
    else if (!sameAt(c.blob)) {
      if (c.commit && c.commit !== 'HEAD' && sameAt(blobAt(c.top, 'HEAD', c.rel))) why = 'committed during this session';
      else why = c.blob ? 'scripts changed since the last commit' : 'not in the last commit';
    }
    if (!why) return { exists: true, isNew: false, why: 'in the last commit', sha256, hints: [], file };
    return { exists: true, isNew: true, why, sha256, hints: programHints(Buffer.from(now)), file };
  }
  const sha256 = createHash('sha256').update(content).digest('hex');
  let why = null;
  if (!c.inRepo) why = 'not in a repository';
  else if (!c.blob || gitBlobId(content, c.blob.length) !== c.blob) {
    const head = c.commit && c.commit !== 'HEAD' ? blobAt(c.top, 'HEAD', c.rel) : null;
    if (head && gitBlobId(content, head.length) === head) why = 'committed during this session';
    else why = c.blob ? 'changed since the last commit' : 'not in the last commit';
  }
  if (!why) return { exists: true, isNew: false, why: 'in the last commit', sha256, hints: [], file };
  return { exists: true, isNew: true, why, sha256, hints: programHints(content), file };
}

/**
 * The newness check a connector gives the classifier (makePathContext's inspectProgram): what the
 * session began with (sessionBaselineFor, or null), and the project folder.
 */
export function programInspector({ baseline = null, projectDir = null } = {}) {
  return (abs, kind) => inspectProgram(abs, { kind, baseline, projectDir });
}

// ---------------------------------------------------------------------------
// Where a push goes (CN7; CONTRACT.md, `git push`; ADR-0146)
// ---------------------------------------------------------------------------

/**
 * Every git setting that applies in a folder, as the push itself reads them (the computer's, the
 * person's and the repository's, with their includes), in one run of git: key -> values in git's
 * order (a key written with no value at all is null). Null when git cannot say (no such folder, a
 * settings file git cannot read).
 */
function pushSettings(dir) {
  const out = gitRun(['-C', dir, 'config', '-z', '--list'], { system: true });
  if (!out) return null;
  const settings = new Map();
  for (const entry of out.toString('utf8').split('\0')) {
    if (!entry) continue;
    const nl = entry.indexOf('\n');
    const key = nl === -1 ? entry : entry.slice(0, nl);
    if (!settings.has(key)) settings.set(key, []);
    settings.get(key).push(nl === -1 ? null : entry.slice(nl + 1));
  }
  return settings;
}

/** A setting's last value (git's rule for a setting with one value); undefined when it is not set. */
const lastOf = (settings, key) => (settings.has(key) ? settings.get(key).at(-1) : undefined);

/**
 * git's own address rewriting (remote.c alias_url): the url.<base>.insteadOf (or pushInsteadOf)
 * value that is the longest start of the address is replaced by its base. Null when none applies.
 */
function rewritten(address, settings, kind) {
  let best = null;
  for (const [key, values] of settings) {
    const m = /^url\.(.*)\.([a-z]+)$/s.exec(key);
    if (!m || m[2] !== kind) continue;
    for (const start of values) {
      if (typeof start === 'string' && address.startsWith(start) && (!best || start.length > best.start.length)) best = { base: m[1], start };
    }
  }
  return best ? best.base + address.slice(best.start.length) : null;
}

/** A push from here also pushes submodules, to their own repositories (push.recurseSubmodules). */
function pushesSubmodules(settings) {
  const push = lastOf(settings, 'push.recursesubmodules');
  if (push !== undefined) return /^(on-demand|only)$/i.test(String(push ?? ''));
  const all = lastOf(settings, 'submodule.recurse');
  return all !== undefined && (all === null || /^(true|yes|on|1)$/i.test(all));
}

/**
 * The remote a plain "git push" in this folder goes to, as git picks it: the branch's pushRemote,
 * then remote.pushDefault, then the branch's remote, then origin.
 */
export function pushRemoteOf(dir, settings = pushSettings(dir)) {
  const head = gitRun(['-C', dir, 'symbolic-ref', '--short', '-q', 'HEAD']);
  const branch = head ? head.toString('utf8').trim() : '';
  const get = (key) => (settings ? lastOf(settings, key) : null) || null;
  return (branch && get(`branch.${branch}.pushremote`)) || get('remote.pushdefault') || (branch && get(`branch.${branch}.remote`)) || 'origin';
}

/**
 * Where an address that is not a remote's name goes, as git reads it: after its address rewriting
 * (a pushInsteadOf that applies, else an insteadOf), read by repositoryOf. A path is a folder on
 * this computer only when one is there.
 */
function addressTarget(dir, address, settings) {
  const a = rewritten(address, settings, 'pushinsteadof') ?? rewritten(address, settings, 'insteadof') ?? address;
  const target = repositoryOf(a, { cwd: dir });
  if (!target || !target.startsWith('folder:') || /^file:/i.test(a)) return target;
  try {
    return fs.statSync(path.resolve(dir, a.replace(/^~(?=$|\/)/, os.homedir()))).isDirectory() ? target : null;
  } catch {
    return null;
  }
}

/**
 * The repository a push from this folder to this remote (null: the one git picks, pushRemoteOf)
 * goes to: every push address git has for it (git remote get-url --push --all, which applies the
 * url.<base>.insteadOf and pushInsteadOf rewrites and runs no hook), read by repositoryOf
 * ("github.com/owner/repo", "folder:<name>"). A name that is not a remote is read as git reads it:
 * an address, after the same rewriting, or a folder on this computer when one is there. Null when
 * git cannot say, when a remote pushes to more than one place, or when the push also pushes
 * submodules.
 */
export function pushTargetOf(dir, remote = null, settings = undefined) {
  if (!dir || typeof dir !== 'string') return null;
  const s = settings === undefined ? pushSettings(dir) : settings;
  if (!s || pushesSubmodules(s)) return null;
  const name = remote || pushRemoteOf(dir, s);
  if (!name || name.startsWith('-')) return null;
  const out = gitRun(['-C', dir, 'remote', 'get-url', '--push', '--all', name], { system: true });
  const urls = out ? out.toString('utf8').split('\n').map((u) => u.trim()).filter(Boolean) : [];
  if (urls.length) {
    const found = new Set(urls.map((u) => repositoryOf(u, { cwd: dir })));
    return found.size === 1 && !found.has(null) ? [...found][0] : null;
  }
  return addressTarget(dir, name, s);
}

/**
 * Names where a command's pushes go (action.pushes, not enumerable, from the classifier:
 * [{target, address, dir} | {remote, dir}]), as git sends them: a remote's push address, or an
 * address the command gives, after git's own rewriting. The counterparty is the repository only
 * when every push goes to that same one; otherwise, or when git cannot say, it is null and the
 * person is asked. Returns the action.
 */
export function namePushTarget(action) {
  const pushes = Array.isArray(action?.pushes) ? action.pushes : null;
  if (!pushes || !pushes.length) return action;
  const found = new Set();
  const settingsOf = new Map();
  for (const p of pushes) {
    let target = null;
    if (p && typeof p.dir === 'string' && p.dir) {
      if (!settingsOf.has(p.dir)) settingsOf.set(p.dir, pushSettings(p.dir));
      const s = settingsOf.get(p.dir);
      if (s && !pushesSubmodules(s)) target = typeof p.address === 'string' ? addressTarget(p.dir, p.address, s) : pushTargetOf(p.dir, p.remote ?? null, s);
    }
    found.add(target);
    if (found.has(null) || found.size > 1) break;
  }
  action.counterparty = found.size === 1 && !found.has(null) ? truncate(redactSecrets([...found][0]), 200) : null;
  return action;
}
