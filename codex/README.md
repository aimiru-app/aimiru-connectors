# Aimiru's check for Codex

The commands Codex starts, its file changes and its tool server calls are checked against your Aimiru rules before they run, and recorded. A payment, a message, a share, a booking, a deletion or a sign-in that your rules hold does not run; Codex reads Aimiru's reason. When Aimiru asks you, the check holds that step a few seconds (4 at most, and not at all in your quiet hours): a yes in that time lets it run, a no refuses it. With no answer yet, the step does not run for now, and Codex reads that the question stays open until it ends (with the day, when that is not today), to carry on with other work and to try exactly that step again later. Once you have said yes, that try goes through, once; a try while the question is still open asks you nothing new. With nothing else left to do, Codex stops and tells you the step is waiting for your answer; once you answer, tell Codex to try again.

Published on npm as `aimiru-codex`. MIT licensed.

## Install

You need Node.js 18 or later on the computer that runs Codex, and your Aimiru key from Aimiru, under Agents, Codex (or the key a demo gave you). Put in the address Aimiru shows you in place of `<the address Aimiru shows you>`:

```bash
npx aimiru-codex init --aimiru-url <the address Aimiru shows you> --paste-key
```

Without `--paste-key`, it connects by code: it opens Aimiru's page to connect it in your browser and shows a code and the same link, which you can open on your phone instead; you pick the same code there and tap Connect. Over SSH, on a computer with no screen, or with `AIMIRU_NO_BROWSER=1` set, it only shows the link. It keeps waiting for you for the 10 minutes the code lasts, saying each minute how long is left, and installs once you have connected it. If it stops before then (`--wait <seconds>`, Ctrl+C), it says it is still waiting and installs nothing yet: run init again and it keeps the same code. Without `--aimiru-url`, it uses https://aimiru.app.

Then one step in Codex: open Codex, type `/hooks`, and trust **Checking with Aimiru**. Codex runs no check you have not trusted, and skips one again after it changes. Until the check has run once inside Codex, Aimiru shows Codex as **Advised**; from then on, **Guardrail**: Codex's own check holds each step before it runs, which OpenAI calls a guardrail, not a complete boundary (below). Only a run Codex itself writes into its session record (`~/.codex/sessions`) counts: the check run any other way, by hand for one, still checks the call but leaves Codex at **Advised**. The doctor says the check is where you trusted it only after such a run.

```bash
npx aimiru-codex doctor      # what works and what to fix
npx aimiru-codex uninstall   # take the check out of Codex
```

## What it does to your computer

- Saves your key in `~/.sayso/codex/key.json`, readable only by you.
- Copies the check to `~/.sayso/codex/app`, so it keeps working after npx clears its downloads.
- Adds one entry to Codex's `~/.codex/hooks.json` (or `$CODEX_HOME/hooks.json`), after any of your own, and keeps a dated copy of the file it changed. The entry runs `/bin/sh -c '{ /usr/bin/env -u NODE_OPTIONS -u NODE_PATH "<node>" "~/.sayso/codex/app/guard.mjs" ...; } ...'` with a one hour limit (a step held while you have paused waits up to 8 minutes for now, below Codex's own 10 minute limit for a check until we have seen Codex wait the hour; any other check answers within 45 seconds), for every tool call (no matcher). `<node>` is the Node.js that ran the install, by the link on your PATH when there is one (`/opt/homebrew/bin/node` rather than its versioned folder). The `/bin/sh` around it refuses the call whenever the guard ends any other way than a yes or a refusal: a Node.js that was upgraded away or removed, or the guard killed. Run the install line again after changing Node.js.

## Reads decided on this computer

When your rules allow reading and changing files inside your project without condition, Aimiru tells this computer so (asked again every 5 minutes, and lasting 6 minutes at most), and Codex's commands that only do that, and its file changes inside the project, are checked here against your rules with no wait on the network. Each one is written down on this computer first and sent to Aimiru within a minute by a small background process (`scripts/background.mjs`), where it is checked again and added to your Record. The same process watches for a Pause while Codex works, whatever this setting says. Everything else goes to Aimiru first, as before. Set `AIMIRU_LOCAL_READS=0` to check every step with Aimiru instead.

## How steps are read

Codex's commands, file changes and tool server calls are read the same way as Aimiru for Claude Code reads Claude Code's, with the same reading of each command. A plain web read (`curl URL`, any GET or HEAD that sends nothing) is reading, with the site named, recorded and not asked about. A request that sends data off this computer (`curl -d`, any POST, a long run of data in a header or the address, `scp`, `nc`, `ssh` given input) is sharing, with the full host named, so Aimiru asks the first time data goes to a new place, and it does not run while Aimiru cannot be reached. A change to Codex's, Claude Code's or Aimiru's own settings and files (`config.toml`, `hooks.json` and rules in `~/.codex` or `CODEX_HOME`, anything in the project's `.codex` folder, `~/.claude`, `~/.sayso`), and `aimiru-codex init` or `uninstall` run by Codex, is treated as removing a guard: Aimiru asks you, and it does not run while Aimiru cannot be reached.

## Programs Codex writes

A program Codex wrote and then runs (`node cleanup.js`, `python3 fix.py`) that is not in your last commit, or was committed during this session, is asked about, unless Codex's own sandbox holds it: then it runs as local work and is still named in your Record. A yes covers that file with that content for the rest of the session; a changed file is asked about again. Aimiru never sends the file's text, only its name, a fingerprint and what it seems to do.

