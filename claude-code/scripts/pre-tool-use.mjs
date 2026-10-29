#!/usr/bin/env node
// Aimiru for Claude Code: PreToolUse.
//
// Reads the hook input on stdin, maps the tool call to an Aimiru action, asks Aimiru, and answers
// Claude Code on stdout (hooks reference, "PreToolUse decision control"):
//   allow                  -> no output, exit 0 (Claude Code's own permission rules still apply)
//   ask, then the person   -> {"permissionDecision":"allow"} or "deny" with the reason
//   deny / paused / 401    -> {"permissionDecision":"deny","permissionDecisionReason":"Aimiru: ..."}
//   paused before, and Aimiru unreachable now -> deny every call, reads included (ADR-0022)
//   Aimiru unreachable      -> deny for spend, send, share, book, delete, login (and protected settings);
//                             no output for everything else, and the record is spooled
//   the plugin's own /aimiru:doctor command, or /aimiru:activity turning the report on (not while
//   this computer knows Aimiru is paused) or saying whether it is on, by the plugin's full path,
//   connected or not (wave 10, snag 10)
//                          -> no output: never asked about, so it never waits on the person
//   not connected yet, and the call is the plugin's own /aimiru:connect command (or its doctor or
//   activity command as the skill writes it, with ${CLAUDE_PLUGIN_ROOT} left for the shell)
//                          -> no output; "ask" (Claude Code asks the person) when it names an address
//   a read the person's rules allow without condition, by the snapshot Aimiru gave this computer
//                          -> decided here, written to the local spool first, no output (ADR-0095)
//   Aimiru's own check or request_approval tool -> refused: the plugin checks every step itself, and
//                          the person would be asked twice (ADR-0096); dry runs and practice go ahead
// Ask and move on (ADR-0145): an ask holds the step at most 4 seconds, and not at all in quiet hours.
// A yes in that time lets it run; otherwise it is refused for now, Claude reads that the question stays
// open with the person, carries on with other work and tries the same step again later. That retry
// looks at the question once (at most 1.5 s) and asks nothing new: the person's yes lets exactly that
// call through, a no refuses it, and a question still open refuses it again. Each ask, and each later
// yes that let its step through, is one line in <data>/asks-trace.jsonl.
// Pause holds (ADR-0142): once this computer knows the agent is paused (its pause memory: the
// watcher's read, a heartbeat, a session start, or a 423 at a step), the next step is neither refused
// nor let through: the check waits, with no model turn spent, and reads the Pause at most once every
// 3 s (or uses the watcher's read). On Resume the step goes through its normal check, as if just
// tried. At 55 minutes it ends the turn: {"continue": false, "stopReason": "Paused in Aimiru for an
// hour. Tap Resume, then say go on."}. A 401 ends it refused; Aimiru out of reach never turns it into
// a yes. With the hold switched off (PAUSE_HOLDS, or AIMIRU_PAUSE_HOLD=0), every step is refused
// while paused, as before (ADR-0022). Either way the pause is confirmed once (POST /v1/pause/ack), and
// every step let through is noted for the count of steps after a tap.
// This script always exits 0 with valid output. If it crashes or times out anyway, hooks.json sets
// "onFailure": "block" so Claude Code blocks the call (Claude Code 2.1.295 or later).

import path from 'node:path';
import { NEW_PROGRAM_RESOURCE, actionForClaudeCodeTool, isSaysoTool, makerProtectedPaths } from './vendor/classify.mjs';
import { cartFacts, ucpScope, withRememberedCart } from './vendor/checkout.mjs';
import { ASKS_TRACE_FILE, appendTrace, askHoldMs, isFailClosed, projectOf, quietUntilOf } from './vendor/sayso-client.mjs';
import { MESSAGES, clockOf, personSaidNo, waitWords, withName } from './vendor/messages.mjs';
import { createLocalState, localDecision, localRecord } from './vendor/local.mjs';
import { ackOnce, holdCeilingMs, holdWhilePaused, pauseHoldOn, yesBeforeLastPause } from './vendor/pause-watch.mjs';
import { namePushTarget, programInspector } from './vendor/newness.mjs';
import { nativePromptFor } from './lib/native-prompt.mjs';
import { sandboxFor } from './lib/sandbox.mjs';
import {
  AGENT_LABEL,
  DOWN_WINDOW_MS,
  PAUSE_HOLDS,
  fingerprint,
  hookBudgetMs,
  loadSettings,
  makeClient,
  connectAddressQuestion,
  ownSetupCommand,
  protectedConfigPaths,
  readStdinJson,
  stateStore,
  takesTasksHere,
  watchFor,
  writeJson,
} from './lib/runtime.mjs';

