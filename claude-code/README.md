# Aimiru for Claude Code

Aimiru checks each action Claude Code takes against your rules before it runs, asks you when a rule says to, and records what happened.

## Install

```bash
claude plugin marketplace add aimiru-app/aimiru-connectors
claude plugin install aimiru@aimiru
```

Then restart Claude Code and run `/aimiru:connect` inside it. You sign in to Aimiru, pick the code it shows and tap Connect, and the key arrives by itself (below).

Inside a Claude Code session, run these two instead of the lines above:

```text
/plugin marketplace add aimiru-app/aimiru-connectors
/plugin install aimiru@aimiru
```

You also need Node.js 18 or later on the path Claude Code sees, because the checks run with `node` (check with `node --version`). Without it every step is refused, and Claude Code shows "Aimiru needs Node.js 18 or later on the path Claude Code sees. Install it, then restart Claude Code."

Claude Code names the plugin by its full id, `aimiru@aimiru`, in every command after the install; the name `aimiru` alone is not found.

### Paste the key you were given

Run `/plugin configure aimiru@aimiru` inside Claude Code, fill in these two, which Aimiru shows under Agents, Add an agent, Claude Code, then restart Claude Code (it reads the key only when it starts):

- **Aimiru key for Claude Code**, which starts with `sayso_agt_`. Claude Code keeps it in your computer's keychain, not in a settings file. A key set here is used before one `/aimiru:connect` saved.
- **Aimiru address**, which starts with `https://` and has no slash at the end.

### Or connect without copying a key

With an Aimiru account, run `/aimiru:connect` inside Claude Code instead. It opens Aimiru's page to connect it in your browser, and shows a code and the same link, which you can open on your phone instead. Sign in to Aimiru there, pick the same code from the three shown, and tap Connect. Tap Not mine if you did not start it. Over SSH, on a computer with no screen, or with `AIMIRU_NO_BROWSER=1` set, it opens nothing and only shows the link. The key arrives by itself and is kept in the plugin's own folder, readable only by you; Claude Code's checks cannot open it. Aimiru then sends you a practice request as an alert, which you answer from the alert; nothing happens either way. When Aimiru has no device of yours to alert, Claude Code says so instead and tells you where to turn alerts on. The code lasts 10 minutes, and `/aimiru:connect` keeps waiting for you all that time, saying each minute how long is left. If it has to stop first (Claude Code gives a command at most 10 minutes), it says it is still waiting: run `/aimiru:connect` again and it keeps the same code, so a Connect you tapped meanwhile is not lost.

`/aimiru:connect` uses the address set with `/plugin configure`, and https://aimiru.app when none is set. If you already use Aimiru with alerts on your phone, add `--email <your email>` and the request reaches your phone too.

