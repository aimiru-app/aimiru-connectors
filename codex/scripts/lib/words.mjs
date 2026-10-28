// What Aimiru's check for Codex says to people: the installer, the doctor and the guard (ADR-0091).
// docs/04 words: plain sentences, no em or en dashes, no exclamation marks, no technical words.
// test/words.test.mjs lints every value with the shared lintCopy. Commands and file paths are code
// and are passed in, never written into these sentences.
//
// Node built-ins only: the guard imports this file, and must load whatever else is broken.

/**
 * The guard's refusal when the check stopped before Aimiru answered (guard.mjs). No full stop at the
 * end: Codex adds ". Command: <command>" after a refusal's reason.
 */
export const STOPPED_REASON = "Aimiru: Aimiru's check for Codex stopped before it answered, so this did not run. Try again in a moment";

/**
 * The refusal the entry in hooks.json gives when the guard itself could not answer: the Node.js it
 * names moved or was removed, or the guard was killed (lib/install.mjs guardCommand). It sits inside
 * single quotes in that command line, so it holds no quote, backslash, dollar or exclamation mark.
 */
export const NO_ANSWER_REASON = 'Aimiru: the check for Codex did not answer, so this did not run. If this keeps happening, run the install line from Aimiru again, under Agents, Codex';

/** The name Codex shows next to the check while it runs, and in its list of checks to trust. */
export const STATUS_MESSAGE = 'Checking with Aimiru';

export const WORDS = Object.freeze({
  installed: (file) => `Added Aimiru's check to Codex's settings in ${file}.`,
  replaced: (file) => `Updated Aimiru's check in Codex's settings in ${file}.`,
  copied: (dir) => `Put the check in ${dir}, so it keeps working when this download is cleared.`,
  backedUp: (file) => `Kept a copy of Codex's earlier settings at ${file}.`,
  savedKey: (file) => `Saved the key to ${file}, readable only by you.`,
  notWindows: "Aimiru's check for Codex runs on macOS and Linux for now, so nothing was changed on this computer.",
  notAKey: 'That does not look like an Aimiru key. Copy it again from Aimiru, under Agents, Codex.',
  noKey: 'No key saved, so Codex is not connected yet. Run this again with your Aimiru key, or connect by code.',
  pasteKey: 'Paste the Aimiru key for Codex (it is not shown): ',
  badAddress: (why) => `The Aimiru address ${why}.`,
  badSettings: (file) => `Codex's settings in ${file} could not be read, so nothing was changed. Fix or move that file, then run this again.`,
  checksOff: 'Codex has its checks turned off in its settings, so Codex skips Aimiru. Turn them back on, then run this again.',
  reported: (tier) => `Aimiru now shows Codex as ${tier}.`,
  notReported: 'Aimiru could not be reached to say Codex is set up. It will hear from Codex the first time the check runs.',
  // The trust step (OpenAI: Codex skips a new or changed check until the person trusts it).
  trustTitle: 'One step left, in Codex:',
  trustStep: (command) => `Open Codex, type ${command}, and trust "${STATUS_MESSAGE}". Until you do, Codex skips it, and Aimiru shows Codex as Advised.`,
  trustThen: 'After that, the first time Codex runs a command, Aimiru shows Codex as Guardrail.',
  // Aimiru's own words (Mac run part 1, item 4): never a paraphrase passed off as OpenAI's.
  limit: "Codex's checks are a guard, not a wall: Codex's web search, and what it types into a command that is already running, skip them.",
  removed: (file) => `Removed Aimiru's check from Codex's settings in ${file}.`,
  nothingToRemove: (file) => `Aimiru's check was not in Codex's settings in ${file}.`,
  // Doctor lines.
  doctorKey: (ok) => (ok ? 'Codex has an Aimiru key.' : 'Codex has no Aimiru key yet. Run the install line from Aimiru, under Agents, Codex.'),
  doctorReach: (ok) => (ok ? 'Aimiru answers.' : 'Aimiru could not be reached. Check the address and your connection.'),
  // A demo's key after its hour (wave 10, snag 12): the same words as the check's refusal then.
  demoEnded: (undo) => `The demo has ended. To remove Aimiru, run ${undo}.`,
  doctorInstalled: (ok) => (ok ? "Aimiru's check is in Codex's settings." : "Aimiru's check is not in Codex's settings. Run the install line again."),
  doctorFiles: (ok) => (ok ? 'The check and Node.js are where Codex looks for them.' : 'The check or Node.js moved. Run the install line again.'),
  doctorChecksOn: (ok) => (ok ? 'Codex has its checks turned on.' : 'Codex has its checks turned off in its settings, so it skips Aimiru.'),
  doctorTurnedOff: 'You turned Aimiru\'s check off in Codex. Turn it back on in Codex, under the same command.',
  doctorRan: (ok) => (ok ? 'The check has run inside Codex, so you trusted it.' : 'The check has not run inside Codex yet. Trust it in Codex, then run a command there.'),
  // Codex keys its trust to where the entry sits in its settings: another entry added before it moves it.
  doctorMoved: (ok) =>
    ok
      ? "Aimiru's check is where you trusted it in Codex's settings."
      : "Aimiru's check moved in Codex's settings since you trusted it, so Codex skips it until you trust it again.",
  // An entry an older install wrote gives the check 60 seconds, too short to hold a step while paused.
  doctorOldEntry: (install, trust) =>
    `Aimiru's check in Codex's settings is from an older install, so each step is refused while you have paused. Run ${install} again, then type ${trust} in Codex and trust "${STATUS_MESSAGE}", so a Pause holds Codex's next step.`,
});