const started = Date.now();
/**
 * Nothing in this run may still be waiting on the network after this moment. A held step gets the
 * whole budget again from its Resume: it goes through its normal check as if just tried.
 */
let deadline = started + hookBudgetMs();
/** Time kept back, after waiting for the person, for the pause check that must follow a reused yes. */
const PAUSE_RESERVE_MS = 3_000;
/** Time kept back at the end of the run to answer Claude Code (contract: capMs = left() - 3 s). */
const ANSWER_RESERVE_MS = 3_000;
/** A retry of the same call looks at its open question once, for at most this long (ADR-0145). */
const RETRY_LOOK_MS = 1_500;
/** A call's input is kept with its waiting question, for a late yes, only up to this size. */
const KEPT_INPUT_MAX = 64 * 1024;
/** A step paused again after each Resume this many times is refused, never let through. */
const HOLD_ROUNDS = 5;
const left = () => deadline - Date.now();

/** The Pause watch for this computer's agent (pause-watch.mjs), once settings are read. */
let watch = null;
/** A step let through: counted for the steps after a tap (POST /v1/pause/ack steps_after). */
const noteStep = () => {
  try {
    watch?.noteStep();
  } catch {
    // a step not counted never changes an answer
  }
};

/**
 * A note for the person, shown once with this call's answer (ADR-0090: the first time Aimiru asks
 * about a program the agent wrote while Claude Code's sandbox is off, how to turn the sandbox on).
 */
let notice = null;
const withNotice = (out) => (notice ? { ...out, systemMessage: notice } : out);

function deny(reason) {
  const text = String(reason || MESSAGES.doNotAct);
  writeJson(withNotice({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: withName(text),
    },
  }));
}

/** Claude Code asks the person itself, in the session (Aimiru cannot: it is not connected yet). */
function askInSession(reason) {
  writeJson({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'ask',
      permissionDecisionReason: `${MESSAGES.prefix}${reason}`,
    },
  });
}

function allowExplicitly(reason) {
  noteStep();
  writeJson(withNotice({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'allow',
      permissionDecisionReason: `${MESSAGES.prefix}${reason}`,
    },
  }));
}

/** Allowed, with Claude Code's own rules still applying: no output, or only the note for the person. */
function allowQuietly() {
  noteStep();
  if (notice) writeJson({ systemMessage: notice });
}

/**
 * Ends Claude's turn with no model turn (ADR-0142, the hold's ceiling): continue false and the
 * sentence the person reads. The refusal beside it is for a Claude Code that would not end the turn:
 * the step does not run either way.
 */
function stopTurn(reason) {
  writeJson({
    continue: false,
    stopReason: reason,
    hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: withName(reason) },
  });
}

/**
 * Holds this step while the agent is paused (ADR-0142), at most ceilingMs. Resumed: the step goes
 * through its normal check, with the run's whole budget again. Otherwise this writes the answer: the
 * ceiling ends the turn, a key that stopped working refuses the step, and an interruption (Esc in
 * Claude Code) refuses it too, so the held step never runs.
 */
async function holdHere(client, settings, ceilingMs) {
  const local = createLocalState({ dataDir: settings.dataDir, token: settings.token, baseUrl: client.baseUrl });
  let interrupted = false;
  const onSignal = () => {
    interrupted = true;
  };
  const signals = ['SIGTERM', 'SIGINT', 'SIGHUP'];
  for (const sig of signals) process.on(sig, onSignal);
  // Claude Code gone (Esc that did not end this process, or Claude Code itself closed): the process
  // that started this check is no longer its parent. The hold then ends without the step, so a
  // Resume never sends a step nobody waits for (engineering review of wk/connectors-flow).
  const parent = process.ppid;
  let res;
  try {
    res = await holdWhilePaused(client, watch, { ceilingMs: Math.max(0, ceilingMs), local, stop: () => interrupted || process.ppid !== parent });
  } finally {
    for (const sig of signals) process.off(sig, onSignal);
  }
  if (res.ended === 'resumed') deadline = Date.now() + hookBudgetMs();
  else if (res.ended === 'ceiling') stopTurn(MESSAGES.pauseCeiling);
  else if (res.ended === 'refused') deny(res.code === 'demo_ended' ? client.demoEndedText : MESSAGES.reconnect(AGENT_LABEL));
  else deny(MESSAGES.pauseHolding);
  return res;
}

