#!/usr/bin/env bash
#
# Install (or remove) the two launchd agents that keep claude-mem's search stack
# working on macOS. Neither job is supervised by claude-mem itself, so without
# this a macOS user ends up with a worker that starts fine and then answers
# every search with a failure.
#
#   dev.ephillipe.claude-mem.deps    Re-runs the dependency self-heal every 5
#                                    minutes. A claude-mem plugin update wipes
#                                    the versioned cache directory the worker
#                                    resolves modules from, and until the link
#                                    is back the worker cannot load its embedder
#                                    or sharp, so searches fail. No KeepAlive:
#                                    this is a repair job that should exit.
#
#   dev.ephillipe.claude-mem.chroma  Runs the Chroma server that actually holds
#                                    the vectors. RunAtLoad plus KeepAlive, so it
#                                    comes up at login and comes back if it dies.
#
# Chroma is installed into a dedicated venv rather than launched via `uvx` on
# purpose: `uvx` re-resolves the package on every boot, which needs the network
# and a working uv cache in a context that has neither guaranteed. A venv gives
# a pinned, offline, absolute-path binary.
#
# Worker supervision is deliberately not handled here. claude-mem owns starting
# its own worker and may start a competing copy; adding a second supervisor here
# would make restarts ambiguous rather than durable.

set -euo pipefail

SCRIPT_DIR="$(cd -P "$(dirname "$0")" && pwd -P)"
REPO_DIR="$(cd -P "$SCRIPT_DIR/.." && pwd -P)"

CHROMA_HOME="${CLAUDE_MEM_CHROMA_HOME:-$HOME/.claude-mem/chroma}"
BIN_DIR="${CLAUDE_MEM_BIN_DIR:-$HOME/.claude-mem/bin}"
VECTOR_DB="${CLAUDE_MEM_VECTOR_DB:-$HOME/.claude-mem/vector-db}"
LOG_DIR="${CLAUDE_MEM_LOG_DIR:-$HOME/.claude-mem/logs}"
CHROMA_HOST="${CLAUDE_MEM_CHROMA_HOST:-127.0.0.1}"
CHROMA_PORT="${CLAUDE_MEM_CHROMA_PORT:-8000}"
DEPS_INTERVAL="${CLAUDE_MEM_DEPS_INTERVAL:-300}"

# The paths the self-heal has to look at. Resolved here and baked into the
# agent's environment, because launchd does not inherit the environment this
# installer was run from, so an override given at install time would otherwise
# be silently dropped.
VENDOR_DIR="${CLAUDE_MEM_VENDOR_DIR:-$HOME/.claude/plugins/cache/thedotmack/claude-mem}"
DEPS_DIR="${CLAUDE_MEM_DEPS_DIR:-$HOME/.claude/plugins/marketplaces/thedotmack/node_modules}"

# Defined here rather than in the preflight, because --uninstall needs the
# installed path too and runs before any of that.
DEPS_SOURCE="$REPO_DIR/scripts/ensure-claude-mem-deps.sh"
DEPS_INSTALLED="$BIN_DIR/ensure-claude-mem-deps.sh"

LAUNCH_AGENTS="$HOME/Library/LaunchAgents"
DEPS_LABEL="dev.ephillipe.claude-mem.deps"
CHROMA_LABEL="dev.ephillipe.claude-mem.chroma"
LABELS=("$DEPS_LABEL" "$CHROMA_LABEL")

DRY_RUN=0
UNINSTALL=0

usage() {
  cat <<'EOF'
Usage: install-claude-mem-durability.sh [--uninstall] [--dry-run] [--help]

Installs or removes the launchd agents that keep claude-mem search working:
a Chroma server that is started at login and restarted if it dies, and a
dependency self-heal that survives claude-mem plugin updates.

  --uninstall   Remove both agents and their plists. Leaves the Chroma venv,
                the vector database and the dependency symlinks in place,
                because deleting someone's 450MB of embeddings is not this
                script's call.
  --dry-run     Print every action and plist without touching the system.
  --help        Show this message.

Environment overrides:
  CLAUDE_MEM_CHROMA_HOME     Where the Chroma venv lives. Default ~/.claude-mem/chroma
  CLAUDE_MEM_BIN_DIR         Where the installed self-heal script lives.
                             Default ~/.claude-mem/bin
  CLAUDE_MEM_VECTOR_DB       The Chroma database directory. Default ~/.claude-mem/vector-db
  CLAUDE_MEM_LOG_DIR         Agent log output. Default ~/.claude-mem/logs
  CLAUDE_MEM_CHROMA_HOST     Address to bind. Default 127.0.0.1
  CLAUDE_MEM_CHROMA_PORT     Port to bind. Default 8000
  CLAUDE_MEM_DEPS_INTERVAL   Seconds between self-heal runs. Default 300
  CLAUDE_MEM_VENDOR_DIR      Parent of the versioned claude-mem plugin cache dirs.
  CLAUDE_MEM_DEPS_DIR        The dependency tree the worker resolves from.
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --uninstall) UNINSTALL=1 ;;
    --dry-run) DRY_RUN=1 ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      echo "install-claude-mem-durability: unknown argument: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
  shift
