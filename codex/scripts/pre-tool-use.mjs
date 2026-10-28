#!/usr/bin/env node
// Aimiru's check for Codex: PreToolUse (ADR-0091). Codex runs it through guard.mjs, never directly.
//
// Reads Codex's hook input on stdin, maps the tool call to an Aimiru action, asks Aimiru, and answers
// Codex in the only two ways Codex honours (OpenAI, Codex hooks, "PreToolUse"; openai/codex
// codex-rs/hooks/src/events/pre_tool_use.rs, parse_completed):
//   go ahead               -> no output, exit 0 (Codex's own approval rules still apply)
//   refuse                 -> "Aimiru: ..." on stderr, exit 2. Codex blocks the call and gives the model
//                             "Command blocked by PreToolUse hook: <reason>. Command: <command>"
// A refusal is never JSON on stdout: Codex runs the entry through `$SHELL -lc`, and a login profile
// that prints puts its text before the JSON, which Codex then reads as no answer and runs the call.
// Exit 2 is read before stdout. Never "ask": Codex marks that run failed and runs the call. Never
// "allow" either: without updatedInput Codex treats it as unsupported and runs the call regardless.
//
// Ask and move on (ADR-0145): when Aimiru says ask, this check holds the call at most 4 s, and not at
// all in quiet hours, then lets it go ahead on a yes, or refuses it for now, telling Codex the question
// stays open: carry on with other work and try exactly this step again later. The question is kept, so
// that retry looks at it once (at most 1.5 s) and asks nothing new: the person's yes lets that exact
// call through (Codex's only way to a late yes), a no refuses it. Each ask, and each later yes that let
// its step through, is one line in <data>/asks-trace.jsonl.
//
// Reads the person's rules allow without condition are decided here, from the snapshot Aimiru gave
// this computer (ADR-0095): written to the local spool first, then no output. A detached
// background.mjs keeps the snapshot fresh and sends those records within a minute.
//
// Aimiru unreachable, or anything failing in here: payments, messages, sharing, bookings, deletions
// and sign-ins (and changes to Codex's or Aimiru's settings) are refused; everything else goes ahead
// and is recorded once Aimiru answers again.
//
// Pause holds (ADR-0142): once this computer knows Codex is paused (its watcher's read, a 423 at a
// step), the next step is neither refused nor let through: the check waits, reading the Pause at most
// once every 3 s (or using the watcher's read), and tells the guard to wait with it. On Resume the
// step goes through its normal check, as if just tried. At 8 minutes (CODEX_HOLD_CEILING_MS, under
// Codex's own default limit of 10 minutes until the Mac run logs that Codex waits the hour) it
// refuses that one step with "Paused in Aimiru for 8 minutes. Tap Resume, then say go on." (Codex
// cannot end a turn from here yet), and the next step holds again. A 401 refuses it; Aimiru out of reach keeps holding, never a
// yes. It holds only with the switch on (PAUSE_HOLDS, AIMIRU_PAUSE_HOLD) and an entry in hooks.json
// that gives the check the hour (CODEX_TIMEOUT_S); otherwise each step is refused while paused, as
// before (ADR-0022). Either way the pause is confirmed once (POST /v1/pause/ack), and the detached
// background.mjs watches the Pause while Codex works.
//
// The guard (guard.mjs) reads what to do if this process dies before it answers, from fd 3:
// "allow" once the call is known to be harmless and nothing waits on the person, "deny" otherwise.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ASKS_TRACE_FILE, appendTrace, askHoldMs, isFailClosed, projectOf, quietUntilOf, redactSecrets, sha256Hex, truncate } from './vendor/sayso-client.mjs';
import { MESSAGES, clockOf, personSaidNo, waitWords, withName } from './vendor/messages.mjs';
import { createLocalState, localDecision, localReadsOn, localRecord } from './vendor/local.mjs';
import { ackOnce, holdCeilingMs, holdWhilePaused, pauseHoldOn, yesBeforeLastPause } from './vendor/pause-watch.mjs';
import { NEW_PROGRAM_RESOURCE, makerProtectedPaths } from './vendor/classify.mjs';
import { namePushTarget, programInspector, sessionBaselineFor } from './vendor/newness.mjs';
import { findOurHook } from './lib/install.mjs';
import { programKeys, programStore, sameKeys, yesCovers } from './lib/programs.mjs';
import { codexSandbox } from './lib/sandbox.mjs';
import { actionForCodexTool, isCodexLocalTool } from './lib/map.mjs';
import {
  AGENT_LABEL,
  BACKGROUND_DUE_MS,
  CODEX_HOLD_CEILING_MS,
  CODEX_TIMEOUT_S,
  DOWN_WINDOW_MS,
  GUARD_LIMIT_MS,
  PAUSE_HOLDS,
  VERSION,
  WAIT_CAP_MS,
  callArgsOf,
  callFolderOf,
  checkReport,
  fingerprint,
  hookBudgetMs,
  loadSettings,
  makeClient,
  projectDirOf,
  ranInsideCodex,
  readStdinJson,
  refuseAndExit,
  reportDue,
  stateStore,
  watchFor,
} from './lib/runtime.mjs';