Codex's sandbox counts only while all of these hold, read from `~/.codex/config.toml` (with the profile in use and your project's `.codex/config.toml`) and from how Codex was started:

- you are on macOS or Linux;
- `sandbox_mode` is `workspace-write` or `read-only`, or not set, and Codex was not started with `--sandbox danger-full-access`, `--dangerously-bypass-approvals-and-sandbox` or `--yolo`;
- `network_access` under `[sandbox_workspace_write]` is not `true`;
- you review Codex's requests to run something outside its sandbox (`approvals_reviewer` not set, or `"user"`), or `approval_policy = "never"`, so it makes none;
- no `allow` rule in `~/.codex/rules` matches the command;
- Codex did not ask to run this command outside its sandbox.

Anything Aimiru cannot read counts as the sandbox being off, and Aimiru asks. So does your project's `.codex/config.toml` or a profile's settings file changed after Codex started: Codex still runs with what it read when it started. When Aimiru cannot be reached, a program Codex wrote that its sandbox does not hold is refused.

## When something goes wrong

- **Aimiru cannot be reached:** payments, messages, sharing, bookings, deletions and sign-ins, and changes to Codex's or Aimiru's own settings, are refused. Reading and work inside your project go ahead, and their records wait on your computer until Aimiru answers again.
- **The check itself fails** (it crashes, is stopped, or runs out of time): Codex would run the call, so the check runs behind a small guard that answers for it. It refuses, unless the call was harmless and nothing was waiting on you. If the guard itself cannot start or is killed, the entry around it refuses.
- **Your login profile prints something** (Codex runs the entry through your login shell): a refusal is Aimiru's reason on stderr with exit code 2, which Codex reads before anything printed, so it still holds.
- **Paused in Aimiru:** Codex is held at its next step: the step neither runs nor is refused, and the check waits for you to resume, with no turn spent. Codex's status line keeps reading "Checking with Aimiru", the name you trusted, while the step is held. While Codex is taking steps it reads the Pause about every 3 seconds and confirms it to Aimiru; otherwise it learns of the Pause at its next step. When you resume, that step goes through its usual check and Codex carries on where it was. The hold goes on while Aimiru cannot be reached. After 8 minutes held, the check refuses that one step with "Paused in Aimiru for 8 minutes. Tap Resume, then say go on.", and holds the next step again: a check Codex stops would let the step run, and until we have seen Codex wait longer than its own 10 minute limit, the hold stays inside it. An entry an older install wrote has 60 seconds instead of an hour, so until you run the install line again and trust it again in `/hooks`, every step is refused while you have paused; `doctor` says so. Codex's own planning and helper tools are not checked, so they keep running.

## What it cannot see

OpenAI calls Codex's checks "a useful guardrail, not a complete enforcement boundary". Codex's web search and other tools OpenAI runs for Codex skip them, and so does work Codex does in the cloud. Codex also never checks what it types into a command that is already running, so starting a shell, an interpreter or a remote session Codex can keep typing into is held and asked about. Codex does not say which folder a command runs in: a command whose words name your own files in your home folder, and nothing in the project, is asked about too. If Codex itself stops the entry (after the time its settings give the check), or you have not trusted the check, Codex runs the call. Codex keys your trust to the entry's place in `hooks.json`: if another installer adds an entry before Aimiru's, Codex skips Aimiru's until you trust it again, and `doctor` says so. Aimiru shows the tier that is true: Advised until the check has run inside Codex, and Advised again 24 hours after it last reported in.

## What leaves your computer

- For each check: a short description of the step and the tool's input, cut short, with obvious secrets (keys, passwords, bearer values, credentials inside addresses) removed first.
- For a push: the repository it goes to (`github.com/owner/repo`), read from git's own settings on this computer, never with a sign-in in it.
- For a program Codex wrote: its name, a fingerprint of it and what a quick read of it suggests, never its text.
- Every few hours, while the check runs inside Codex: the check's version, how Codex was asked to run it (its permission mode), and whether Codex's own sandbox holds its commands (on, off or not known).
- When you pause: that this computer learned of the Pause and how (while working, or at a step), and how many steps went ahead after your tap.

Your key never leaves except to Aimiru, and nothing printed contains it.

## How it works

`scripts/guard.mjs` is what Codex runs. It starts `scripts/pre-tool-use.mjs` (the check), passes Codex's input through and the check's answer back, and answers for the check if it dies (see the top of `guard.mjs`). The check maps the call with the shared classifier (`scripts/vendor/classify.mjs`, the same reading as Aimiru for Claude Code), asks Aimiru, and answers Codex in the only two ways Codex honours: no output to go ahead, exit code 2 with Aimiru's reason on stderr to refuse (never structured output on stdout, which a login profile that prints would spoil). It never answers "ask" or "allow", which Codex would mark failed and run anyway. Patches are read with Codex's own parser rules (`scripts/lib/map.mjs`). Details and sources: `docs/adr/0091-codex-enforced.md` in the Aimiru repository.

## Working on it

```bash
node --test test/*.test.mjs            # runs the check the way Codex runs it, against a fake Aimiru (sandboxes in .test-sandboxes/)
node ../scripts/sync-shared.mjs        # after editing connectors/shared
```
