# Aimiru connectors

Aimiru is the home for your agents. You decide once, and Aimiru tells the agent allow, ask or deny, with a reason. You see everything.

The connectors in this repository sit between an agent and what it does. Each one turns the agent's next action into a question for Aimiru, applies the answer before the action runs, and records what happened.

MIT licensed. Read it, run it, change it.

## What each connector can promise

Aimiru shows each agent with the tier that is true for it:

- **Enforced**: Aimiru can stop this agent before a step runs.
- **Guardrail**: the agent's own check holds each step for Aimiru's answer before it runs, and some of the agent's work goes around that check.
- **Advised**: the agent is asked to check with Aimiru, and Aimiru cannot stop it.

| Agent | Tier Aimiru shows | When | Otherwise |
|---|---|---|---|
| Claude Code with Aimiru for Claude Code | Enforced | The plugin is on, its checks are on, and Claude Code is 2.1.295 or later, so a failed check stops the step. | Advised: Claude Code is older, its checks are turned off, or that computer has not reported in for 24 hours. |
| Codex with Aimiru's check for Codex (`aimiru-codex`) | Guardrail | You trusted the check in Codex and it has run there: it holds the commands Codex starts, its file changes and its tool server calls. OpenAI calls Codex's checks "a useful guardrail, not a complete enforcement boundary": Codex's web search, its work in the cloud and what it types into a command already running skip the check (Aimiru asks before Codex starts one it can keep typing into). | Advised: the check is not trusted in Codex yet, checks are turned off, or that computer has not reported in for 24 hours. |

## Install

This repository releases two connectors: Aimiru for Claude Code and Aimiru's check for Codex. Both need an Aimiru account at https://aimiru.app, and Node.js 18 or later on the path the agent sees (check with `node --version`).

### Claude Code

```bash
claude plugin marketplace add aimiru-app/aimiru-connectors
claude plugin install aimiru@aimiru
```

Then start Claude Code, or restart it if it is open, and run `/aimiru:connect` inside it. It opens Aimiru's page to connect it in your browser and shows a code and the same link, which you can open on your phone instead: sign in to Aimiru, pick the same code and tap Connect. To paste a key instead, run `/plugin configure aimiru@aimiru` inside Claude Code, paste the key and the address Aimiru shows under Agents, Add an agent, Claude Code (the address is https://aimiru.app), and restart Claude Code. Details in [`claude-code/README.md`](claude-code/README.md).

### Codex

```bash
npx aimiru-codex init --aimiru-url https://aimiru.app
```

It opens Aimiru's page to connect it in your browser and shows a code and the same link, which you can open on your phone instead: pick the same code and tap Connect. Then open Codex, type `/hooks` and trust "Checking with Aimiru". Codex keeps its own sign-in; we suggest Sign in with ChatGPT, so Codex uses your own plan. Aimiru never asks for or holds your OpenAI key; the check talks to Aimiru with its own key only. Details in [`codex/README.md`](codex/README.md).

### Try the pre-release

A new version goes out first as a pre-release, on the `next` channel: the `next` branch of `aimiru-app/aimiru-connectors` and npm's `next` tag. These lines install the newest pre-release; the lines above install the release. The names, the settings and the remove lines are the same on both. Use one channel at a time.

```bash
claude plugin marketplace add aimiru-app/aimiru-connectors#next
claude plugin install aimiru@aimiru
npx aimiru-codex@next init --aimiru-url https://aimiru.app
```

To switch channel, run `claude plugin marketplace remove aimiru`, then the other channel's two lines, then restart Claude Code and run `/aimiru:connect` again: removing the marketplace removes the plugin and the key it saved. For Codex, run the other channel's line.

## Removing a connector

The lines that take each connector out again. When a demo ends, the connector refuses every step and says which line removes it: "The demo has ended. To remove Aimiru, run ...".

| Agent | Run |
|---|---|
| Claude Code | `claude plugin uninstall aimiru@aimiru`, then `claude plugin marketplace remove aimiru` (either channel) |
| Codex | `npx aimiru-codex uninstall`, then delete `~/.sayso/codex`, which holds your key and the copy of the check (either channel) |

## When Aimiru cannot be reached

Payments, messages, sharing, bookings, deletions and sign-ins are refused while Aimiru cannot be reached; the agent can try again once Aimiru answers. Reading, and work inside your project, continue; their records wait on your computer and are sent when Aimiru answers again.

## What leaves your computer

- A short description of each action, and the tool's input cut to 1,000 characters, after obvious secrets are removed: keys, passwords, bearer values, private keys, and credentials inside addresses.
- After the action: whether it worked, and a fingerprint (sha256) of the result. Never the result itself.
- Where the connector runs: its version, the app's version, and whether checks are on. This is how Aimiru knows which tier is true.
- For a purchase: the store, its web address (the site only), the items with their prices, the total and, afterwards, the order number. Card numbers are removed from anything before it is sent, and payment details stay on your computer.
- Where the connector was installed from, as one word (such as the plugin marketplace or npm), so Aimiru can count installs. Never the folder it sits in.

## Folders

| Folder | What it is |
|---|---|
| `.claude-plugin/` | The marketplace `aimiru`, which lists the plugin |
| `claude-code/` | Aimiru for Claude Code, a Claude Code plugin |
| `codex/` | `aimiru-codex`, Aimiru's check for Codex: Codex's own commands, file changes and tool server calls |
| `shared/` | The code both connectors share, of which each carries its own copy: talking to Aimiru, the fail-closed rule, the waiting queue, secret removal, and how actions are classed |

## This copy

This repository holds the releases of Aimiru for Claude Code and Aimiru's check for Codex, one commit per release. The `next` branch carries pre-releases and `main` the release. `RELEASE.json` names each one's version, the commit of Aimiru's own repository it was made from, where the connectors are built and tested, and a fingerprint of every file. Each release is tagged twice: the plugin's tag starts with `aimiru` and the Codex check's with `codex`.

## Licence

MIT. See [LICENSE](LICENSE).
