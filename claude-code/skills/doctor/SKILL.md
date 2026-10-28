---
name: doctor
description: Check that Aimiru for Claude Code is installed, connected and able to stop actions. Use when the person asks whether Aimiru is working, or after Aimiru reports a problem.
---

Run this command and show the person its output exactly as printed, then explain any line that starts with `!!` and its fix in one sentence each:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/doctor.mjs"
```

The doctor never prints the Aimiru key. Claude Code keeps the key in the computer's keychain, so from inside a session the doctor reports the last session's connection instead of making a new one.