/** The folder this check runs from (the copy init made, ~/.sayso/codex/app). */
const APP_DIR = path.dirname(fileURLToPath(import.meta.url));

const started = Date.now();
/**
 * Nothing in this run may still be waiting on the network after this moment. A held step gets the
 * whole budget again from its Resume: it goes through its normal check as if just tried.
 */
let deadline = started + hookBudgetMs();
/** Time kept back, after waiting for the person, for the pause check that must follow a reused yes. */
const PAUSE_RESERVE_MS = 3_000;
/** A retry of the same call looks at its open question once, for at most this long (ADR-0145). */
const RETRY_LOOK_MS = 1_500;
/** A step paused again after each Resume this many times is refused, never let through. */
const HOLD_ROUNDS = 5;
const left = () => deadline - Date.now();
/** The Pause watch of a step the check saw, so a step that goes ahead is counted (finish). */
let stepWatch = null;

/** Tells the guard what to answer if this process dies now (guard.mjs). */
function fallback(verdict) {
  const fd = Number(process.env.SAYSO_FALLBACK_FD);
  if (!Number.isInteger(fd) || fd < 3) return;
  try {
    fs.writeSync(fd, `${verdict}\n`);
  } catch {
    // no guard listening (a test running this file on its own)
  }
}

/**
 * Refuses the call. Codex hands the model "Command blocked by PreToolUse hook: <reason>. Command:
 * <command>" (codex-rs/core/src/hook_runtime.rs), so the reason ends without its own full stop.
 */
function reasonForCodex(reason) {
  const text = String(reason || MESSAGES.doNotAct).trim();
  const said = withName(text);
  return said.replace(/[.\s]+$/, '');
}

/** The refusal this run ends with (written on stderr with exit 2 once main is done), or null. */
let refusal = null;

/**
 * Tells the guard how long to wait for this check from now (guard.mjs, `limit <ms>`): the hour a hold
 * needs, then the usual 45 s once the step goes through its normal check.
 */
function guardLimit(ms) {
  const fd = Number(process.env.SAYSO_FALLBACK_FD);
  if (!Number.isInteger(fd) || fd < 3) return;
  try {
    fs.writeSync(fd, `limit ${Math.max(1_000, Math.floor(ms))}\n`);
  } catch {
    // no guard listening (a test running this file on its own)
  }
}

/**
 * True when Codex's entry for this check gives it the hour a hold needs (CODEX_TIMEOUT_S). An entry
 * an older install wrote (60 s) would let Codex stop a hold and run the call, so no hold there.
 */
function entryGivesHour(settings) {
  try {
    const at = findOurHook({ codexHome: settings.codexHome, appDir: APP_DIR });
    return at?.present === true && Number(at.timeout) >= CODEX_TIMEOUT_S;
  } catch {
    return false;
  }
}

/**
 * Holds this step while Codex is paused (ADR-0142), at most ceilingMs, with the guard told to wait.
 * Resumed: the step goes through its normal check, with the run's whole budget and the guard's usual
 * 45 s again. Otherwise this decides the refusal: the ceiling, a key that stopped working, or an end.
 */