/** The programs an action runs, by file and content, in a fixed order (ADR-0090 review). */
function programKeys(action) {
  if (!Array.isArray(action?.programs)) return [];
  return action.programs
    .map((p) => ({ path: String(p.path ?? ''), sha256: p.sha256 ?? null }))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

const sameKeys = (a, b) => JSON.stringify(a ?? []) === JSON.stringify(b ?? []);
/** Every program known by the sha256 of its content (one the same command writes is not). */
const fullyKnown = (keys) => keys.every((k) => /^[0-9a-f]{64}$/.test(String(k.sha256 ?? '')));

/** "You said no" only when the person did; a pause or a removed key while waiting says so instead. */
function deniedReason(answer) {
  if (answer.reason === 'sayso') return personSaidNo(answer.explain);
  return answer.explain || MESSAGES.doNotAct;
}

/**
 * The call's context for Aimiru, without empty values: Aimiru reads tool_name, session_id and
 * tool_use_id as text, and refuses a check whose context has null there (seen as "unreachable").
 */
function contextOf(input, toolName) {
  const context = {
    tool_name: toolName,
    session_id: input.session_id,
    tool_use_id: input.tool_use_id,
    permission_mode: input.permission_mode,
    ...(input.agent_id ? { agent_id: input.agent_id, agent_type: input.agent_type } : {}),
    ...(input.mcp_server ? { mcp_server: input.mcp_server } : {}),
  };
  for (const [k, v] of Object.entries(context)) {
    if (v === null || v === undefined || v === '') delete context[k];
    else if (['tool_name', 'session_id', 'tool_use_id'].includes(k)) context[k] = String(v).slice(0, 200);
  }
  return context;
}

/**
 * True when this computer last heard that Aimiru is paused for this agent (ADR-0022), so a step that
 * changes something waits for Aimiru instead of going ahead on its own (wave 10 review).
 */
function pausedHere(settings) {
  if (!(settings.token && settings.baseUrl)) return false;
  try {
    return Boolean(makeClient(settings).pausedLocally());
  } catch {
    return true;
  }
}

/**
 * The run this call belongs to (ADR-0042): Claude Code's session, named by the project folder so
 * the person reads "Claude Code's run reached $15 (billing)". The session id is the same one Claude
 * Code sends its model requests with (X-Claude-Code-Session-Id), so a Capped Key counts the same run.
 */
function runOf(input, projectDir) {
  const label = projectDir ? path.basename(String(projectDir)) : null;
  return { id: input.session_id, label };
}

async function main() {
  let input;
  try {
    input = await readStdinJson();
  } catch {
    deny(MESSAGES.internalError(AGENT_LABEL, null));
    return;
  }
  const toolName = input?.tool_name;
  // Aimiru's own tools, only when Claude Code says they come from the Aimiru plugin's own server.
  if (toolName && isSaysoTool(toolName, input?.mcp_server)) {
    const ti = input?.tool_input && typeof input.tool_input === 'object' ? input.tool_input : {};
    // The person set this computer not to pick up handed-off work (ADR-0043 review): Claude may not
    // take a task with Aimiru's own tool either, whatever the routine in its instructions says.
    if (toolName.endsWith('__take_task') && !takesTasksHere()) deny(MESSAGES.takeTasksOff);
    // The plugin checks every step itself, so Aimiru's own check or request_approval for a step asks
    // the person a second time (ADR-0096). Planning (dry_run) and practice requests ask nobody.
    else if (toolName.endsWith('__check') && ti.dry_run !== true && ti.practice !== true) deny(MESSAGES.askedTwice);
    else if (toolName.endsWith('__request_approval') && ti.practice !== true) deny(MESSAGES.askedTwice);
    return;
  }
  if (!toolName) return;

  const settings = loadSettings();
  // The plugin's own commands, exactly as their skills run them (ADR-0034). /aimiru:doctor and
  // /aimiru:activity are never asked about, connected or not (wave 10, snag 10: a doctor held for
  // 35 seconds, then refused, with the plugin's path in the Record): the doctor only reads, and
  // activity only sends Claude Code's own report to the person's Aimiru, or says whether it does.
  // Turning that report off (--off) takes something from what Aimiru sees, so it is checked as any
  // step is. /aimiru:connect runs while Claude Code is not connected yet, since it is how it gets
  // connected; one that names an address is asked of the person in the session, so nothing can point
  // this plugin at an Aimiru that is not theirs. Connected, a connect is checked with Aimiru as before.
  // Only the plugin's own files by their full path: the unexpanded ${CLAUDE_PLUGIN_ROOT} names a file
  // the shell picks when the command runs, so it is let through only while not connected, as before
  // (wave 10 review). Turning the report on changes Claude Code's own settings (settings.json in
  // ~/.claude, or in the folder CLAUDE_CONFIG_DIR names), so while this computer knows Aimiru is
  // paused it waits like any step ("Nothing runs until you resume"); --status reads.
  if (toolName === 'Bash') {
    const own = ownSetupCommand(input?.tool_input?.command, settings.pluginRoot);
    if (own && !own.literal) {
      if (own.script === 'doctor' || (own.script === 'activity' && own.status)) return;
      if (own.script === 'activity' && !own.off && !pausedHere(settings)) return;
    }
    if (own && !(settings.token && settings.baseUrl)) {
      if (own.url) askInSession(connectAddressQuestion(own.url));
      return;
    }
  }
  const store = stateStore(settings.dataDir, { secret: settings.token });
  const client = makeClient(settings);
  watch = watchFor(settings);
  // Every step keeps this computer's Pause watcher reading for two more minutes (watch.mjs).
  if (client.configured) watch.extendLease();
  // The hold relies on a check Claude Code stops being a refusal (onFailure: block, 2.1.295 and
  // later): on an older Claude Code, which session start records, a hold cut short would let the
  // step run, so there each step is refused while paused instead (ADR-0022; engineering review).
  const holdOn = client.configured && pauseHoldOn(process.env, PAUSE_HOLDS) && blocksOnFailure(store);
  let heldMs = 0;
  for (let round = 0; round < HOLD_ROUNDS; round += 1) {
    // Pause holds (ADR-0142): this computer knows the agent is paused, so the step waits for Resume.
    if (holdOn && client.pausedLocally()) {
      const held = await holdHere(client, settings, holdCeilingMs() - heldMs);
      heldMs += held.heldMs;
      if (held.ended !== 'resumed') return;
      // Aimiru just answered: a down window a remembered pause set must not let the step skip its
      // check (quality review of wk/connectors-flow).
      store.markUp();
    }
    const outcome = await checkStep({ input, toolName, settings, store, client, holdOn });
    if (outcome !== 'paused') return;
  }
  // Paused again after every Resume: refused, never let through.
  deny(client.pausedLocally()?.explain || MESSAGES.paused);
}

/**
 * The step's check, as if just tried: decided here from the snapshot, or by Aimiru, or by the
 * person's answer to a question it already asked. Writes the answer and returns 'done', or returns
 * 'paused' with nothing written when it learned the agent is paused and the hold is on, so main holds
 * the step and then checks it again.
 */
async function checkStep({ input, toolName, settings, store, client, holdOn }) {
  let action = null;
  /** When this step's check began: an ask's held_ms counts the check too (agent-experience review). */
  const stepStarted = Date.now();
  /**
   * The agent is paused: with the hold on, the step is held (main); with it off, the step is refused
   * as before (ADR-0022), and the pause is confirmed as learned at this step.
   */
  const onPaused = async (explain) => {
    if (holdOn) return 'paused';
    try {
      // Learned here: the snapshot goes too, so nothing is decided on this computer from one sealed
      // before the Resume.
      const local = createLocalState({ dataDir: settings.dataDir, token: settings.token, baseUrl: client.baseUrl });
      await ackOnce(client, watch, { learnedBy: 'held', local, timeoutMs: Math.max(250, Math.min(3_000, left() - 500)) });
    } catch {
      // confirmed by the watcher's next read instead
    }
    deny(explain || MESSAGES.paused);
    return 'done';
  };
  try {
    // Programs the agent wrote (ADR-0090): with Claude Code's sandbox holding this command they run
    // as local work; a file the person allowed earlier in this session, unchanged, runs again.
    // Read only when the command runs a program the agent wrote (it reads settings files and the
    // processes above this one).
    let sandbox = null;
    const sandboxNow = () => {
      if (!sandbox) {
        try {
          sandbox = sandboxFor(input, { projectDir: settings.projectDir || input.cwd });
        } catch {
          sandbox = { on: false, state: 'unknown' };
        }
      }
      return sandbox;
    };
    // Newness counts from the commit the session began with (session-start.mjs keeps it); without
    // that record, from the commit the project is on now.
    let baseline = null;
    try {
      baseline = store.sessionBaseline(input.session_id);
    } catch {
      baseline = null;
    }
    const classifyOpts = {
      projectDir: settings.projectDir || input.cwd,
      // Aimiru's own files, Claude Code's in a settings folder of its own (CLAUDE_CONFIG_DIR), and
      // Codex's folder (CODEX_HOME, else ~/.codex), so Claude Code cannot switch off Codex's check
      // either: the ones in ~/.claude and any .codex folder are guarded by name as well.
      protectedPaths: [settings.dataDir, settings.pluginRoot, ...protectedConfigPaths(), ...makerProtectedPaths()].filter(Boolean),
      sandbox: () => sandboxNow().on === true,
      programAllowed: (file, sha256) => store.programAllowed(input.session_id, file, sha256),
      inspectProgram: programInspector({ baseline, projectDir: settings.projectDir || input.cwd }),
      // The evidence carries a MAC of the whole input keyed by the agent key (ADR-0094).
      evidenceKey: settings.token,
    };
    action = actionForClaudeCodeTool(input, classifyOpts);
    // A push names the repository it goes to (CN7): git is asked where, in the folder the command
    // runs in (Claude Code's own), with its own address rewriting; null when git cannot say.
    namePushTarget(action);
    // The first time a program the agent wrote is asked about, with the sandbox plainly off where
    // Claude Code has one: say how to turn it on. Aimiru changes nothing (ADR-0090).
    if (action.resource === NEW_PROGRAM_RESOURCE && action.class !== 'read' && sandboxNow().state === 'off' && ['darwin', 'linux'].includes(process.platform)) {
      try {
        if (store.offerOnce('sandbox')) notice = MESSAGES.sandboxOffer;
      } catch {
        notice = null;
      }
    }
    // A store's complete_checkout names only its checkout id: the cart is the one the store last
    // answered with (create, update or get_checkout, remembered by post-tool-use), when there is one
    // (ADR-0065). Without it the check is a payment with no amount, so the person is asked.
    if (action.checkout?.reference && ['ucp', 'shopify'].includes(action.checkout.protocol)) {
      let remembered = null;
      try {
        // Only the cart this same tool server answered with (ucpScope).
        remembered = store.getCart(action.checkout.reference, ucpScope(toolName));
      } catch {
        // an unreadable cart is no cart
      }
      const merged = withRememberedCart(action.checkout, remembered);
      if (merged !== action.checkout) Object.assign(action, cartFacts(merged));
    }
    const context = contextOf(input, toolName);
    const failClosed = isFailClosed(action.class, { sensitive: action.sensitive === true });
    // Linking a call to its later record is bookkeeping: a full or read-only disk must not change
    // the answer Aimiru gave.
    // The programs a command runs that the agent wrote, for the receipt: the path in the project
    // and the sha256 of the file, never its text (ADR-0090).
    const programs = Array.isArray(action.programs) ? action.programs.map((p) => ({ rel: p.rel, sha256: p.sha256 ?? null })) : null;
    const remember = (extra) => {
      try {
        const checkout = action.checkout ? { checkout: { protocol: action.checkout.protocol, total: action.checkout.total ?? null, currency: action.checkout.currency ?? null } } : {};
        const named = programs ? { programs, sandbox: action.sandbox === true, resource: action.resource ?? null } : {};
        store.putCall(input.tool_use_id, { class: action.class, description: action.description, ...checkout, ...named, ...extra });
      } catch {
        // the record is still sent, without the link
      }
    };
    // The programs this call runs, by file and content: what the person is asked about, and what a
    // yes covers (ADR-0090 review).
    const askedAbout = programKeys(action);
    /** True when the programs are still the ones asked about, read again now. */
    const unchangedSinceAsked = () => {
      try {
        return sameKeys(askedAbout, programKeys(actionForClaudeCodeTool(input, classifyOpts)));
      } catch {
        return false;
      }
    };
    // The person said yes to running programs the agent wrote: the same files, unchanged, run as
    // local work for the rest of this session (ADR-0090). Only the contents the person was asked
    // about are remembered, and never a file the same command changes: what it will hold when it
    // runs is not what was read.
    const rememberYes = (asked = askedAbout) => {
      if (action.resource !== NEW_PROGRAM_RESOURCE || !Array.isArray(action.programs)) return;
      const covered = (p) => asked.some((k) => k.path === p.path && k.sha256 === p.sha256);
      try {
        store.rememberPrograms(
          input.session_id,
          action.programs.filter((p) => !p.remembered && p.sha256 && p.why !== 'changed by this same command' && covered(p)),
        );
      } catch {
        // asked again next time instead
      }
    };
    // Reads decided on this computer (ADR-0095): the snapshot and the reach stored with it.
    const local = createLocalState({ dataDir: settings.dataDir, token: settings.token, baseUrl: client.baseUrl });
    const session = input.session_id;
    /**
     * How long an ask holds the step (ADR-0145): at most 4 s whatever the reach, 0 in quiet hours
     * (from the ask's own reach, else the reach stored with the snapshot while under an hour old).
     */
    const planHold = ({ reach, quietUntil }) => {
      const r = reach ?? local.storedReach();
      const quiet = quietUntilOf({ quietUntil, reach: r });
      const ms = askHoldMs({ reach: r, quietUntil: quiet, capMs: left() - ANSWER_RESERVE_MS, overrideMs: settings.askBudgetMs });
      return { ms, quiet: quiet !== null };
    };
    /** One line in <data>/asks-trace.jsonl (ADR-0145): ids, class, times and outcomes only. */
    const traceAsk = (entry) => appendTrace(settings.dataDir, ASKS_TRACE_FILE, { connector: 'claude-code', class: action.class, ...entry });
    /** The refusal after a hold that got no answer: Aimiru's words, and that the question stays open. */
    const stillOpen = (plan, { explain, later = null, expiresAt }) => {
      const words = waitWords(explain, later);
      const until = clockOf(expiresAt);
      return plan.quiet ? MESSAGES.askOpenQuiet(words, until, AGENT_LABEL) : MESSAGES.askOpen(words, until, AGENT_LABEL);
    };

    // 1. The same call was asked about before and the person has not answered yet (or now has).
    const fp = fingerprint(input);
    let pending = store.getPending(fp);
    // A question about other programs than the ones this call runs now (a file swapped since, or
    // asked about before Aimiru kept them) is not this call's question: ask again (ADR-0090 review).
    if (pending?.exceptionId && (askedAbout.length || Array.isArray(pending.programs)) && !sameKeys(pending.programs, askedAbout)) {
      store.deletePending(fp);
      pending = null;
    }

    // 2. A read the person's rules allow without condition, decided here from the snapshot Aimiru
    // gave this computer, never waiting on the network (ADR-0095). Its record is written to the
    // local spool before the answer, and sent to Aimiru within a minute (post-tool-use).
    if (!pending?.exceptionId && action.class === 'read') {
      try {
        const decided = localDecision(action, {
          env: process.env,
          connector: 'claude-code',
          toolName,
          toolInput: input.tool_input,
          pending: false,
          paused: Boolean(client.pausedLocally()),
          file: local.read(),
        });
        if (decided.local) {
          const context = contextOf(input, toolName);
          const native = nativePromptFor(input, { dataDir: settings.dataDir, projectDir: settings.projectDir || input.cwd });
          if (native.native_prompt !== null) {
            context.native_prompt = native.native_prompt;
            if (native.estimated) context.native_prompt_estimated = true;
          }
          const record = localRecord({ action, context, project: projectOf(settings.projectDir || input.cwd), file: decided.file });
          if (local.append(record, decided.file.snapshot)) {
            try {
              store.putCall(input.tool_use_id, { class: action.class, description: action.description, local: true });
            } catch {
              // post-tool-use then sends a receipt as well, which costs a request, not safety
            }
            allowQuietly();
            return;
          }
        }
      } catch {
        // anything wrong here: ask Aimiru as before
      }
    }

    // A yes is used only for programs known by their content and unchanged since the question.
    const yesCovers = () => !askedAbout.length || (fullyKnown(askedAbout) && unchangedSinceAsked());
    if (pending?.exceptionId) {
      // The same call tried again (ADR-0145): one look at its question, never a second question. It
      // also tells Aimiru this computer is not waiting on it (waiting_s=0).
      const answer = await client.approvalNow(pending.exceptionId, { timeoutMs: Math.max(250, Math.min(RETRY_LOOK_MS, left() - PAUSE_RESERVE_MS)) });
      if (answer.status === 'allowed' && yesBeforeLastPause(watch, answer.answeredAt)) {
        // A yes given before a Pause is never used after it (ADR-0035, ADR-0142): asked again below.
        store.deletePending(fp);
        traceAsk({ kind: 'answered', exception_id: pending.exceptionId, outcome: 'before_pause' });
      } else if (answer.status === 'allowed' && !yesCovers()) {
        store.deletePending(fp); // asked again below, about what is there now
      } else if (answer.status === 'allowed') {
        // An earlier yes is used only when Aimiru confirms nothing is paused, within this run's time.
        const p = left() >= 250 ? await client.pause({ timeoutMs: Math.max(250, left() - 100) }) : { ok: false };
        if (p.ok && p.data?.paused === true) return onPaused(p.data?.explain || MESSAGES.paused);
        // Aimiru could not say: a pause it said before still holds (ADR-0022).
        const held = p.ok ? null : client.pausedLocally();
        if (held) return onPaused(held.explain || MESSAGES.stillPaused);
        if (!p.ok && failClosed) {
          deny(MESSAGES.unreachable(action.class));
          return;
        }
        store.deletePending(fp);
        remember({ actionId: pending.actionId ?? null, unchecked: false });
        rememberYes(pending.programs);
        // A later yes let the step through: minutes from the ask to the step running (ADR-0145).
        traceAsk({ kind: 'ran', exception_id: pending.exceptionId, asked_at: Number.isFinite(pending.ts) ? new Date(pending.ts).toISOString() : null });
        allowExplicitly(MESSAGES.askAllowed);
        return;
      } else if (answer.status === 'denied' && answer.reason === 'paused') {
        // Paused while the question is open: the question is kept, so after Resume this same step
        // looks at it again and asks nothing new.
        return onPaused(answer.explain || MESSAGES.paused);
      } else if (answer.status === 'denied') {
        store.deletePending(fp);
        traceAsk({ kind: 'answered', exception_id: pending.exceptionId, outcome: answer.reason === 'sayso' ? 'denied' : answer.reason });
        deny(deniedReason(answer));
        return;
      } else if (answer.status === 'waiting') {
        // Still open: refused again, and nothing is asked a second time.
        deny(MESSAGES.askStillOpen(clockOf(pending.expiresAt ?? null), AGENT_LABEL));
        return;
      } else store.deletePending(fp); // expired: ask again below
    }

    // 3. Aimiru failed a moment ago: harmless work goes ahead without waiting on the network,
    // unless Aimiru last said this agent is paused. Then Aimiru is asked anyway, so a resume is
    // heard at once, and the pause holds while it cannot answer (ADR-0022).
    if (!failClosed && store.isDown() && !client.pausedLocally()) {
      remember({ actionId: null, unchecked: true, reasonUnchecked: 'unreachable' });
      allowQuietly();
      return;
    }

    // 4. Ask Aimiru. The check says whether Claude Code's own default would have asked the person
    // about this call (ADR-0040): worked out here from the person's Claude Code settings, and only
    // the answer leaves this computer. It never changes what Aimiru decides.
    const native = nativePromptFor(input, { dataDir: settings.dataDir, projectDir: settings.projectDir || input.cwd });
    if (native.native_prompt !== null) {
      context.native_prompt = native.native_prompt;
      if (native.estimated) context.native_prompt_estimated = true;
    }
    const d = await client.decide(action, {
      context,
      deadlineMs: deadline,
      run: runOf(input, settings.projectDir || input.cwd),
      // The project or client folder Claude Code works in (ADR-0056): its name, or AIMIRU_PROJECT (or SAYSO_PROJECT),
      // and a hash of its full path worked out here, so the person's rules can name the project.
      project: projectOf(settings.projectDir || input.cwd),
      // The person's job this session took at its start, so they can follow its steps live
      // (ADR-0157). It changes nothing in how the step is decided.
      taskId: store.sessionTask(input.session_id),
    });
    // A remembered pause answered because Aimiru could not: Aimiru is down too.
    if (d.reason === 'unreachable' || d.reason === 'bad_response' || d.remembered) store.markDown(DOWN_WINDOW_MS);
    else if (d.reason === 'sayso') store.markUp();

    if (d.decision === 'allow') {
      remember({ actionId: d.actionId ?? null, unchecked: Boolean(d.failOpen), reasonUnchecked: d.failOpen ? d.reason : null });
      allowQuietly(); // no decision: allowed, and Claude Code's own rules still apply
      return;
    }
    // Paused: a 423 at this step (in the Record as checked, deny, reason paused), or a pause this
    // computer heard before while Aimiru cannot answer now.
    if (d.reason === 'paused') return onPaused(d.explain || MESSAGES.paused);
    if (d.decision === 'deny') {
      deny(d.explain || MESSAGES.doNotAct);
      return;
    }
    // ask: hold the step at most 4 seconds for the person, not at all in quiet hours (ADR-0145). In
    // quiet hours one look tells Aimiru this computer is not waiting (waiting_s=0); otherwise each
    // poll says how much of the hold is left, so the person's screen shows when the agent moved on.
    const plan = planHold({ reach: d.reach, quietUntil: d.quietUntil });
    const answer = plan.quiet
      ? await client.approvalNow(d.exceptionId, { timeoutMs: Math.max(250, Math.min(3_000, left() - ANSWER_RESERVE_MS)) })
      : await client.waitForApproval(d.exceptionId, { budgetMs: plan.ms, pollAfterMs: d.pollAfterMs ?? 2_000 });
    traceAsk({
      kind: 'ask',
      exception_id: d.exceptionId,
      // From the start of the step's check, so the time asking Aimiru counts as held too.
      held_ms: Date.now() - stepStarted,
      outcome: answer.status === 'waiting' ? 'open' : answer.status,
      ...(plan.quiet ? { quiet: true } : {}),
    });
    if (answer.status === 'allowed' && askedAbout.length && !unchangedSinceAsked()) {
      // The file changed while the person was asked: the yes was for what they were shown.
      deny(MESSAGES.programChanged);
      return;
    }
    if (answer.status === 'allowed') {
      remember({ actionId: d.actionId ?? null, unchecked: false });
      rememberYes();
      allowExplicitly(MESSAGES.askAllowed);
      return;
    }
    /**
     * The question stays open with the person (ADR-0145). It is kept here with Aimiru's own words and
     * the exact call (ADR-0094), under a MAC, so the same call tried again looks at this same
     * question, and a yes that comes later can be offered back to Claude as this same step.
     */
    const keepQuestion = () => {
      try {
        const explain = typeof d.explain === 'string' && d.explain ? d.explain.slice(0, 1_000) : null;
        let kept = input.tool_input ?? null;
        try {
          if (JSON.stringify(kept).length > KEPT_INPUT_MAX) kept = null;
        } catch {
          kept = null;
        }
        const call = {
          tool_name: toolName,
          tool_input: kept,
          session_id: session ?? null,
          class: action.class,
          description: action.description,
          reach: d.reach ?? null,
          reuse: d.reuse ?? null,
          quiet_until: d.quietUntil ?? null,
        };
        store.putPending(fp, { exceptionId: d.exceptionId, actionId: d.actionId ?? null, expiresAt: d.expiresAt ?? null, ...(explain ? { explain } : {}), ...(askedAbout.length ? { programs: askedAbout } : {}), call });
      } catch {
        // the retry asks again instead of reusing this question
      }
    };
    if (answer.status === 'denied' && answer.reason === 'paused') {
      // Paused while the step was held for the person: the question is kept, and the step is held.
      keepQuestion();
      return onPaused(answer.explain || MESSAGES.paused);
    }
    if (answer.status === 'denied') {
      deny(deniedReason(answer));
      return;
    }
    if (answer.status === 'expired') {
      deny(MESSAGES.askExpired);
      return;
    }
    keepQuestion();
    // Aimiru's sentence for the ask says where the question waits (on the person's phone, or in
    // Today when no phone is connected), so it is passed on instead of assuming a phone.
    deny(stillOpen(plan, { explain: d.explain || answer.explain, expiresAt: d.expiresAt }));
  } catch {
    // Our own failure: fail closed for the classes that must, let harmless work continue, unless
    // this computer knows the agent is paused (as Codex's check does; quality review).
    let paused = true;
    try {
      paused = Boolean(client.pausedLocally());
    } catch {
      paused = true;
    }
    if (action && !paused && !isFailClosed(action.class, { sensitive: action.sensitive === true })) {
      allowQuietly();
      return;
    }
    deny(MESSAGES.internalError(AGENT_LABEL, action?.class));
  }
}

/**
 * Whether a check Claude Code stops is a refusal here (onFailure: block, 2.1.295 and later), as
 * session start last recorded it. Unknown (no session start yet) counts as yes: session start runs
 * before any step in a real session, and an older or unknown version is recorded as false.
 */
function blocksOnFailure(store) {
  try {
    return store.readStatus()?.on_failure_block !== false;
  } catch {
    return true;
  }
}

main().then(
  () => process.exit(0),
  () => {
    deny(MESSAGES.internalError(AGENT_LABEL, null));
    process.exit(0);
  },
);