done

run() {
  if [ "$DRY_RUN" -eq 1 ]; then
    echo "  would run: $*"
  else
    echo "  run: $*"
    "$@"
  fi
}

die() {
  echo "install-claude-mem-durability: $*" >&2
  exit 1
}

note() { echo "  $*"; }

if [ "$(uname -s)" != "Darwin" ]; then
  die "launchd is macOS-only. On other platforms, supervise the worker and Chroma yourself."
fi

domain="gui/$(id -u)"

bootout_agent() {
  local label="$1"
  if [ "$DRY_RUN" -eq 1 ]; then
    echo "  would run: launchctl bootout $domain/$label (if loaded)"
    return 0
  fi
  # Expected to fail when the agent was never installed; that is not an error.
  launchctl bootout "$domain/$label" 2>/dev/null || true
}

uninstall_agents() {
  local label
  for label in "${LABELS[@]}"; do
    bootout_agent "$label"
    if [ "$DRY_RUN" -eq 1 ]; then
      [ -e "$LAUNCH_AGENTS/$label.plist" ] && echo "  would remove: $LAUNCH_AGENTS/$label.plist"
    else
      rm -f "$LAUNCH_AGENTS/$label.plist"
    fi
  done
  if [ "$DRY_RUN" -eq 0 ]; then
    echo "  removed ${#LABELS[@]} launchd agents and their plists"
  fi
}

if [ "$UNINSTALL" -eq 1 ]; then
  echo "Uninstalling claude-mem durability agents"
  uninstall_agents
  if [ "$DRY_RUN" -eq 0 ]; then
    rm -f "$DEPS_INSTALLED"
  else
    echo "  would remove: $DEPS_INSTALLED"
  fi
  cat <<EOF

Left in place on purpose:
  $CHROMA_HOME/venv        Chroma and its pinned dependencies
  $VECTOR_DB               your embeddings
  any node_modules symlinks under the claude-mem plugin cache

Once the Chroma agent is booted out the worker keeps running but reports
searches as unavailable again, which is the state before this was installed.
EOF
  exit 0
fi

# ---------------------------------------------------------------- preflight ---

echo "Checking prerequisites"

VENV_CHROMA="$CHROMA_HOME/venv/bin/chroma"

[ -d "$VECTOR_DB" ] || die "no Chroma database at $VECTOR_DB
  claude-mem has never stored anything, so there is nothing to keep running.
  Install and use claude-mem first, then re-run this script."

[ -f "$DEPS_SOURCE" ] || die "missing $DEPS_SOURCE
  Run this script from a checkout of the opencode-claude-mem repository."

if [ "$DRY_RUN" -eq 0 ]; then
  mkdir -p "$LAUNCH_AGENTS" "$LOG_DIR" "$BIN_DIR"

  # Repair rather than merely check. Refusing to install while the worker cannot
  # load its dependencies would be circular: a broken dependency link is one of
  # the reasons to install this in the first place. What the self-heal cannot
  # fix is the dependency tree itself, and that is the case that makes this
  # fail, with the script's own explanation of what to reinstall.
  if ! "$DEPS_SOURCE"; then
    die "the worker cannot load its dependencies, and they could not be repaired.
  Repair or reinstall claude-mem so that it populates:
    $DEPS_DIR
  then re-run this script."
  fi
  note "worker dependencies resolve"
fi

# launchd cannot execute a script that lives under ~/Documents: macOS treats
# that directory as privacy-protected and the agent is spawned with no TCC
# grant, so the exec fails with EPERM. It can execute from the home directory.
# So the agent runs an installed copy, refreshed from the repo on every install.
install_deps_script() {
  if [ "$DRY_RUN" -eq 1 ]; then
    echo "  would install: $DEPS_SOURCE -> $DEPS_INSTALLED"
    return 0
  fi
  {
    IFS= read -r shebang
    printf '%s\n' "$shebang"
    cat <<'BANNER'
#
# GENERATED FILE, do not edit. Written by install-claude-mem-durability.sh as a
# copy of the repository's scripts/ensure-claude-mem-deps.sh, which launchd
# cannot execute in place because it lives under the privacy-protected
# ~/Documents. Re-run the installer to pick up changes to the original.
BANNER
    cat
  } <"$DEPS_SOURCE" >"$DEPS_INSTALLED.tmp"
  chmod +x "$DEPS_INSTALLED.tmp"
  mv -f "$DEPS_INSTALLED.tmp" "$DEPS_INSTALLED"
  echo "  installed the self-heal to $DEPS_INSTALLED"
}