To check everything, run `/aimiru:doctor` inside Claude Code. It also tells Aimiru which of its checks passed (each check's name and whether it passed, never your key, a path or what it printed), so this agent's page in Aimiru can say what to fix until Claude Code next reports in. Aimiru never asks about the plugin's own `/aimiru:doctor`, or `/aimiru:activity` turning its report on or with `--status`, connected or not (turning the report on waits like any step while you have paused); `/aimiru:connect` with an address still asks you in the session first.

## What happens with each answer

| Aimiru says | What Claude Code does |
|---|---|
| Allow | Runs it. Claude Code's own permission prompts still apply. |
| Ask me | Holds that step a few seconds (4 at most) while Aimiru asks you, and not at all in your quiet hours. Claude Code's status line says "Checking with Aimiru, or held while you have paused". Yes in that time: it runs. No: it does not. No answer yet: the step does not run for now, and Claude reads Aimiru's own words about where the question waits (your phone, or Today) and when it ends, with the day when that is not today. Claude carries on with other work and tries exactly that step again later: once you have said yes, that try goes through; a try while the question is still open asks you nothing new. With nothing else left to do, Claude stops and tells you the step is waiting for your answer, and your yes reaches it with your next message. |
| Never | Does not run. Claude reads Aimiru's reason. |
| Paused (everything, or this agent alone) | Claude Code is held at its next step: the step neither runs nor is refused, and the check waits for you to resume, with no turn spent. The status line keeps reading "Checking with Aimiru, or held while you have paused" while the step is held. While Claude Code is taking steps it reads the Pause about every 3 seconds and confirms it to Aimiru; otherwise it learns of the Pause at its next step. When you resume, that step goes through its usual check and Claude Code carries on where it was. A step in the middle of a thought is held when it comes, not mid-sentence. Read, Glob, Grep and the other tools Aimiru does not check keep running. The hold goes on while Aimiru cannot be reached. After 55 minutes held, Claude Code ends its turn with "Paused in Aimiru for an hour. Tap Resume, then say go on." Pressing Esc still interrupts Claude Code, and the held step does not run. On a Claude Code older than 2.1.295, each step is refused while you have paused instead of held. |
| Cannot be reached | Payments, messages, sharing, bookings, deletions, sign-ins, changes to Claude Code's, Codex's or Aimiru's own settings, and commands Aimiru cannot read or does not know do not run while Aimiru cannot be reached. Everything else continues, and its records are sent once Aimiru is back. |

### A yes that comes after Claude Code moved on

Your yes is not lost. When Claude tries the same step again, with the same input, your yes lets exactly that step through, once. With `AIMIRU_WAKE_ON_YES` set to `1`, Claude Code is woken to take that step as soon as you say yes, while the session is open; it is off by default until we have seen Claude Code honour it. When you come back to Claude Code in your own terminal (a new, resumed, cleared or forked session), it says "Your yes for "..." came in after Claude Code moved on. Run it again?", and Claude is given that exact step to take once if you say so. If the session is still open, your next message to Claude does the same. Aimiru offers each yes once, for an hour at most, and for payments, messages, sharing, bookings and deletions only until the question ends. A changed step is asked about again. Elsewhere (a run started with `-p`, the SDK), the same step tried again within the hour uses your yes.

### Reads decided on this computer

Most of what Claude Code does is read and change files inside your project. When your rules allow that without condition, Aimiru tells this computer so (it asks again every 5 minutes, and the answer lasts 6 minutes at most), and those steps are checked here against your rules, with no wait on the network. Each one is written down on this computer before it runs and sent to Aimiru within a minute while Claude Code stays open (if it closes first, when it next starts), where it is checked again against your rules as they are then and added to your Record, marked "decided on your computer from your rules". Anything else is checked with Aimiru first, as before: payments, messages, sharing, bookings, deletions, sign-ins, changes outside the project, programs Claude Code wrote, anything with an amount or a recipient, tools from tool servers, and every step while you have paused. While Claude Code is taking steps it reads the Pause about every 3 seconds, and otherwise learns of it at its next step; from then on every step is held until you resume, these included; after the Resume, steps go to Aimiru until a fresh answer about your rules comes. Set `AIMIRU_LOCAL_READS=0` to check every step with Aimiru instead. Your home folder is never a project: when Claude Code starts there, as it does in a new terminal, deleting or changing your files is checked with Aimiru like any step outside a project.

## How actions are read

| Claude Code tool | How Aimiru sees it |
|---|---|
| Bash and PowerShell | From the command itself. Payment tools and requests to payment services: a payment. Email, messages, `gh pr create`, publishing and deploying: a message. `git push`: a message that names the repository it goes to (`github.com/owner/repo`), read from git's own settings on this computer. Deleting files outside the project: a deletion of your files, so a rule about deleting files or data covers it. When the command shows which files only as it runs (a folder kept in a variable other than `$HOME`, a list another program hands it), or they are a cache folder programs rebuild by themselves, it is a deletion Aimiru asks you about. Dropping a database: a deletion. Deleting cloud or server data (`terraform destroy`, `kubectl delete`, `helm uninstall`, `docker system prune`, a cloud command line's delete step, a `DELETE` request to a cloud provider): a deletion of your cloud and server data, so "Never delete my data" covers it. A make target or package script named deploy, release, publish or ship (`make deploy`, `npm run deploy`): a deploy. A new or changed program, run from a file that was not in your last commit when the session began (`node scripts/cleanup.js`, `bash ./tmp.sh`): see below. A plain web read (`curl URL`, `wget URL`, any GET or HEAD that sends nothing): reading, with the site named, recorded and not asked about. A request that sends data off this computer (`curl -d`, `-F` or `-T`, any POST, a long run of data in a header or in the address, `scp`, `sftp`, `rsync`, `nc`, `ssh` given input): sharing, with the full host named, so Aimiru asks the first time data goes to a new place, and it does not run while Aimiru cannot be reached; when the host is known only as the command runs, sharing with no host, asked each time. Inline code that reaches the network (`python -c`, `node -e`): sharing, asked each time. Signing in or reading saved passwords: a sign-in. Changes outside the project or to the system: a change. Installs: other. Known local work (looking at files and text, git steps on this project, the project's own tests, builds and scripts): reading. A program Aimiru does not know, or one named only when it runs: other, held when Aimiru cannot be reached. |
| Write, Edit, MultiEdit, NotebookEdit | Inside the project or a temporary folder: local work, which your read rule covers and Aimiru records as a change to files in Claude Code's work folders. Outside it: a change. Claude Code's, Codex's or Aimiru's own settings and files (`~/.claude/settings.json`, a project's `.claude/settings*.json`, `.claude.json`, `~/.claude/plugins`, `~/.sayso`, Codex's `config.toml`, `hooks.json` and rules in `~/.codex` or a project's `.codex` folder, and the same under `CLAUDE_CONFIG_DIR` and `CODEX_HOME`): treated as removing a guard, so Aimiru asks you, and it does not run while Aimiru cannot be reached. The same goes for a command, inline code or a tool server argument that changes them, `git checkout` or `git restore` of them included. |
| WebFetch | Reading, with the site named, recorded and not asked about; sharing with the site when its address carries data. |
| WebSearch, Agent, Workflow | Reading. The helpers' own actions are each checked as they happen. |
| Monitor | From its command, like Bash. Watching an address: other. |
| Scheduled cloud runs (RemoteTrigger) | Starting or changing one: other. Looking at them: reading. |
| Any other tool, including tools added to Claude Code later | Other, never plain reading. A command in its input is read like Bash. |
| Tools from tool servers (`mcp__...`) | From the tool's name and arguments: `pay`, `buy`, `place_order` are payments; `send`, `post_message`, `reply` are messages; `book`, `reserve`, `create_event` are bookings; `delete`, `remove`, `cancel` are deletions; `share`, `grant`, `invite` are sharing. Amounts, currencies and recipients are passed along when the arguments show them. |

### Programs Claude Code writes

When a command runs a file of the project that was not in your last commit when the session began (new, changed since, committed during the session, or in a folder with no commits), Aimiru asks you first, showing the command and naming the file and what a quick read of it suggests ("it calls stripe.com and deletes files or data"). The same goes for a `package.json` whose scripts changed before `npm test` or `pnpm build`, and a changed makefile before `make`. What the file says never lets it through: a file Aimiru cannot read still asks. Your answer holds for that file, unchanged, for the rest of the session, and the question offers one more answer: "Allow and stop asking about Claude Code's new programs in this project today". The project's tests and builds with their scripts unchanged (`npm test`, `pytest`) stay local work. The record keeps the file's name and a fingerprint of it, never its text.

With Claude Code's sandbox on (`/sandbox`), those programs run as local work without a question: the sandbox keeps what they write inside your project and lets them reach only the sites you allowed. Aimiru reads whether it is on from your Claude Code settings; when it cannot tell (a settings file it cannot read, a session started with `--settings`), it counts it as off and asks. The first time Aimiru asks about such a program, it says how to turn the sandbox on, and changes nothing itself.

Not checked, because they only read on this computer or only change Claude Code's own session: Read, Glob, Grep, LS, the to-do and task list tools, Skill, AskUserQuestion, plan mode, ToolSearch, LSP, reading tool server resources, and listing or removing scheduled prompts. Every other tool is checked, including ones Claude Code adds later.

## The Aimiru routine

The plugin carries the Aimiru routine as a skill (`skills/sayso/SKILL.md`): the few steps that tell Claude when to check with Aimiru, what to do while a question to you is open, and how to record what it did. Each session tells Aimiru which version it has, so the agent's page in Aimiru says "Knows the Aimiru routine". The same words are in Aimiru's own instructions, on every Aimiru Card and at `/skill.md` on your Aimiru address. To bring it up to date, run `claude plugin update aimiru@aimiru`.

The plugin also gives Claude Aimiru's own tools, so it can tell Aimiru what it did and see whether you have paused. They talk only to Aimiru and are not checked with it. Claude Code asks you the first time Claude uses each one; allow it for good there if you like. Claude never needs them to check an action: the plugin checks every tool call itself, and the session tells Claude so. They use the same key as the checks: the one `/aimiru:connect` saved, or the one in the plugin's settings. If you connect in the middle of a session, they appear a moment later. If Aimiru cannot be reached when a session starts, the session starts without them and they appear once Aimiru answers, with no restart.

## Work handed between agents

Work handed between agents is off for now.

## What Claude Code did, next to what it checked

Run `/aimiru:activity` inside Claude Code, then restart Claude Code. From then on Claude Code sends Aimiru its own activity report, and the agent's page in Aimiru says "Checked with Aimiru before 48 of 48 risky actions this week", shows model spend as Claude Code counts it, and lists any risky action that ran without a check. Today says it too: "Claude Code ran a delete at 3:12 pm without checking." This tests Aimiru's own tier label against what Claude Code says it did.

- It needs the key `/aimiru:connect` saved. The command adds the report's settings to `~/.claude/settings.json` (Claude Code ignores them in a project's settings) and a small helper in the plugin's own folder that hands Claude Code the key each time it sends a report, so the key is never written into a settings file.
- If Claude Code already sends its activity somewhere else (in `~/.claude/settings.json`, in your organisation's settings for Claude Code, or through `OTEL_` settings where Claude Code runs), the command changes nothing, so your Aimiru key never goes to that place. If your shell sets `OTEL_` settings for Claude Code later, check that they do not send its activity anywhere else.
- On a plan rather than paying by use, the spend shown is what the same use would cost when paid by use; your plan's price does not change.
- To stop, run `/aimiru:activity --off`; to check, `--status`.

## What Aimiru can and cannot see

Aimiru shows Claude Code as **Enforced**, "Aimiru can stop this agent", only while all of this is true: the plugin is on, Claude Code is 2.1.295 or later (a check that fails or times out then stops the action instead of letting it through), and sessions report to Aimiru. Otherwise Aimiru shows **Advised**.

What it does not cover, so you know:

- Claude Code started with `--bare`, and cloud sessions, skip plugins.
- Agent SDK sessions started with `settingSources: []` (the SDK's isolation mode) load no plugins, so Aimiru does not see them. Agent SDK sessions with the default options, or with your user settings, load this plugin and are checked.
- A setting that turns off every plugin check (`disableAllHooks`), turning this plugin off, or an `env` setting that changes how the check runs (`NODE_OPTIONS`, `NODE_PATH`, `CLAUDE_PLUGIN_...`, `CLAUDE_CONFIG_DIR`). Aimiru stops that change from applying to the running session and tells Aimiru at once, so the tier changes to Advised. The change applies when Claude Code restarts.
- A `PATH` setting that points `node` at another program. Aimiru does not block it, because many people set `PATH`; if the check stops running, Aimiru stops hearing from this computer and shows Advised after 24 hours.
- A Claude Code mod can approve a call that this plugin declined. Only checks installed through managed settings are final; teams can install Aimiru that way.
- Commands are read by their text. A program Claude wrote and then ran, such as `python pay.py`, is asked about before it runs, but what it does inside is not seen; a program already in your last commit runs as local work, and so does one Claude commits before running it.

## How Aimiru counts what Claude Code would have asked

Today and Your week in Aimiru can show how often Claude Code would have stopped to ask you on its own about the actions Aimiru checked, next to how often Aimiru asked you about the same work. For each action it checks, the plugin works out whether Claude Code in its Manual mode, with the allow, ask and deny lists in your Claude Code settings, would have stopped to ask you. The second number counts Aimiru's questions about the same actions.

- **The fewest times, not the most.** Each command counts once per project, each site once per project, and changes to files once per session, as if you always chose "Yes, and don't ask again".
- **Only questions Aimiru answered for you.** In Manual mode, and in accept edits mode for anything but changes to files in your project, Claude Code still asks you itself whenever Aimiru allows something, so those actions are not counted. Accept edits mode also asks about files Claude Code protects, such as those in `.git` and `.claude`, so those are not counted. An ask rule in your settings, and removing a folder Claude Code protects (your home folder, the project folder or one above it), make Claude Code ask in every mode, so those are not counted either. Nothing is counted in plan mode or in don't ask mode, or when the plugin cannot remember what it counted before.
- **What the plugin cannot see.** Rules given only when Claude Code starts (`--allowedTools`, `--settings`), rules your organization sends from claude.ai, and approvals for one session are not in the settings files, so the count can be higher than what you would really have been asked.
- **An estimate says "about".** When a settings file cannot be read, the count is by kind of action alone, and Aimiru says "about".

The count never changes what Aimiru decides or what Claude Code runs.

## What leaves your computer

- For each check: a short description of the action, cut to 280 characters, and the tool's input, cut to 1,000 characters. Obvious secrets are removed from both first: keys, passwords, bearer values, private keys, and credentials inside addresses, such as chat bot keys and Slack or Discord message addresses. Other text in a file Claude writes is sent as written, up to that length.
- With each check: whether Claude Code would have stopped to ask you on its own (yes, no, or nothing when Aimiru cannot tell), and whether that is an estimate. The plugin works this out on your computer from your Claude Code settings files; the rules in them never leave it.
- After the action: whether it worked, and a fingerprint (sha256) of the result. Never the result itself.
- For a push: the repository it goes to (`github.com/owner/repo`), read from git's own settings on this computer, never with a sign-in in it.
- When you pause: that this computer learned of the Pause and how (while working, or at a step), and how many steps went ahead after your tap.
- Only after `/aimiru:activity`: Claude Code's own activity report, every few seconds while it works. It carries each tool's name and input, whether it worked, who let it run, and each model request's cost and word counts; prompts and responses stay out (Claude Code leaves them out unless you turn them on yourself). Aimiru keeps the tool's name, how it reads the action (a delete, a message), a fingerprint (sha256) of the command and of Claude Code's id for the call, and the counts and costs. It never keeps the input itself.
- At the start of a session: the plugin version, the Claude Code version, whether checks are on, the version of the Aimiru routine the plugin carries, and that this computer takes no work your other agents hand on. In your own terminal, the ids of this computer's questions from the last hour, to hear about a yes that came after Claude Code stopped.
- For each step decided on this computer: the same description, the tool's name, Claude Code's ids for the session and the call, the project's name and fingerprint, a fingerprint of the evidence, when it ran and how long after Aimiru's last word it was decided. Never the step's input itself.

Nothing is printed that contains your key. Records that cannot be sent wait in the plugin's own data folder and are sent later.

## Advanced settings

These are read from the environment Claude Code runs in. Each is also read under its name from before the rename, with `SAYSO_` in place of `AIMIRU_` (`SAYSO_LOCAL_READS`, and so on); when both are set, the `AIMIRU_` one wins.

| Variable | Default | What it changes |
|---|---|---|
| `AIMIRU_CHECK_TIMEOUT_MS` | `10000` | How long a check waits for Aimiru before the fail-closed rule applies |
| `AIMIRU_ASK_BUDGET_MS` | `4000` | How long an ask holds a step before Claude Code moves on, in milliseconds. It can only be made shorter. |
| `AIMIRU_HOOK_BUDGET_MS` | `30000` | The most time one check may take in all, apart from a step held while you have paused (up to 55 minutes). It can only be made shorter. |
| `AIMIRU_LOCAL_READS` | on | Set to `0` to check every step with Aimiru, reads inside your project included |
| `AIMIRU_RECORD_READS` | off | Set to `1` to confirm every finished read too, not only actions that change something |
| `AIMIRU_WAKE_ON_YES` | off | Set to `1` so a yes that comes after Claude Code moved on wakes it to take that step at once |
| `AIMIRU_PAUSE_HOLD` | on | Set to `0` so each step is refused while you have paused, instead of held until you resume. It can only turn the hold off. |
| `AIMIRU_PROJECT` | the project folder's name | The project or client Aimiru files this work under, so your rules can name it ("Never deploy in project client-a") and Activity can show only its work. Only the name and a fingerprint of the folder's path leave this computer, never the path. |

Claude Code started with a settings folder of its own (`CLAUDE_CONFIG_DIR`) works the same way: the key `/aimiru:connect` saves stays in that folder, under `plugins/data`, `/aimiru:activity` changes the `settings.json` there, nothing is written to `~/.claude`, and Aimiru guards that folder's settings as it guards `~/.claude`. Aimiru guards Codex's settings the same way, in `~/.codex` or the folder `CODEX_HOME` names, so Claude Code cannot switch off Codex's check without asking you.

## Uninstall

```bash
claude plugin uninstall aimiru@aimiru
```

When a demo ends, every step is refused with "The demo has ended. To remove Aimiru, run claude plugin uninstall aimiru@aimiru." An install made before the plugin was renamed is still called `sayso`: run `claude plugin uninstall sayso` instead. It applies when Claude Code restarts. To stop the key working as well, remove the agent in Aimiru, under Agents.
