---
name: connect
description: Connect Aimiru for Claude Code to the person's Aimiru without copying a key. It opens Aimiru's page to connect it in the person's browser, and shows a code and the same link for a phone; the person picks that code and taps Connect. Use when the person asks to set up or connect Aimiru, or when Aimiru says it is not connected.
---

Run this command on its own, exactly as written (only the options below may follow it), and show the person its output exactly as printed. It never prints the Aimiru key. Before Aimiru is connected, Aimiru lets only this command through as it is, and Claude Code asks the person before it runs with an address.

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/connect.mjs"
```

- Run it with the longest time limit Claude Code allows a command: 10 minutes (600000 ms). It opens the page in the person's browser, then keeps waiting while they connect it, saying each minute how long the code has left. Waiting is not an error.
- If the output ends with "Still waiting", run the same command again: it keeps the same code, and the person may still be on the page.
- It uses the Aimiru address the plugin was installed with, else https://aimiru.app. If the person's Aimiru shows another address, run it with `--url <address>`.
- If the person already uses Aimiru with alerts on their phone, add `--email <their email>` so the request also reaches their phone.
- Never ask the person for the key, never read the key file, and never pick or guess the code for them: only the person picks it.
