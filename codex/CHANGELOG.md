# Changes to Aimiru's check for Codex

## 0.3.0-rc.2 (pre-release, not released yet)

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
