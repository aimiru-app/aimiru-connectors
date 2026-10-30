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

/** The name Codex shows next to the brief entry at session start, and in its list to trust (ADR-0157). */
export const BRIEF_STATUS_MESSAGE = "Aimiru's brief";

/**
 * What `take` and `remember` say (ADR-0157), and the doctor's lines about each entry's trust. Kept
 * apart from WORDS only for reading; test/take.test.mjs lints every value the same way.
 */
export const JOB_WORDS = Object.freeze({
  // The trust step for the brief, after the check's (init).
  trustBrief: (command) => `Then trust "${BRIEF_STATUS_MESSAGE}" there too, so Aimiru gives Codex your brief as each session starts.`,
  // The doctor, per entry, from Codex's own settings (never "read": Aimiru gives the brief).
  checkTrusted: `Codex trusts "${STATUS_MESSAGE}" where it is in Codex's settings.`,
  checkUntrusted: (command) => `Codex has not trusted "${STATUS_MESSAGE}" yet, so it skips it. Open Codex, type ${command}, and trust "${STATUS_MESSAGE}".`,
  checkChanged: (command) => `"${STATUS_MESSAGE}" changed since you trusted it, so Codex skips it. Run the install line again, then trust it in ${command}.`,
  briefTrusted: `Codex trusts "${BRIEF_STATUS_MESSAGE}", so Aimiru gives Codex your brief as each session starts.`,
  briefUntrusted: (command) => `Codex has not trusted "${BRIEF_STATUS_MESSAGE}" yet, so it starts without your brief. Open Codex, type ${command}, and trust "${BRIEF_STATUS_MESSAGE}".`,
  briefChanged: (command) => `"${BRIEF_STATUS_MESSAGE}" changed since you trusted it, so Codex skips it. Run the install line again, then trust it in ${command}.`,
  briefMissing: `"${BRIEF_STATUS_MESSAGE}" is not in Codex's settings. Run the install line again.`,
  briefOff: `You turned "${BRIEF_STATUS_MESSAGE}" off in Codex. Turn it back on in Codex, under the same command.`,
  trustUnknown: "Codex's settings could not be opened, so whether Codex trusts Aimiru's entries is not known.",
  // take: before anything is taken.
  takeNoKey: (install) => `Codex is not connected to Aimiru yet, so no job was taken. Run ${install} first.`,
  takeNotChecked: (command) =>
    `No job was taken, because Codex has not run Aimiru's check where it is now since it was installed, so it could run the job unchecked. Open Codex, type ${command}, trust "${STATUS_MESSAGE}" and let Codex run one command, then run this again.`,
  // The settings file to change is passed in (quality review): Codex's own, or the project's.
  takeChecksOff: (file) => `No job was taken, because Codex's checks are turned off, so Codex would skip Aimiru. Turn them back on in ${file}, then run this again.`,
  takeProjectChecks: (file) => `No job was taken, because ${file} has a setting of its own for Codex's checks, which could turn Aimiru's off. Take that setting out, then run this again.`,
  takeTurnedOff: (command) => `No job was taken, because you turned Aimiru's check off in Codex. Open Codex, type ${command}, and turn "${STATUS_MESSAGE}" back on.`,
  takeNoFolder: (dir) => `There is no folder at ${dir}, so no job was taken.`,
  takeNotPerson: 'Run this yourself, in a terminal of your own: it takes no job from inside an agent or a script.',
  takeHomeFolder: (dir) => `Run this in your project's folder, not ${dir}: Codex would work in your whole home folder.`,
  takeNotGit: (flag) => `Codex runs a job only in a folder kept in git, so no job was taken. Run this in your project's folder, or name one with ${flag}.`,
  takeNoCodex: "Codex is not on this computer's PATH, so no job was taken.",
  // take: Aimiru's answer.
  takeNothing: 'No job is waiting for Codex in Aimiru. Give Codex a job on Today, then run this again.',
  takePaused: 'Codex is paused in Aimiru, so no job was taken. Resume it in Aimiru, then run this again.',
  // Aimiru opens jobs to Codex with the first one the person gives it (ADR-0152).
  takeNotOpen: 'Codex cannot take jobs from your Aimiru yet, so nothing was taken. Give Codex a job on Today first, then run this again.',
  takeUnreachable: 'Aimiru could not be reached, so no job was taken. Try again in a minute.',
  takeReconnect: (install) => `Aimiru does not recognise Codex's key, so no job was taken. Run ${install} again.`,
  takeNotYours: 'Aimiru gave Codex work you did not start, so Codex did not run it, and Aimiru has it back.',
  // take: the run.
  taken: (job) => `Codex took your job: ${job}`,
  takeWorking: (dir) => `Codex is working on it in ${dir}. Aimiru checks each step, and you can follow it in Aimiru.`,
  takeDone: 'Codex finished the job. Aimiru has its result.',
  takeFailed: 'Codex could not finish the job. Aimiru has what happened.',
  takeStopped: 'You stopped Codex before it finished. Aimiru has what happened.',
  takeTooLong: (minutes) => `Codex was still working after ${minutes} minutes, so the run was stopped. Aimiru has what happened.`,
  takeResultLater: 'Aimiru could not be reached to take the result, so it is kept here and sent once Aimiru answers.',
  // take --watch.
  watchStart: 'Waiting for a job from Aimiru. Codex looks every 30 seconds. Press Ctrl+C to stop.',
  watchPaused: 'Codex is paused in Aimiru. It waits for Resume before it takes a job.',
  // Said once while Aimiru does not answer, not at every look (quality review).
  watchUnreachable: 'Aimiru could not be reached. Codex keeps looking every 30 seconds.',
  watchStopped: 'Stopped waiting for jobs.',
  // remember.
  // Codex reads these (agent-experience review): about the person, never "you".
  rememberKept: 'Aimiru kept this line about the person. They can change or forget it in Aimiru, under Memory.',
  rememberLearned: 'Aimiru learned this line about the person. They can change or forget it in Aimiru, under Memory.',
  rememberWaiting: 'Aimiru holds this line for the person to look at in Aimiru. No agent is given it until they keep it.',
  rememberRefused: (why) => `Aimiru did not keep this. ${why}`,
  rememberNotOpen: 'Aimiru does not take lines from Codex yet, so nothing was kept.',
  rememberPaused: 'Codex is paused in Aimiru, so nothing was kept.',
  rememberUnreachable: 'Aimiru could not be reached, so nothing was kept. Carry on without it.',
  rememberNoKey: (install) => `Codex is not connected to Aimiru yet, so nothing was kept. Run ${install} first.`,
  rememberReconnect: (install) => `Aimiru does not recognise Codex's key, so nothing was kept. Run ${install} again.`,
  rememberEmpty: 'Give one plain line to remember, in quotes.',
  rememberTooLong: 'That line is too long. Send one short fact.',
  rememberTopic: (topics) => `The topic is one of: ${topics}.`,
  rememberHow: (hows) => `How you came by it is ${hows}.`,
});

export const WORDS = Object.freeze({
  installed: (file) => `Added Aimiru's check to Codex's settings in ${file}.`,
  replaced: (file) => `Updated Aimiru's check in Codex's settings in ${file}.`,
  copied: (dir) => `Put the check in ${dir}, so it keeps working when this download is cleared.`,
  backedUp: (file) => `Kept a copy of Codex's earlier settings at ${file}.`,
  savedKey: (file) => `Saved the key to ${file}, readable only by you.`,
  // An install from before Aimiru's files moved (ADR-0164): the same Codex in Aimiru, kept.
  carriedKey: 'Found the key an earlier install of Aimiru saved for Codex, so Codex stays the same agent in Aimiru.',
  earlierRemoved: (dir) => `Removed the earlier install's copy of the check and its key from ${dir}.`,
  removeEarlierAgent: 'Codex is connected as a new agent in Aimiru. Remove the earlier Codex under Agents, so its key stops working.',
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
