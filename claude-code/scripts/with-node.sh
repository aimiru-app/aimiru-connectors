#!/bin/sh
# Aimiru for Claude Code: starts one of the plugin's checks with Node.js (wave 10, snag 6).
#
#   sh with-node.sh <exit code when Node.js is missing> <script> [arguments...]
#
# hooks/hooks.json runs every check through this file, and plugin.json the tool server. It becomes
# `node <script>`: the same input and output. When Node.js cannot be found, it says so in Aimiru's
# words on stderr and exits with the code it was given: 2 for the check before each step and the
# settings guard, so the step is refused as a failed check always is, and for the session start,
# where Claude Code shows the sentence to the person; 0 for the others, which must never stop the
# work (a 2 there would throw away the person's message).
#
# A folder's own Claude Code settings can set any variable for every program Claude Code starts, this
# check included (the security reviews of 0.3.0-rc.6). So the check never runs in that environment:
#   - a folder's settings (the project's and the working folder's) that move the home folder or the
#     folders Claude Code and Aimiru keep their files in stop it here, before anything is read from
#     them, and a proxy or certificate setting they name is left out of the check;
#   - Node.js is the one a session start recorded (.node-path in the plugin's own installed copy,
#     found from this file's own place, owned by this user and writable by nobody else, never in a
#     source checkout, and only while its file is the same one, by inode), else the first on PATH,
#     and either only where every folder and link on its way is a real folder outside the project,
#     /proc and /dev (the home folder is never "the project", by the computer account);
#   - it runs in a new environment holding only what the check reads (ENV_NAMES, below), a PATH of
#     the computer's own folders, and only the Node options that change memory, warnings or which
#     certificate store the computer already trusts; nothing else a folder could set (NODE_OPTIONS,
#     OPENSSL_*, LD_*, DYLD_*, GIT_*, PATH) reaches it;
#   - OpenSSL reads no configuration file (--openssl-config=/dev/null, where there is one).
# What a folder's settings set among the names that do reach it (Aimiru's own settings, a proxy, a
# certificate) is refused by the check itself before anything is sent (lib/runtime.mjs folderTakeover).
# A preload into this shell itself (LD_PRELOAD on Linux) runs before this file: the check can only
# detect it, and does.
# POSIX sh only; every program it runs is named by its full path.

missing="$1"
shift

say_missing() {
  echo "Aimiru needs Node.js 18 or later on the path Claude Code sees. Install it, then restart Claude Code." >&2
  exit "$missing"
}

# The computer account's home folder, never $HOME.
account_home=""
if [ -x /usr/bin/id ]; then
  account_user=$(/usr/bin/id -un 2>/dev/null)
  case "$account_user" in
    '' | *[!A-Za-z0-9._-]*) ;;
    *) account_home=$(eval "cd ~$account_user 2>/dev/null && pwd -P") ;;
  esac
fi
project=""
if [ -n "${CLAUDE_PROJECT_DIR:-}" ]; then
  project=$(cd -P "$CLAUDE_PROJECT_DIR" 2>/dev/null && pwd -P)
fi
case "$project" in
  '' | / | "$account_home") project="" ;;
esac

