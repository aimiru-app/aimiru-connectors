# Changes to Aimiru's check for Codex

## 0.3.0-rc.4 (pre-release, 3 Nov 2026)

- Each step Codex takes inside a job you gave it now names that job in Aimiru, the reads Aimiru allows on your computer included, so the job's record holds every step and Aimiru's closing check reads them all. Nothing about how a step is decided changes.
- The words that ask you to trust Aimiru's entries offer **trust all** only when every check Codex lists is Aimiru's (their commands name `.aimiru`); otherwise they say to type `/hooks` and trust only Aimiru's.
- `runner on` waits for the runner that was already on to stop, tries the start again, and says plainly when it did not start, so turning it on again never leaves two or none.
- What to do: `npx aimiru-codex@next init` in your project, then trust Aimiru's entries again only if Codex asks. If the runner was on, run `npx aimiru-codex@next runner on` again.

## 0.3.0-rc.3 (pre-release, 30 Oct 2026)

- Aimiru's files now live in `~/.aimiru`: the key, the copy of the check and what waits to be sent are in `~/.aimiru/codex`. Settings are named `AIMIRU_...` (`AIMIRU_AGENT_TOKEN`, `AIMIRU_BASE_URL`, `AIMIRU_CODEX_DATA` and the rest), and the address flag is `--aimiru-url`. What to do: run the install line again, `npx aimiru-codex@next init`. It takes the key the earlier install saved for the same address, so Codex stays the same agent in Aimiru, rewrites Aimiru's two entries in Codex's `hooks.json` in the same place, and then removes the earlier copy of the check and its key. Then trust Aimiru's two entries again: open Codex in your project. When it says checks need review, choose **trust all** only if every check it lists is Aimiru's (their commands name `.aimiru`); otherwise type `/hooks` and trust only Aimiru's. If it finds no key to take, pick the code on your phone once to connect again: that adds a new Codex in Aimiru, so remove the earlier one under Agents, and its key stops working. If the runner was on, run `npx aimiru-codex@next runner on` again, so it starts from `~/.aimiru/runner`. Update Claude Code in the same sitting: until every connector on a computer is on this version, they do not guard each other's Aimiru files, and `init` and the doctor name the one that is not.
- Keys Aimiru gives start `aimiru_agt_` once this version is the one `npx aimiru-codex` installs; a key from before keeps working.
- Every line that asks you to trust Aimiru's entries now says what Codex shows: when it says checks need review, choose **trust all** only if every check it lists is Aimiru's (their commands name `.aimiru`), or else type `/hooks` and trust only Aimiru's. Codex never lists the check as "Checking with Aimiru": that is only the line it shows while the check runs. When `take` finds the check trusted but its run not yet reported to Aimiru, it says to let Codex run one more command while online.

## 0.3.0-rc.2 (pre-release, 29 Oct 2026)

- Aimiru's brief: a second entry in Codex's `hooks.json` gives Codex what you told Aimiru about yourself as each session starts. Trust it once in Codex, under `/hooks`, as "Aimiru's brief". It never takes a job.
- Installing again leaves each of Aimiru's entries where it is, so the trust you gave it stays. An entry that changed is rewritten in the same place, and Codex asks you to trust it again.
- `npx aimiru-codex take` runs the next job you gave Codex in Aimiru, with `codex exec` in your project's folder, under the same check. `--watch` keeps looking every 30 seconds; `--dir` names the folder. It takes nothing until the check has run inside Codex, never while you have paused, and passes Codex nothing about its sandbox or its approvals. You see short lines as Codex works, and so does Aimiru, with the job.
- `npx aimiru-codex remember "<line>" --topic <topic> --how <noticed|instructions>` lets Codex suggest one line about you, on a topic your brief carries, for you to keep in Aimiru. From inside Codex it needs Codex to reach the network, which Codex's own sandbox keeps off unless you turn it on.
- The doctor says, for each entry, whether Codex trusts it.
- Codex's settings are read as Codex reads them, so text that spans several lines, or a name written with escape codes, can no longer pass for your trust in Aimiru's check, or hide a setting that turns checks off.
- `npx aimiru-codex runner on` starts each job you give Codex, and Claude Code when its plugin is installed, within seconds of your send, with no session open; `runner off` and `runner status` on the computer, Turn off on Today (ADR-0161). It stays on after a restart on a Mac, never starts anything while you have paused, and keeps the computer awake only while a job runs and only on power.
- `npx aimiru-codex import` brings what Codex already knows about you into Aimiru: it reads your own `AGENTS.md` and this folder's, on this computer, shows the facts about you it found, and sends only the ones you keep. `init` asks about it once.
- `take` and the runner take email addresses and phone numbers out of the short lines you and Aimiru see as Codex works and out of what Codex says when a job ends, on this computer, before either is sent to Aimiru or kept to send later. Each becomes `[email]` or `[phone]`. Card numbers and keys are taken out as before, and Aimiru's check of each step is unchanged.

Earlier changes are in the history of `aimiru-app/aimiru-connectors`.
