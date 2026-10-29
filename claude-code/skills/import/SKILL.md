---
name: import
description: Bring what Claude Code already knows about the person into their Aimiru, with their OK. It reads only their own CLAUDE.md, this project's CLAUDE.md and Claude Code's own notes on this project, on this computer, shows the short facts about them it picked, and sends only the ones they keep. Only the person starts it, by typing /aimiru:import.
disable-model-invocation: true
---

The person typed /aimiru:import: that is their OK to read the files. Do these steps in order.

1. Run this command on its own, exactly as written, and show the person its output exactly as printed. It reads the files and sends nothing.

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/import.mjs"
```

2. If it listed numbered lines, ask the person which may go to Aimiru, with your question tool when you have one: all of them, none, or all but some (by their numbers). Never choose for them, never send before they answer, and never change, add to or reword a line.

3. Then run exactly one of these and show its output exactly as printed:
   - All of them: `node "${CLAUDE_PLUGIN_ROOT}/scripts/import.mjs" --send`
   - All but some: `node "${CLAUDE_PLUGIN_ROOT}/scripts/import.mjs" --send --leave-out 2 5`, with the numbers they named
   - None: `node "${CLAUDE_PLUGIN_ROOT}/scripts/import.mjs" --none`

Only the lines shown in step 1 can be sent, for 30 minutes. Aimiru reads every line again: it refuses keys and instructions, and private lines wait for the person in Aimiru, under Memory. If the person asks what was read, the output of step 1 lists the files. Never open those files yourself for this.