find_uv() {
  if command -v uv >/dev/null 2>&1; then
    command -v uv
  elif [ -x "$HOME/.local/bin/uv" ]; then
    echo "$HOME/.local/bin/uv"
  elif [ -x "/opt/homebrew/bin/uv" ]; then
    echo "/opt/homebrew/bin/uv"
  fi
}

# ------------------------------------------------------------------- chroma ---

if [ -x "$VENV_CHROMA" ]; then
  echo "Chroma venv already present at $CHROMA_HOME/venv"
else
  uv="$(find_uv || true)"
  [ -n "$uv" ] || die "uv not found, and no Chroma venv to reuse.
  Install uv (https://docs.astral.sh/uv/) or delete $CHROMA_HOME/venv and retry
  once it is on PATH."

  echo "Creating a pinned Chroma venv at $CHROMA_HOME/venv"
  mkdir -p "$CHROMA_HOME"
  run "$uv" venv "$CHROMA_HOME/venv" --python 3.12
  # Install into the venv, not into the caller's active environment.
  VIRTUAL_ENV="$CHROMA_HOME/venv" run "$uv" pip install chromadb
  if [ "$DRY_RUN" -eq 0 ] && [ ! -x "$VENV_CHROMA" ]; then
    die "expected a Chroma binary at $VENV_CHROMA after install"
  fi
fi

# launchd starts jobs with launchd's own PATH, which on a default macOS
# install is /usr/bin:/bin:/usr/sbin:/sbin. Anything the job shells out to, and
# anything that reads the user's config directory, therefore has to be told
# where home is and what PATH is -- otherwise it fails silently.
ENVIRONMENT_VARIABLES="    <key>HOME</key>
    <string>$HOME</string>
    <key>PATH</key>
    <string>$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>"

# The self-heal additionally needs the paths resolved at install time, so that
# an override passed to this installer still applies once launchd runs it.
DEPS_ENVIRONMENT_VARIABLES="    <key>CLAUDE_MEM_VENDOR_DIR</key>
    <string>$VENDOR_DIR</string>
    <key>CLAUDE_MEM_DEPS_DIR</key>
    <string>$DEPS_DIR</string>"

write_plist() {
  local path="$1"
  if [ "$DRY_RUN" -eq 1 ]; then
    echo "  would write: $path"
    return 0
  fi
  cat >"$path"
  echo "  wrote $path"
}

# ------------------------------------------------------------------ the port ---

# Chroma must own the port before it starts, and launchd's KeepAlive would
# otherwise fight a leftover process for it, producing a restart loop that looks
# like Chroma is crashing. A leftover is only stopped when it is recognisably
# the Chroma server for this same database; anything else is left alone and
# reported, because killing an unidentified process is not this script's job.
port_responds() {
  local code
  code="$(curl -s -o /dev/null -m 2 -w '%{http_code}' "http://$CHROMA_HOST:$CHROMA_PORT/api/v2/heartbeat" 2>/dev/null || true)"
  [ -n "$code" ] && [ "$code" != "000" ]
}

stop_leftover_chroma() {
  local pids pid cmd
  pids="$(lsof -nP -iTCP:"$CHROMA_PORT" -sTCP:LISTEN -t 2>/dev/null || true)"
  [ -n "$pids" ] || return 0

  for pid in $pids; do
    cmd="$(ps -o command= -p "$pid" 2>/dev/null || true)"
    case "$cmd" in
      *chroma*"$VECTOR_DB"*)
        note "stopping a leftover Chroma for this database (pid $pid)"
        if [ "$DRY_RUN" -eq 0 ]; then
          kill "$pid" 2>/dev/null || true
          for _ in 1 2 3 4 5 6 7 8 9 10; do
            kill -0 "$pid" 2>/dev/null || break
            sleep 0.3
          done
          kill -0 "$pid" 2>/dev/null && kill -9 "$pid" 2>/dev/null || true
        fi
        ;;
      *)
        die "port $CHROMA_PORT is held by something that is not this database's Chroma:
  pid $pid: $cmd
  Free the port, or set CLAUDE_MEM_CHROMA_PORT to another one and re-run."
        ;;
    esac
  done
}

# ------------------------------------------------------------------- install ---

echo
echo "Installing launchd agents into $LAUNCH_AGENTS"

install_deps_script

# Stop ours first so that the leftover check below never sees our own process,
# and so the port is free before the new Chroma claims it.
uninstall_agents

stop_leftover_chroma