async function holdHere(client, watch, local, ceilingMs) {
  guardLimit(Math.max(0, ceilingMs) + GUARD_LIMIT_MS);
  // The guard gone (it died, or Codex stopped it): this process has another parent now. The hold
  // ends without the step, so a Resume never sends a step nobody waits for (engineering review).
  const parent = process.ppid;
  const res = await holdWhilePaused(client, watch, { ceilingMs: Math.max(0, ceilingMs), local, stop: () => process.ppid !== parent });
  if (res.ended === 'resumed') {
    deadline = Date.now() + hookBudgetMs();
    guardLimit(GUARD_LIMIT_MS);
  } else if (res.ended === 'ceiling') deny(MESSAGES.pauseCeilingAfter(Math.round(CODEX_HOLD_CEILING_MS / 60_000)));
  else if (res.ended === 'refused') deny(res.code === 'demo_ended' ? client.demoEndedText : MESSAGES.reconnect(AGENT_LABEL));
  else deny(MESSAGES.pauseHolding);
  return res;
}

/**
 * Starts background.mjs, detached and with nothing of this process's open (the guard waits for this
 * process's output to close), when no process has read the Pause for 6 s (its watcher, ADR-0142,
 * whatever AIMIRU_LOCAL_READS says), or when the snapshot is due a refresh or reads decided here wait
 * for a sender (ADR-0095). Never waits for it.
 */
function maybeBackground(local, watch) {
  try {
    const sending = localReadsOn() && (local.refreshDue() || (local.spool.oldestMs() !== null && !local.waiterCovers()));
    const watching = watch.pollDue(BACKGROUND_DUE_MS);
    if (!sending && !watching) return;
    const env = { ...process.env };
    delete env.SAYSO_FALLBACK_FD;
    const child = spawn(process.execPath, [path.join(APP_DIR, 'background.mjs')], { detached: true, stdio: 'ignore', env });
    child.on('error', () => {});
    child.unref();
  } catch {
    // the next check tries again
  }
}

function deny(reason) {
  refusal = reasonForCodex(reason);
}

/** "You said no" only when the person did; a pause or a removed key while waiting says so instead. */
function deniedReason(answer) {
  if (answer.reason === 'sayso') return personSaidNo(answer.explain);
  return answer.explain || MESSAGES.doNotAct;
}

/** The call's context for Aimiru, without empty values. */
function contextOf(input, toolName) {
  const context = { tool_name: toolName, session_id: input.session_id, tool_use_id: input.tool_use_id };
  for (const [k, v] of Object.entries(context)) {
    if (v === null || v === undefined || v === '') delete context[k];
    else context[k] = String(v).slice(0, 200);
  }
  return context;
}

/** The run this call belongs to (ADR-0042): Codex's session, named by the project folder. */
function runOf(input, projectDir) {
  return { id: input.session_id, label: projectDir ? path.basename(String(projectDir)) : null };
}

/** A record for a call that went ahead without Aimiru's answer, sent when Aimiru is back. */
function uncheckedRecord(input, action, projectDir, why) {
  const d = String(action.description || 'An action').replace(/[.\s]+$/, '');
  const summary = why === 'stopped' ? `${d}. Codex went ahead without Aimiru's answer: the check stopped before Aimiru answered.` : `${d}. Codex went ahead while Aimiru was unreachable.`;
  return {
    action_id: null,
    outcome: 'completed',
    summary: truncate(redactSecrets(summary), 280),
    evidence: `sha256:${sha256Hex(String(action.evidence ?? ''))}`,
    idempotency_key: `cx_${sha256Hex(`${input.session_id ?? ''}|${input.tool_use_id ?? ''}|unchecked`).slice(0, 40)}`,
    project: projectOf(projectDir),
  };
}

