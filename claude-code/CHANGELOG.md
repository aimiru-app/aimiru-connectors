# Changes to Aimiru for Claude Code

## 0.3.0-rc.2 (pre-release, not released yet)

- Your brief: each session gets what you told Aimiru about yourself as it starts, right after Aimiru's own words and exactly as Aimiru wrote it. If you change it while a session is open, Claude Code gets the new one with your next message. If Aimiru could not answer in time as the session started, Claude Code asks for your brief again with your first message, once; if that fails too, a later message brings it, as before. The plugin keeps only which version a session was given, never your words.
- Jobs you give Claude Code in Aimiru: the next session you start in your terminal takes the job, and you read one line saying so; Claude starts it at your first message. After `/clear`, Claude gets the same job again with your next message while Claude Code keeps the same session. Scripted runs (`claude -p`, the SDK) never take one. `AIMIRU_TAKE_TASKS=0` turns this off on a computer.
- While a session works on your job, each of its checks names the job, so Aimiru can show you each step with it.
- The doctor says whether this computer takes your jobs, and when Aimiru last gave Claude Code your brief.
- The runner: `node "<plugin>/scripts/runner.mjs" on` starts each job you give Claude Code within seconds of your send, with `claude -p` in the folder you chose, under Aimiru's check (Claude Code must say it loaded the check before its first step, or the job stops), with no session open; `off` and `status` on the computer, Turn off on Today (ADR-0161).
- `/aimiru:import` brings what Claude Code already knows about you into Aimiru: it reads your own `CLAUDE.md`, this project's and Claude Code's notes on this project, on this computer, shows the facts about you it found, and sends only the ones you keep. `/aimiru:connect` asks about it once.
- The runner takes email addresses and phone numbers out of its short notes on a job and out of what Claude Code says when the job ends, on this computer, before either is sent to Aimiru or kept to send later. Each becomes `[email]` or `[phone]`. Card numbers and keys are taken out as before, and Aimiru's check of each step is unchanged.

Earlier changes are in the history of `aimiru-app/aimiru-connectors`.
