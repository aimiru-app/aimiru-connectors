---
name: activity
description: Send Claude Code's own activity to Aimiru, so Aimiru can show how many risky actions checked with Aimiru first, what Claude Code ran without checking, and model spend. Use when the person asks to see what Claude Code did next to what it checked, or to turn that off (--off).
---

Run this command on its own, exactly as written (only `--off` or `--status` may follow it), and show the person its output exactly as printed. It never prints the Aimiru key.

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/activity.mjs"
```

- It changes only Claude Code's own settings file (`~/.claude/settings.json`, or `settings.json` in the folder `CLAUDE_CONFIG_DIR` names when Claude Code was started with one): the activity settings and a small helper in the plugin's own folder that hands Claude Code the key when it sends a report. The key itself is never written into a settings file.
- If it says Claude Code already sends its activity somewhere else, tell the person; do not edit their settings to make room.
- To stop, run it with `--off`. To check, run it with `--status`.
- Claude Code starts sending after it restarts.
