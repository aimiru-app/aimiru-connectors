#!/bin/sh
# Aimiru for Claude Code: starts one of the plugin's checks with Node.js (wave 10, snag 6).
#
#   sh with-node.sh <exit code when Node.js is missing> <script> [arguments...]
#
# hooks/hooks.json runs every check through this file. When Node.js is on the path Claude Code
# sees, it simply becomes `node <script>`: the same process, the same input and output. When it is
# not, it says so in Aimiru's words on stderr and exits with the code it was given: 2 for the check
# before each step and the settings guard, so the step is refused as a failed check always is, and
# for the session start, where Claude Code shows the sentence to the person; 0 for the others,
# which must never stop the work (a 2 there would throw away the person's message).
# POSIX sh only.

missing="$1"
shift
if command -v node >/dev/null 2>&1; then
  exec node "$@"
fi
echo "Aimiru needs Node.js 18 or later on the path Claude Code sees. Install it, then restart Claude Code." >&2
exit "$missing"
