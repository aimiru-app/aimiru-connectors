// aimiru-codex import [--send [--leave-out 2 5] | --none] (ADR-0162): what Codex already knows about the
// person, brought into Aimiru's Memory and Soul with their OK, each line with its source.
//
// It reads only ~/.codex/AGENTS.md (or the one in CODEX_HOME) and this folder's AGENTS.md, on this
// computer (vendor/import-lines.mjs), shows the short facts about the person it picked, and sends
// only the ones the person keeps, through memory_propose with how set to instructions. Aimiru reads
// each again with its line rules: keys first, instructions refused, private lines waiting for the
// person. In a terminal it asks which to send there and then; with no terminal, the person sends
// with --send (all, or --leave-out and the numbers) or --none, within 30 minutes.
//
// init asks once (offerImport): in a terminal it asks there, and remembers the answer; with no
// terminal it prints the command instead. It is never asked again.

import readline from 'node:readline';
import {
  IMPORT_WORDS,
  describeAsk,
  dropPending,
  lookStep,
  markAsked,
  parseChoice,
  parseLeaveOut,
  readImportState,
  sendStep,
} from '../vendor/import-lines.mjs';
import { AGENT_LABEL, PACKAGE_NAME, loadSettings, makeClient } from './runtime.mjs';

// No tag and no version in a line the person types (Rohit, 29 Oct 23:50).
export const IMPORT_COMMAND = `npx ${PACKAGE_NAME} import`;
const INIT_COMMAND = `npx ${PACKAGE_NAME} init`;

/** One line typed at a terminal, or null when there is none. */
export async function askLine(question, { stdin = process.stdin, stdout = process.stdout } = {}) {
  if (!stdin.isTTY) return null;
  const rl = readline.createInterface({ input: stdin, output: stdout, terminal: true });
  try {
    return await new Promise((resolve) => {
      rl.question(question, (answer) => resolve(answer));
      rl.on('close', () => resolve(''));
    });
  } finally {
    rl.close();
  }
}

/**
 * @param {object} [o]
 * @param {boolean} [o.send] send the lines shown
 * @param {boolean} [o.none] send nothing, and forget the lines shown
 * @param {string} [o.leaveOut] the numbers to leave out, as typed
 * @param {object} [o.env] @param {(s: string) => void} [o.print]
 * @param {string} [o.projectDir] the folder whose AGENTS.md it reads (where it runs)
 * @param {(question: string) => Promise<string|null>} [o.ask] the terminal; null answers mean none
 * @returns {Promise<number>} 0 done, 1 not connected or not sent, 2 a bad option
 */
export async function importLines(o = {}) {
  const env = o.env || process.env;
  const print = o.print || ((s) => process.stdout.write(`${s}\n`));
  const ask = o.ask || ((q) => askLine(q));
  const projectDir = o.projectDir || process.cwd();
  const settings = loadSettings(env);
  const dataDir = settings.dataDir;
  const leaveOutWords = String(o.leaveOut ?? '').trim();
  if ((o.send && o.none) || (leaveOutWords && !o.send) || (leaveOutWords && parseLeaveOut(leaveOutWords).size === 0)) {
    print(`Run it as ${IMPORT_COMMAND}, or with --send, --send --leave-out and the numbers, or --none.`);
    return 2;
  }
  if (o.none) {
    dropPending(dataDir);
    print(IMPORT_WORDS.forgotten);
    return 0;
  }
  // Not connected: nothing is read, since nothing could be sent.
  if (!settings.token || !settings.baseUrl) {
    print(IMPORT_WORDS.noKey(INIT_COMMAND));
    return 1;
  }
  const client = makeClient(settings, { spool: false });
  const send = async (leaveOut) => {
    const sent = await sendStep({ client, label: AGENT_LABEL, dataDir, leaveOut, again: INIT_COMMAND });
    if (!sent.waiting) {
      print(IMPORT_WORDS.nothingWaiting(IMPORT_COMMAND));
      return 1;
    }
    for (const l of sent.lines) print(l);
    return sent.result.stop ? 1 : 0;
  };
  if (o.send) return send(parseLeaveOut(leaveOutWords));

  const { pick, lines } = lookStep({ agent: 'codex', label: AGENT_LABEL, dataDir, env, projectDir });
  for (const l of lines) print(l);
  if (pick.lines.length === 0) return 0;
  print('');
  print(IMPORT_WORDS.choose);
  const answer = await ask(IMPORT_WORDS.choosePrompt);
  if (answer === null) {
    // No terminal: the person sends with a second command, within 30 minutes.
    print(IMPORT_WORDS.chooseRun(`${IMPORT_COMMAND} --send`));
    return 0;
  }
  const choice = parseChoice(answer);
  if (!choice.send) {
    dropPending(dataDir);
    print(IMPORT_WORDS.forgotten);
    return 0;
  }
  return send(choice.leaveOut);
}

/**
 * Asked once, at init (ADR-0162, point 2): bring in what Codex already knows about the person? It
 * lists the files the import would read that are on this computer, reading none. In a terminal the
 * person answers there (yes runs the import); with none it prints the command. Never asked again.
 * @returns {Promise<'asked'|'yes'|'no'|null>} null when not asked
 */
export async function offerImport(o = {}) {
  const env = o.env || process.env;
  const print = o.print || ((s) => process.stdout.write(`${s}\n`));
  const ask = o.ask || ((q) => askLine(q));
  const projectDir = o.projectDir || process.cwd();
  const dataDir = loadSettings(env).dataDir;
  try {
    if (readImportState(dataDir).asked) return null;
    const lines = describeAsk({ agent: 'codex', label: AGENT_LABEL, env, projectDir });
    if (lines.length === 0) return null;
    print('');
    for (const l of lines) print(l);
    const answer = await ask(IMPORT_WORDS.askYesNo);
    if (answer === null) {
      print(IMPORT_WORDS.askRun(IMPORT_COMMAND));
      markAsked(dataDir);
      return 'asked';
    }
    const yes = /^\s*y(es)?\s*$/i.test(answer);
    markAsked(dataDir, yes ? 'yes' : 'no');
    if (!yes) {
      print(IMPORT_WORDS.askLater(IMPORT_COMMAND));
      return 'no';
    }
    print('');
    await importLines({ env, print, ask, projectDir });
    return 'yes';
  } catch {
    // The question can wait: init's work is done.
    return null;
  }
}