# place_ok <folder>: a real folder named in full, outside the project, /proc and /dev.
place_ok() {
  case "$1" in
    /*) ;;
    *) return 1 ;;
  esac
  real=$(cd -P "$1" 2>/dev/null && pwd -P) || return 1
  case "$real/" in
    /proc/* | /dev/*) return 1 ;;
  esac
  if [ -n "$project" ]; then
    case "$real/" in
      "$project"/*) return 1 ;;
    esac
  fi
  return 0
}

# node_ok <file>: an executable whose every link, followed to the end, stays in place_ok folders.
# Sets node_real to the file it ends at.
node_ok() {
  target="$1"
  hops=""
  while :; do
    place_ok "${target%/*}" || return 1
    [ -L "$target" ] || break
    hops="${hops}x"
    case "$hops" in
      xxxxxxxxxxxxxxxx*) return 1 ;;
    esac
    link=""
    for reader in /usr/bin/readlink /bin/readlink; do
      if [ -x "$reader" ]; then
        link=$("$reader" "$target" 2>/dev/null)
        break
      fi
    done
    [ -n "$link" ] || return 1
    case "$link" in
      /*) target="$link" ;;
      *) target="${target%/*}/$link" ;;
    esac
  done
  [ -f "$target" ] && [ -x "$target" ] || return 1
  node_real="$target"
  return 0
}

# in_git_tree <folder>: inside a git working tree, whose files a commit can change.
in_git_tree() {
  d="$1"
  while [ -n "$d" ]; do
    [ -e "$d/.git" ] && return 0
    d="${d%/*}"
  done
  return 1
}

# owner_only <path>: owned by this user, and writable by no group and no one else.
owner_only() {
  [ -O "$1" ] || return 1
  mode=$(/bin/ls -ld "$1" 2>/dev/null) || return 1
  mode="${mode%% *}"
  case "$mode" in
    ?????w* | ????????w*) return 1 ;;
  esac
  return 0
}

# inode_of <file>: the file's inode number.
inode_of() {
  line=$(/bin/ls -di "$1" 2>/dev/null) || return 1
  line="${line#"${line%%[! ]*}"}"
  echo "${line%% *}"
}

# A folder's settings, the project's and, when the session works elsewhere (a moved project folder, a
# /cd), the working folder's (the final gate on rc.6). One that moves the home folder, the project or
# the folders Claude Code and Aimiru keep their files in stops the check here, before anything is read
# from them; a proxy or certificate setting, a NODE_OPTIONS or NODE_PATH it names are left out of the
# check's environment, so the person's step goes on and the check reaches Aimiru directly. Aimiru's
# and the plugin's own settings (AIMIRU_*, CLAUDE_PLUGIN_*) reach the check, which refuses every step
# for them and remembers their values. Any mention counts; the check reads the files exactly.
grep_bin=""
for candidate in /usr/bin/grep /bin/grep; do
  if [ -x "$candidate" ]; then
    grep_bin="$candidate"
    break
  fi
done
cksum_bin=""
for candidate in /usr/bin/cksum /bin/cksum; do
  if [ -x "$candidate" ]; then
    cksum_bin="$candidate"
    break
  fi
done
# What a folder's settings set stays in force for as long as this Claude Code carries it (Claude Code
# keeps the environment it applied, even after the file is fixed): each name a folder's file sets is
# remembered with this Claude Code's process (the one that started this file) and a checksum of the
# value it carries, beside this file in the plugin's own copy, never in a place the environment
# names (the gate on 102bfd99e). A fresh Claude Code is another process, so it is not held.
memory=""
self_dir=$(cd -P "${0%/*}" 2>/dev/null && pwd -P)
if [ -n "$self_dir" ] && [ -n "$cksum_bin" ]; then
  memory="${self_dir%/*}/.folder-carried"
fi
# print_of <name>: the checksum of the value this process carries for name; fails when unset.
print_of() {
  eval "carried=\${$1+x}"
  [ "$carried" = x ] || return 1
  eval "carried=\$$1"
  printf '%s' "$carried" | "$cksum_bin" | { read -r sum size rest; echo "$sum.$size"; }
}
# remember <stop|drop> <name>
remember() {
  [ -n "$memory" ] || return 0
  print=$(print_of "$2") || return 0
  line="$PPID $1 $2 $print"
  if [ -f "$memory" ] && "$grep_bin" -qxF "$line" "$memory" 2>/dev/null; then
    return 0
  fi
  (umask 077 && echo "$line" >> "$memory") 2>/dev/null || true
}
stop_moved() {
  echo "This step did not run: $1 move the home folder or the folders Claude Code and Aimiru keep their files in. Do not edit that file, try again or reach the same result another way: tell the person to remove those settings from it, quit Claude Code and start it again." >&2
  exit "$missing"
}
dropped=" "
# folder_file <file> <folder it is shown from>
folder_file() {
  [ -f "$1" ] && [ -n "$grep_bin" ] || return 0
  stops=$("$grep_bin" -Eoi '"(HOME|USERPROFILE|CLAUDE_PROJECT_DIR|CLAUDE_CONFIG_DIR|CLAUDE_PLUGIN_DATA|AIMIRU_PLUGIN_DATA)"' "$1" 2>/dev/null)
  if [ -n "$stops" ]; then
    for found in $stops; do
      found="${found#\"}"
      remember stop "${found%\"}"
    done
    stop_moved "this folder's Claude Code settings (${1#"$2"/})"
  fi
  for found in $("$grep_bin" -Eo '"(HTTP_PROXY|HTTPS_PROXY|ALL_PROXY|NO_PROXY|http_proxy|https_proxy|all_proxy|no_proxy|NODE_USE_ENV_PROXY|NODE_EXTRA_CA_CERTS|SSL_CERT_FILE|SSL_CERT_DIR|NODE_OPTIONS|NODE_PATH)"' "$1" 2>/dev/null); do
    found="${found#\"}"
    found="${found%\"}"
    dropped="$dropped$found "
    remember drop "$found"
  done
}
# folder_settings <folder>: its project and local files, and the local file at its repository's root.
folder_settings() {
  [ -n "$1" ] || return 0
  top="$1"
  while [ -n "$top" ] && [ ! -e "$top/.git" ]; do
    top="${top%/*}"
  done
  [ -n "$top" ] || top="$1"
  folder_file "$1/.claude/settings.json" "$top"
  folder_file "$1/.claude/settings.local.json" "$top"
  [ "$top" = "$1" ] || folder_file "$top/.claude/settings.local.json" "$top"
}
working=$(pwd -P 2>/dev/null)
case "$working" in
  '' | / | "$account_home" | "$project") working="" ;;
esac
folder_settings "$project"
folder_settings "$working"
# What this Claude Code still carries from a folder's settings that are fixed now: held the same way.
if [ -n "$memory" ] && [ -f "$memory" ] && owner_only "$memory"; then
  while read -r pid class name print; do
    [ "$pid" = "$PPID" ] || continue
    [ "$(print_of "$name")" = "$print" ] || continue
    case "$class" in
      stop) stop_moved "this Claude Code still carries settings from a folder's Claude Code settings that" ;;
      drop) dropped="$dropped$name " ;;
    esac
  done < "$memory"
fi

tab=$(printf '\t')
node_bin=""
self_dir=$(cd -P "${0%/*}" 2>/dev/null && pwd -P)
plugin_root="${self_dir%/*}"
record="$plugin_root/.node-path"
if [ -n "$self_dir" ] && [ -f "$record" ] && ! in_git_tree "$plugin_root" && place_ok "$plugin_root" && owner_only "$plugin_root" && owner_only "$record"; then
  line=""
  IFS= read -r line < "$record" || true
  recorded="${line%%"$tab"*}"
  recorded_inode="${line#*"$tab"}"
  if [ -n "$recorded" ] && [ "$recorded" != "$line" ] && node_ok "$recorded" && [ "$(inode_of "$node_real")" = "$recorded_inode" ]; then
    node_bin="$node_real"
  fi
fi
if [ -z "$node_bin" ]; then
  rest="${PATH:-}:"
  while [ -n "$rest" ]; do
    dir="${rest%%:*}"
    rest="${rest#*:}"
    if node_ok "$dir/node"; then
      node_bin="$node_real"
      break
    fi
    if node_ok "$dir/node.exe"; then
      node_bin="$node_real"
      break
    fi
  done
fi
[ -n "$node_bin" ] || say_missing
case "$node_bin" in
  *=*) say_missing ;;
esac
node_dir=$(cd -P "${node_bin%/*}" && pwd -P)

env_bin=""
for candidate in /usr/bin/env /bin/env; do
  if [ -x "$candidate" ]; then
    env_bin="$candidate"
    break
  fi
done
if [ -z "$env_bin" ]; then
  echo "Aimiru could not start its check on this computer, so it did not run. Reinstall the plugin, then restart Claude Code." >&2
  exit "$missing"
fi

# The Node options the check keeps: memory, warnings and the certificate store the computer trusts,
# and none at all when the value holds a quote, a backslash or a path.
kept_options=""
if [ -n "${NODE_OPTIONS:-}" ]; then
  case "$NODE_OPTIONS" in
    *[!A-Za-z0-9=_.,\ -]*) ;;
    *)
      set -f
      for word in $NODE_OPTIONS; do
        case "$word" in
          --max-old-space-size=[0-9]* | --max_old_space_size=[0-9]* | --max-semi-space-size=[0-9]* | --stack-size=[0-9]*) kept_options="$kept_options $word" ;;
          --no-warnings | --no-deprecation | --trace-warnings | --trace-deprecation) kept_options="$kept_options $word" ;;
          --use-system-ca | --use-openssl-ca | --use-bundled-ca) kept_options="$kept_options $word" ;;
          --dns-result-order=ipv4first | --dns-result-order=ipv6first | --dns-result-order=verbatim) kept_options="$kept_options $word" ;;
        esac
      done
      set +f
      ;;
  esac
fi
kept_options="${kept_options# }"
case "$dropped" in
  *" NODE_OPTIONS "*) kept_options="" ;;
esac

# The command, then the environment it runs in, built from the front.
case "$node_bin" in
  *.exe) set -- "$node_bin" "$@" ;;
  *) set -- "$node_bin" --openssl-config=/dev/null "$@" ;;
esac
set -- "PATH=$node_dir:/usr/bin:/bin:/usr/sbin:/sbin:/usr/local/bin:/opt/homebrew/bin:/mingw64/bin:/cmd" "$@"
if [ -n "$kept_options" ]; then
  set -- "NODE_OPTIONS=$kept_options" "$@"
fi
# ENV_NAMES: what the check reads. The computer's own (home, user, language, temporary folder,
# terminal, Windows' system folders); what Claude Code gives a hook; Aimiru's own settings; and a
# proxy or certificate the person set (a folder's are left out above, and refused by the check if one
# reaches it all the same).
for name in \
  HOME USER LOGNAME LANG LC_ALL LC_CTYPE LC_MESSAGES LC_COLLATE LC_NUMERIC LC_TIME LC_MONETARY TMPDIR TERM \
  USERPROFILE APPDATA LOCALAPPDATA SYSTEMROOT SystemRoot WINDIR windir COMSPEC ComSpec PATHEXT TEMP TMP \
  CLAUDECODE CLAUDE_PLUGIN_ROOT CLAUDE_PLUGIN_DATA CLAUDE_PROJECT_DIR CLAUDE_CODE_ENTRYPOINT CLAUDE_CODE_EXECPATH \
  CLAUDE_CODE_REMOTE CLAUDE_CONFIG_DIR CLAUDE_ENV_FILE CLAUDE_PLUGIN_OPTION_AGENT_KEY CLAUDE_PLUGIN_OPTION_AIMIRU_URL AI_AGENT \
  CODEX_HOME \
  AIMIRU_AGENT_TOKEN AIMIRU_BASE_URL AIMIRU_URL AIMIRU_PROJECT AIMIRU_TASK_ID AIMIRU_START_TICKET \
  AIMIRU_CHECK_TIMEOUT_MS AIMIRU_ASK_BUDGET_MS AIMIRU_HOOK_BUDGET_MS AIMIRU_LOCAL_READS AIMIRU_RECORD_READS \
  AIMIRU_WAKE_ON_YES AIMIRU_PAUSE_HOLD AIMIRU_PAUSE_HOLD_CEILING_MS AIMIRU_TAKE_TASKS AIMIRU_WATCH_BUDGET_MS \
  AIMIRU_CLAUDE_VERSION AIMIRU_CLAUDE_BIN AIMIRU_CODEX_BIN AIMIRU_CODEX_DATA AIMIRU_CONNECT_WAIT_S \
  AIMIRU_INSTALL_SOURCE AIMIRU_NO_BROWSER AIMIRU_TOOL_SERVER_RETRY_MS AIMIRU_TOOL_SERVER_WATCH_MS \
  AIMIRU_PLUGIN_AGENT_KEY AIMIRU_PLUGIN_URL AIMIRU_PLUGIN_DATA \
  HTTP_PROXY HTTPS_PROXY ALL_PROXY NO_PROXY http_proxy https_proxy all_proxy no_proxy NODE_USE_ENV_PROXY \
  NODE_EXTRA_CA_CERTS SSL_CERT_FILE SSL_CERT_DIR; do
  case "$dropped" in
    *" $name "*) continue ;;
  esac
  eval "present=\${$name+x}"
  if [ "$present" = x ]; then
    eval "value=\$$name"
    set -- "$name=$value" "$@"
  fi
done

exec "$env_bin" -i "$@"
