// Which account each Aimiru connector on this computer reports to (journey lane 2). Aimiru names the
// account in full to its own agent (GET /v1/me, space.account_email), and each connector keeps it here
// so the doctor can warn when Claude Code and Codex, side by side on one computer, report to different
// accounts. One small file in the person's own folder, readable only by them, holding sign-in
// addresses and the time they were seen: never a key, a token or a word of any ask.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** A note older than this is not trusted to say where an agent reports now. */
export const ACCOUNT_FRESH_MS = 30 * 24 * 3_600_000;

/** The file, in the person's own Aimiru folder. */
export function accountsFile(env = process.env) {
  const home = env.HOME || env.USERPROFILE || os.homedir();
  return path.join(home, '.aimiru', 'accounts.json');
}

/** The sign-in address Aimiru named, or null when it named none or something that is not one. */
export function accountEmailOf(answer) {
  // GET /v1/me puts it under space; the heartbeat answer carries it at the top.
  const email = answer?.space?.account_email ?? answer?.account_email;
  return typeof email === 'string' && email.length <= 254 && /^[^\s@]+@[^\s@]+$/.test(email) ? email : null;
}

/** The notes as kept: {<connector>: {agent, email, at}}. Unreadable or missing: none. */
export function readAccounts(env = process.env) {
  try {
    const data = JSON.parse(fs.readFileSync(accountsFile(env), 'utf8'));
    return data && typeof data === 'object' && !Array.isArray(data) ? data : {};
  } catch {
    return {};
  }
}

/** Keeps where this connector reports; any failure to write is silent (the session never waits on it). */
export function rememberAccount(env, connector, agent, email, now = Date.now()) {
  if (!connector || !email) return false;
  try {
    const file = accountsFile(env);
    const all = readAccounts(env);
    all[connector] = { agent, email, at: new Date(now).toISOString() };
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(all, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(tmp, file);
    return true;
  } catch {
    return false;
  }
}

/**
 * The connectors on this computer whose fresh note names a different account from the others, as
 * [{agent, email}] (each connector once), or [] when they agree or fewer than two are known.
 * `current` is this run's own answer from Aimiru, which wins over its older note.
 */
export function accountsDisagree(env, { connector, agent, email } = {}, now = Date.now()) {
  const all = readAccounts(env);
  if (connector && email) all[connector] = { agent, email, at: new Date(now).toISOString() };
  const fresh = Object.entries(all)
    .filter(([, n]) => n && typeof n.email === 'string' && typeof n.agent === 'string' && now - Date.parse(n.at) < ACCOUNT_FRESH_MS)
    .map(([, n]) => ({ agent: n.agent, email: n.email }));
  const emails = new Set(fresh.map((n) => n.email.toLowerCase()));
  return emails.size > 1 ? fresh : [];
}