async function main() {
  let input;
  try {
    input = await readStdinJson();
  } catch {
    deny(MESSAGES.internalError(AGENT_LABEL, null));
    return;
  }
  const toolName = typeof input?.tool_name === 'string' ? input.tool_name : '';
  if (!toolName) {
    fallback('allow');
    return;
  }

  const settings = loadSettings();
  const store = stateStore(settings.dataDir, { secret: settings.token });
  // Null in the home folder or above it: Codex then works in no project (projectDirOf).
  const projectDir = projectDirOf(input.cwd, settings.home);
  const client = makeClient(settings);
  /** This computer's Pause watch (ADR-0142): every call keeps the background watcher reading. */
  const watch = watchFor(settings);
  /** This computer's snapshot and local spool (ADR-0095). */
  const local = createLocalState({ dataDir: settings.dataDir, token: settings.token, baseUrl: client.baseUrl });
  if (client.configured) watch.extendLease();
  /** The in-flight record of a harmless call (see below); ended once the call's fate is known. */
  let ticket = null;
  const endTicket = () => {
    if (!ticket) return;
    try {
      client.spool?.end(ticket);
    } catch {
      // the in-flight copy is sent later, once
    }
    ticket = null;
  };
  /** From here on, a process that dies refuses the call: nothing went ahead, so nothing is recorded. */
  const holdFromHere = () => {
    endTicket();
    fallback('deny');
  };
  /**
   * Whether a step holds while paused (ADR-0142): the switch (PAUSE_HOLDS, AIMIRU_PAUSE_HOLD), and
   * Codex's entry giving the check the hour a hold needs (CODEX_TIMEOUT_S): an entry written before,
   * with 60 s, would let Codex stop the hold and run the call, so there the step is refused instead.
   */
  let holds = null;
  const holdsHere = () => {
    if (holds === null) holds = client.configured && pauseHoldOn(process.env, PAUSE_HOLDS) && entryGivesHour(settings);
    return holds;
  };
  try {
    // The check ran inside Codex, which Codex allows only once the person trusted it: report in
    // (ADR-0091), next to the check, so Aimiru can show Codex as Enforced. Only when Codex's own
    // transcript already holds this call (ranInsideCodex, wave 10 T3): a run by hand never counts.
    // Never delays the answer past this run's time, and never changes it.
    const status = store.readStatus();
    const reporting =
      client.configured && reportDue(status) && ranInsideCodex(input, { codexHome: settings.codexHome })
        ? client
            .heartbeat(checkReport({ status, input }), { timeoutMs: Math.max(250, Math.min(4_000, left() - 500)) })
            .then((hb) => {
              if (hb.ok) {
                // Codex keys its trust to where the entry sits in hooks.json: this run proves the
                // person trusts it there, so doctor can tell when another entry has moved it.
                let at = null;
                try {
                  at = findOurHook({ codexHome: settings.codexHome, appDir: APP_DIR });
                } catch {
                  at = null;
                }
                store.updateStatus({
                  hook_reported_at: new Date().toISOString(),
                  hook_version: VERSION,
                  tier: hb.data?.tier ?? null,
                  reason: hb.data?.reason ?? null,
                  ...(at?.present ? { group_index: at.groupIndex, handler_index: at.handlerIndex } : {}),
                });
              }
            })
            .catch(() => {})
        : Promise.resolve();

    // Codex's own local tools change nothing outside Codex: no check, as Claude Code's read-only tools.
    if (isCodexLocalTool(toolName)) {
      fallback('allow');
      await reporting;
      return;
    }
    // A step the check sees: counted for the steps after a tap when it goes ahead (finish).
    stepWatch = watch;

    let heldMs = 0;
    for (let round = 0; round < HOLD_ROUNDS; round += 1) {
      // Pause holds (ADR-0142): this computer knows Codex is paused, so the step waits for Resume.
      if (holdsHere() && client.pausedLocally()) {
        holdFromHere();
        // Never past CODEX_HOLD_CEILING_MS until the Mac run logs that Codex waits longer.
        const held = await holdHere(client, watch, local, Math.min(holdCeilingMs(), CODEX_HOLD_CEILING_MS) - heldMs);
        heldMs += held.heldMs;
        if (held.ended !== 'resumed') return;
        // Aimiru just answered: a down window a remembered pause set must not let the step skip its
        // check (quality review of wk/connectors-flow).
        store.markUp();
      }
      const outcome = await checkStep();
      if (outcome !== 'paused') return;
    }
    // Paused again after every Resume: refused, never let through.
    deny(client.pausedLocally()?.explain || MESSAGES.paused);
    return;

    /**
     * The step's check, as if just tried. Writes the answer (a refusal, or none to go ahead) and
     * returns 'done', or returns 'paused' with nothing decided when it learned Codex is paused and
     * the step holds here, so the loop above holds it and then checks it again.
     */
    async function checkStep() {
      let action = null;
      /** When this step's check began: an ask's held_ms counts the check too (agent-experience review). */
      const stepStarted = Date.now();
      /**
       * Codex is paused: with the hold, the step is held (the loop); without it, refused as before
       * (ADR-0022), and the pause confirmed as learned at this step.
       */
      const onPaused = async (explain) => {
        holdFromHere();
        if (holdsHere()) return 'paused';
        try {
          await ackOnce(client, watch, { learnedBy: 'held', local, timeoutMs: Math.max(250, Math.min(3_000, left() - 500)) });
        } catch {
          // confirmed by the watcher's next read instead
        }
        deny(explain || MESSAGES.paused);
        return 'done';
      };
      try {
        /**
         * Whether Codex's own sandbox holds this command (CN6, lib/sandbox.mjs), read once per check
         * and only when needed: Codex sends no sandbox field, so its settings, the codex command above
         * this check and the model's own call are read. Anything that cannot be read counts as off.
         */
        let sandboxRead = null;
        const sandboxNow = () => {
          if (!sandboxRead) {
            try {
              const raw = input?.tool_input?.command;
              sandboxRead = codexSandbox({
                codexHome: settings.codexHome,
                projectDir,
                input,
                callArgs: callArgsOf(input, { codexHome: settings.codexHome })?.args ?? null,
                command: Array.isArray(raw) ? raw.map(String).join(' ') : String(raw ?? ''),
              });
            } catch {
              sandboxRead = { on: false, state: 'unknown', why: 'it could not be read' };
            }
          }
          return sandboxRead;
        };
        // Programs Codex wrote (CN6, ADR-0090 for Codex): newness counts from what the session began
        // with, kept at its first check under a MAC keyed by the agent key, so a commit made during the
        // session never makes a file it wrote look old.
        const programs = programStore(settings.dataDir, { secret: settings.token });
        let baseline = null;
        try {
          baseline = programs.sessionBaseline(input.session_id);
          if (!baseline && projectDir && input.session_id) {
            baseline = sessionBaselineFor(projectDir, { budgetMs: Math.max(0, Math.min(1_000, left() - 3_000)) });
            programs.putSessionBaseline(input.session_id, baseline);
          }
        } catch {
          baseline = null;
        }
        const mapOpts = {
          projectDir,
          home: settings.home,
          // Aimiru's and Codex's own files, and Claude Code's where the environment names them
          // (CLAUDE_CONFIG_DIR, CLAUDE_PLUGIN_DATA), so Codex cannot switch off Claude Code's check
          // either; ~/.claude's files and every .codex folder's settings are guarded by name.
          protectedPaths: [settings.dataDir, settings.codexHome, ...makerProtectedPaths()].filter(Boolean),
          evidenceKey: settings.token,
          inspectProgram: programInspector({ baseline, projectDir }),
          sandbox: () => sandboxNow().on === true,
          programAllowed: (file, sha256) => programs.programAllowed(input.session_id, file, sha256),
        };
        action = actionForCodexTool(input, mapOpts);
        // What the sandbox read gave, kept for the next report when it changed (checkReport).
        if (sandboxRead && store.readStatus()?.sandbox !== sandboxRead.state) {
          try {
            store.updateStatus({ sandbox: sandboxRead.state });
          } catch {
            // reported as before
          }
        }
        // The programs this call runs, by file and content: what the person is asked about, and all a
        // yes covers (CN6, as for Claude Code).
        const askedAbout = programKeys(action);
        const keysNow = () => {
          try {
            return programKeys(actionForCodexTool(input, mapOpts));
          } catch {
            return null;
          }
        };
        /** The person said yes to programs Codex wrote: the same files, unchanged, run as local work for the rest of the session. */
        const rememberYes = () => {
          if (action.resource !== NEW_PROGRAM_RESOURCE || !Array.isArray(action.programs)) return;
          const covered = (p) => askedAbout.some((k) => k.path === p.path && k.sha256 === p.sha256);
          try {
            programs.rememberPrograms(
              input.session_id,
              action.programs.filter((p) => !p.remembered && p.sha256 && p.why !== 'changed by this same command' && covered(p)),
            );
          } catch {
            // asked again next time instead
          }
        };
        // A push names the repository it goes to (CN7). Codex runs a command in the folder the model
        // names and never tells the check which, so the folder is read from the session's transcript
        // and git is asked there, with its own address rewriting. Not known: nothing is named, and the
        // person is asked.
        if (action.pushes) {
          const folder = callFolderOf(input, { codexHome: settings.codexHome });
          const pushes = !folder ? null : folder === path.resolve(input.cwd) ? action.pushes : actionForCodexTool({ ...input, cwd: folder }, mapOpts).pushes;
          const named = pushes ? namePushTarget({ pushes, counterparty: null }).counterparty : null;
          if (named) action.counterparty = named;
          else delete action.counterparty;
        }
        const failClosed = isFailClosed(action.class, { sensitive: action.sensitive === true });
        const fp = fingerprint(input);
        let pending = store.getPending(fp);
        // A question about other programs than the ones this call runs now (a file swapped since) is not
        // this call's question: ask again (CN6, as for Claude Code).
        if (pending?.exceptionId && (askedAbout.length || Array.isArray(pending.programs)) && !sameKeys(pending.programs, askedAbout)) {
          store.deletePending(fp);
          pending = null;
        }

        // A read the person's rules allow without condition, decided here from the snapshot (ADR-0095),
        // never waiting on the network. Its record is on disk before Codex is answered.
        if (!pending?.exceptionId && action.class === 'read' && client.configured) {
          try {
            const decided = localDecision(action, {
              env: process.env,
              connector: 'codex',
              toolName,
              toolInput: input.tool_input,
              paused: Boolean(client.pausedLocally()),
              file: local.read(),
            });
            if (decided.local) {
              const record = localRecord({ action, context: contextOf(input, toolName), project: projectOf(projectDir), file: decided.file });
              if (local.append(record, decided.file.snapshot)) {
                fallback('allow');
                await reporting;
                return 'done'; // no output: Codex goes ahead, and its own approval rules still apply
              }
            }
          } catch {
            // anything wrong here: ask Aimiru as before
          }
        }
        // A pause Aimiru said before holds every step while Aimiru cannot say otherwise (ADR-0022).
        const mayGoAhead = () => !failClosed && !client.pausedLocally();
        const goAheadIfStopped = () => {
          if (!mayGoAhead()) {
            holdFromHere();
            return;
          }
          // On disk before anything goes to the network: if this process is stopped now, the harmless
          // call the guard lets through is still recorded (the spool picks the copy up later).
          if (!ticket && client.spool) ticket = client.spool.begin({ kind: 'record', body: uncheckedRecord(input, action, projectDir, 'stopped') });
          fallback('allow');
        };
        goAheadIfStopped();

        const context = contextOf(input, toolName);
        /**
         * How long an ask holds the call (ADR-0145): at most 4 s whatever the reach, 0 in quiet hours (from
         * the ask's own reach, else the reach stored with the snapshot while under an hour old).
         */
        const planHold = ({ reach, quietUntil }) => {
          const r = reach ?? local.storedReach();
          const quiet = quietUntilOf({ quietUntil, reach: r });
          const ms = askHoldMs({ reach: r, quietUntil: quiet, capMs: Math.min(WAIT_CAP_MS, left() - 500), overrideMs: settings.askBudgetMs });
          return { ms, quiet: quiet !== null };
        };
        /** One line in <data>/asks-trace.jsonl (ADR-0145): ids, class, times and outcomes only. */
        const traceAsk = (entry) => appendTrace(settings.dataDir, ASKS_TRACE_FILE, { connector: 'codex', class: action.class, ...entry });
        /** The refusal after a hold that got no answer: Aimiru's words, and that the question stays open. */
        const stillOpen = (plan, { explain, later = null, expiresAt }) => {
          const words = waitWords(explain, later);
          const until = clockOf(expiresAt);
          return plan.quiet ? MESSAGES.askOpenQuiet(words, until, AGENT_LABEL) : MESSAGES.askOpen(words, until, AGENT_LABEL);
        };

        // 1. The same call was asked about before: one look at its question (ADR-0145), never a second
        // question. It also tells Aimiru this check is not waiting on it (waiting_s=0).
        if (pending?.exceptionId) {
          holdFromHere();
          const answer = await client.approvalNow(pending.exceptionId, { timeoutMs: Math.max(250, Math.min(RETRY_LOOK_MS, left() - PAUSE_RESERVE_MS)) });
          if (answer.status === 'allowed' && yesBeforeLastPause(watch, answer.answeredAt)) {
            // A yes given before a Pause is never used after it (ADR-0035, ADR-0142): asked again below.
            store.deletePending(fp);
            traceAsk({ kind: 'answered', exception_id: pending.exceptionId, outcome: 'before_pause' });
            goAheadIfStopped();
          } else if (answer.status === 'allowed' && !yesCovers(askedAbout, askedAbout.length ? keysNow() : [])) {
            // A yes is used only for programs known by their content and unchanged since the question
            // (CN6); otherwise it is asked again below, about what is there now.
            store.deletePending(fp);
            goAheadIfStopped();
          } else if (answer.status === 'allowed') {
            // An earlier yes is used only when Aimiru confirms nothing is paused, within this run's time.
            const p = left() >= 250 ? await client.pause({ timeoutMs: Math.max(250, left() - 100) }) : { ok: false };
            if (p.ok && p.data?.paused === true) return onPaused(p.data?.explain || MESSAGES.paused);
            const held = p.ok ? null : client.pausedLocally();
            if (held) return onPaused(held.explain || MESSAGES.stillPaused);
            if (!p.ok && failClosed) {
              deny(MESSAGES.unreachable(action.class));
              return 'done';
            }
            store.deletePending(fp);
            rememberYes();
            // A later yes let the step through: minutes from the ask to the step running (ADR-0145).
            traceAsk({ kind: 'ran', exception_id: pending.exceptionId, asked_at: Number.isFinite(pending.ts) ? new Date(pending.ts).toISOString() : null });
            return 'done'; // the person said yes: no output, Codex goes ahead
          } else if (answer.status === 'denied' && answer.reason === 'paused') {
            // Paused while the question is open: the question is kept, so after Resume this same step
            // looks at it again and asks nothing new.
            return onPaused(answer.explain || MESSAGES.paused);
          } else if (answer.status === 'denied') {
            store.deletePending(fp);
            traceAsk({ kind: 'answered', exception_id: pending.exceptionId, outcome: answer.reason === 'sayso' ? 'denied' : answer.reason });
            deny(deniedReason(answer));
            return 'done';
          } else if (answer.status === 'waiting') {
            // Still open: refused again, and nothing is asked a second time.
            deny(MESSAGES.askStillOpen(clockOf(pending.expiresAt ?? null), AGENT_LABEL));
            return 'done';
          } else {
            store.deletePending(fp); // expired: ask again below
            goAheadIfStopped();
          }
        }

        // 2. Aimiru failed a moment ago: harmless work goes ahead without waiting on the network, unless
        // Aimiru last said this agent is paused. Its record waits on this computer.
        if (!failClosed && store.isDown() && !client.pausedLocally()) {
          try {
            client.spool?.append({ kind: 'record', body: uncheckedRecord(input, action, projectDir, 'unreachable') });
          } catch {
            // the in-flight copy stays and is picked up later
          }
          return 'done';
        }

        // 3. Ask Aimiru.
        const [d] = await Promise.all([
          client.decide(action, {
            context,
            deadlineMs: deadline,
            run: runOf(input, projectDir),
            // The project folder Codex works in (ADR-0056): its name and a hash of its full path.
            project: projectOf(projectDir),
          }),
          reporting,
        ]);
        if (d.reason === 'unreachable' || d.reason === 'bad_response' || d.remembered) store.markDown(DOWN_WINDOW_MS);
        else if (d.reason === 'sayso') store.markUp();

        if (d.decision === 'allow') {
          if (d.failOpen) {
            try {
              client.spool?.append({ kind: 'record', body: uncheckedRecord(input, action, projectDir, 'unreachable') });
            } catch {
              // the in-flight copy stays and is picked up later
            }
          } else {
            endTicket(); // Aimiru wrote this check to the Record itself
            if (client.spool && client.spool.size() > 0 && left() > 3_000) {
              // Aimiru answers again: send what waited on this computer, briefly.
              await client.flushSpool({ budgetMs: Math.min(1_500, left() - 1_500), max: 10 });
            }
          }
          return 'done'; // no output: Codex goes ahead, and its own approval rules still apply
        }
        // Paused: a 423 at this step, or a pause this computer heard before while Aimiru cannot answer.
        if (d.reason === 'paused') return onPaused(d.explain || MESSAGES.paused);
        if (d.decision === 'deny') {
          deny(d.explain || MESSAGES.doNotAct);
          return 'done';
        }
        // ask: hold the call at most 4 s for the person, not at all in quiet hours (ADR-0145). Stopped
        // while it holds means no.
        holdFromHere();
        const plan = planHold({ reach: d.reach, quietUntil: d.quietUntil });
        const answer = plan.quiet
          ? await client.approvalNow(d.exceptionId, { timeoutMs: Math.max(250, Math.min(3_000, left() - 500)) })
          : await client.waitForApproval(d.exceptionId, { budgetMs: plan.ms, pollAfterMs: d.pollAfterMs ?? 2_000 });
        traceAsk({
          kind: 'ask',
          exception_id: d.exceptionId,
          // From the start of the step's check, so the time asking Aimiru counts as held too.
          held_ms: Date.now() - stepStarted,
          outcome: answer.status === 'waiting' ? 'open' : answer.status,
          ...(plan.quiet ? { quiet: true } : {}),
        });
        if (answer.status === 'allowed' && askedAbout.length && !yesCovers(askedAbout, keysNow())) {
          // A program changed while the person was asked: the yes was for what they were shown (CN6).
          deny(MESSAGES.programChanged);
          return 'done';
        }
        if (answer.status === 'allowed') {
          rememberYes();
          return 'done'; // the person said yes
        }
        /** The question stays open with the person (ADR-0145), kept so the same call looks at it again. */
        const keepQuestion = () => {
          try {
            const explain = typeof d.explain === 'string' && d.explain ? d.explain.slice(0, 1_000) : null;
            const call = { class: action.class, reach: d.reach ?? null, reuse: d.reuse ?? null, quiet_until: d.quietUntil ?? null };
            store.putPending(fp, { exceptionId: d.exceptionId, actionId: d.actionId ?? null, expiresAt: d.expiresAt ?? null, ...(explain ? { explain } : {}), ...(askedAbout.length ? { programs: askedAbout } : {}), call });
          } catch {
            // the retry asks again instead of reusing this question
          }
        };
        if (answer.status === 'denied' && answer.reason === 'paused') {
          // Paused while the call was held for the person: the question is kept, and the call is held.
          keepQuestion();
          return onPaused(answer.explain || MESSAGES.paused);
        }
        if (answer.status === 'denied') {
          deny(deniedReason(answer));
          return 'done';
        }
        if (answer.status === 'expired') {
          deny(MESSAGES.askExpired);
          return 'done';
        }
        keepQuestion();
        // Aimiru's sentence for the ask says where the question waits (a phone, or Today).
        deny(stillOpen(plan, { explain: d.explain || answer.explain, expiresAt: d.expiresAt }));
        return 'done';
      } catch {
        // Our own failure: refuse the classes that must be refused, let harmless work continue.
        if (action && !isFailClosed(action.class, { sensitive: action.sensitive === true })) {
          try {
            if (!client.pausedLocally()) {
              client.spool?.append({ kind: 'record', body: uncheckedRecord(input, action, projectDir, 'unreachable') });
              return 'done';
            }
          } catch {
            // fall through to the refusal
          }
        }
        deny(MESSAGES.internalError(AGENT_LABEL, action?.class));
        return 'done';
      }
    }
  } finally {
    endTicket();
    if (client.configured) maybeBackground(local, watch);
    if (Math.random() < 0.02) store.cleanup();
  }
}

function finish() {
  if (refusal === null) {
    // A step let through: counted for the steps after a tap (POST /v1/pause/ack steps_after).
    try {
      stepWatch?.noteStep();
    } catch {
      // a step not counted never changes an answer
    }
    process.exit(0); // no output: Codex goes ahead
  }
  refuseAndExit(refusal);
}

main().then(finish, () => {
  deny(MESSAGES.internalError(AGENT_LABEL, null));
  finish();
});