echo
echo "  $CHROMA_LABEL"
write_plist "$LAUNCH_AGENTS/$CHROMA_LABEL.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>$CHROMA_LABEL</string>
    <key>ProgramArguments</key>
    <array>
        <string>$VENV_CHROMA</string>
        <string>run</string>
        <string>--path</string>
        <string>$VECTOR_DB</string>
        <string>--host</string>
        <string>$CHROMA_HOST</string>
        <string>--port</string>
        <string>$CHROMA_PORT</string>
    </array>
    <key>EnvironmentVariables</key>
    <dict>
$ENVIRONMENT_VARIABLES
    </dict>
    <key>WorkingDirectory</key>
    <string>$HOME</string>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>ThrottleInterval</key>
    <integer>10</integer>
    <key>ProcessType</key>
    <string>Background</string>
    <key>StandardOutPath</key>
    <string>$LOG_DIR/chroma.log</string>
    <key>StandardErrorPath</key>
    <string>$LOG_DIR/chroma.err.log</string>
</dict>
</plist>
PLIST

echo
echo "  $DEPS_LABEL"
write_plist "$LAUNCH_AGENTS/$DEPS_LABEL.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>$DEPS_LABEL</string>
    <key>ProgramArguments</key>
    <array>
        <string>/bin/bash</string>
        <string>$DEPS_INSTALLED</string>
    </array>
    <key>EnvironmentVariables</key>
    <dict>
$ENVIRONMENT_VARIABLES
$DEPS_ENVIRONMENT_VARIABLES
    </dict>
    <key>StartInterval</key>
    <integer>$DEPS_INTERVAL</integer>
    <key>StandardOutPath</key>
    <string>$LOG_DIR/deps.log</string>
    <key>StandardErrorPath</key>
    <string>$LOG_DIR/deps.err.log</string>
</dict>
</plist>
PLIST

if [ "$DRY_RUN" -eq 1 ]; then
  echo
  echo "Dry run; nothing was changed."
  exit 0
fi

bootstrap_agent() {
  local label="$1" attempt=0
  if [ "$DRY_RUN" -eq 1 ]; then
    echo "  would run: launchctl bootstrap $domain $LAUNCH_AGENTS/$label.plist"
    return 0
  fi
  # launchd tears a job down asynchronously, so a bootstrap issued right after a
  # bootout can fail with a bare EIO even though the plist is fine and the label
  # is already free. Retry briefly, then give up with something actionable.
  while [ "$attempt" -lt 10 ]; do
    attempt=$((attempt + 1))
    if launchctl bootstrap "$domain" "$LAUNCH_AGENTS/$label.plist" 2>/dev/null; then
      echo "  run: launchctl bootstrap $domain $LAUNCH_AGENTS/$label.plist"
      return 0
    fi
    sleep 1
  done
  die "could not load $label after $attempt attempts.
  Try:  launchctl bootstrap $domain $LAUNCH_AGENTS/$label.plist
  for the underlying error."
}

bootstrap_agent "$CHROMA_LABEL"
bootstrap_agent "$DEPS_LABEL"
# Run the self-heal once now rather than waiting out the interval, so a fresh
# install repairs a broken link immediately. The job has to be loaded first.
if [ "$DRY_RUN" -eq 0 ]; then
  launchctl kickstart -k "$domain/$DEPS_LABEL" || true
  echo "  run: launchctl kickstart -k $domain/$DEPS_LABEL"
else
  echo "  would run: launchctl kickstart -k $domain/$DEPS_LABEL"
fi

for label in "${LABELS[@]}"; do
  if [ "$DRY_RUN" -eq 0 ] && ! launchctl print "$domain/$label" >/dev/null 2>&1; then
    die "launchd did not accept the $label agent.
  Check the plist for typos with: plutil -lint $LAUNCH_AGENTS/$label.plist"
  fi
done

# ------------------------------------------------------------------- verify ---

echo
echo "Verifying Chroma came up"
ready=0
for _ in $(seq 1 30); do
  if port_responds; then
    ready=1
    break
  fi
  sleep 1
done

if [ "$ready" -eq 1 ]; then
  echo "  Chroma is answering on $CHROMA_HOST:$CHROMA_PORT"
else
  echo "  Chroma did not answer on $CHROMA_HOST:$CHROMA_PORT after 30s." >&2
  echo "  Check $LOG_DIR/chroma.err.log" >&2
  exit 1
fi

for label in "${LABELS[@]}"; do
  state="$(launchctl print "$domain/$label" 2>/dev/null | sed -n 's/^[[:space:]]*state = //p' | head -1)"
  note "$label: ${state:-unknown}"
done

cat <<EOF

Installed.

  Chroma   $CHROMA_HOST:$CHROMA_PORT, from $VENV_CHROMA
           started at login, restarted if it dies
  Deps     self-heal every ${DEPS_INTERVAL}s, after claude-mem plugin updates
  Logs     $LOG_DIR

The worker still has to be running for search to work; claude-mem starts that
itself, and this script deliberately does not take it over.
EOF
