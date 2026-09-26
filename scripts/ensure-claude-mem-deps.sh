#!/usr/bin/env bash
#
# Make sure the claude-mem worker can resolve its npm dependencies.
#
# The worker is a prebuilt bundle that does `import` of real packages (chroma's
# embedder, sharp, ...). claude-mem installs those with `bun install` at the
# marketplace root, but the worker itself runs from a *versioned* plugin cache
# directory that ships no node_modules of its own. So the cache directory needs
# a node_modules pointing at the marketplace install, and plugin updates wipe
# that directory and create a new one -- which is why this has to be re-runnable
# rather than a one-time setup step.
#
# There is a second failure mode this guards against: a node_modules tree that
# *looks* complete but cannot load sharp, because sharp dlopens a versioned
# libvips dylib that the tree is missing or has the wrong version for. That
# presents as ERR_DLOPEN_FAILED on libvips-cpp.*.dylib, deep inside a worker
# that otherwise starts fine.
#
# Exit codes:
#   0  every worker directory resolves to a usable tree (or there is nothing to do)
#   1  a directory is broken and could not be repaired
#   2  bad usage
#
# This script is idempotent and safe to run from launchd every few minutes.
# It is a no-op when everything is already correct, so it does not need to know
# whether it has run before.

set -euo pipefail

VENDOR_DIR="${CLAUDE_MEM_VENDOR_DIR:-$HOME/.claude/plugins/cache/thedotmack/claude-mem}"
DEPS_DIR="${CLAUDE_MEM_DEPS_DIR:-$HOME/.claude/plugins/marketplaces/thedotmack/node_modules}"

CHECK_ONLY=0
VERBOSE=0

usage() {
  cat <<'EOF'
Usage: ensure-claude-mem-deps.sh [--check] [--verbose] [--help]

Ensures every versioned claude-mem plugin cache directory has a node_modules
that the worker can actually load from.

  --check     Report what is broken, change nothing. Exits non-zero if a
              repair is needed, which makes it usable as a health check.
  --verbose   Print progress even when there is nothing to repair.
  --help      Show this message.

Environment overrides:
  CLAUDE_MEM_VENDOR_DIR  Parent of the versioned plugin cache directories.
                          Default: ~/.claude/plugins/cache/thedotmack/claude-mem
  CLAUDE_MEM_DEPS_DIR    The dependency tree to link to.
                          Default: ~/.claude/plugins/marketplaces/thedotmack/node_modules
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --check) CHECK_ONLY=1 ;;
    --verbose|-v) VERBOSE=1 ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      echo "ensure-claude-mem-deps: unknown argument: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
  shift
done

say() { [ "$VERBOSE" -eq 1 ] && echo "ensure-claude-mem-deps: $*" || true; }
warn() { echo "ensure-claude-mem-deps: $*" >&2; }
fail() { warn "$*"; exit 1; }

# The loadable libvips that sharp dlopens is platform specific, so probe for
# whatever this OS actually ships rather than hardcoding one filename.
case "$(uname -s)" in
  Darwin) LIBVIPES_GLOB='libvips-cpp*.dylib' ;;
  Linux)  LIBVIPES_GLOB='libvips.so*' ;;
  *)      LIBVIPES_GLOB='libvips*' ;;
esac

# A tree is usable only if it resolves the embedder and has a libvips to load.
# Checking for the embedder alone would happily accept a tree that still dies
# on the first search.
tree_is_usable() {
  local root="$1"
  [ -d "$root" ] || return 1
  [ -d "$root/@chroma-core/default-embed" ] || return 1
  [ -n "$(find "$root" -maxdepth 8 -name "$LIBVIPES_GLOB" -print -quit 2>/dev/null)" ] || return 1
  return 0
}

if [ ! -d "$VENDOR_DIR" ]; then
  # No plugin cache means claude-mem is not installed here. That is not an
  # error: this script may run on a machine that never had the plugin.
  say "no plugin cache at $VENDOR_DIR, nothing to do"
  exit 0
fi

if [ "$CHECK_ONLY" -eq 1 ]; then
  if tree_is_usable "$DEPS_DIR"; then
    say "dependency tree at $DEPS_DIR is usable"
  else
    fail "dependency tree at $DEPS_DIR is missing or unusable (need @chroma-core/default-embed and a $LIBVIPES_GLOB)"
  fi
fi

# The link target must be good *before* we point anything at it, otherwise we
# replace one broken tree with another.
if ! tree_is_usable "$DEPS_DIR"; then
  fail "dependency tree at $DEPS_DIR is missing or unusable
  claude-mem is expected to install its dependencies there.
  Reinstall or update the claude-mem plugin, then re-run this script.
  (need @chroma-core/default-embed and a $LIBVIPES_GLOB)"
fi

# Place a symlink without ever leaving the destination absent. Renaming a
# fully-formed link into place is a single rename(2), so a worker that happens
# to be resolving modules at this instant sees either the old link or the new
# one, never a gap.
link_atomically() {
  local target="$1" dest="$2" tmp
  tmp="$(dirname "$dest")/.$(basename "$dest").tmp.$$"
  rm -f "$tmp"
  ln -s "$target" "$tmp"
  if ! mv -f "$tmp" "$dest" 2>/dev/null; then
    rm -f "$tmp"
    return 1
  fi
  return 0
}

# Print the physical path a directory or symlink resolves to, or nothing if it
# does not resolve. Symlinks are followed, so a link to a deleted target prints
# nothing and reads as broken rather than silently as "absent".
resolve() {
  [ -d "$1" ] || return 0
  (cd -P "$1" 2>/dev/null && pwd -P) || true
}

points_at() {
  local dest="$1" target="$2" got want
  [ -L "$dest" ] || return 1
  got="$(resolve "$dest")"
  want="$(resolve "$target")"
  [ -n "$got" ] && [ "$got" = "$want" ]
}

repaired=0
failed=0

# One worker directory per installed plugin version, so that an update adding a
# new version is covered without touching the installer.
for version_dir in "$VENDOR_DIR"/*/; do
  [ -d "$version_dir" ] || continue
  version_dir="${version_dir%/}"
  name="$(basename "$version_dir")"
  dest="$version_dir/node_modules"

  if points_at "$dest" "$DEPS_DIR"; then
    say "$name: already linked"
    continue
  fi

  if [ -L "$dest" ]; then
    reason="$(readlink "$dest")"
  elif [ -d "$dest" ]; then
    if tree_is_usable "$dest"; then
      say "$name: has its own usable node_modules, leaving it alone"
      continue
    fi
    # A real but unusable tree is the bun-cache failure: present, plausible,
    # and unable to load sharp. Do not delete it -- move it aside so the fix
    # is reversible and nothing is lost.
    reason="own node_modules, unusable (no loadable $LIBVIPES_GLOB or no @chroma-core/default-embed)"
  else
    reason="missing"
  fi

  echo "ensure-claude-mem-deps: $name: $reason, linking $DEPS_DIR" >&2

  if [ "$CHECK_ONLY" -eq 1 ]; then
    failed=1
    continue
  fi

  if [ -d "$dest" ] && [ ! -L "$dest" ]; then
    stash="$dest.unusable.$(date +%Y%m%d%H%M%S)"
    if ! mv "$dest" "$stash"; then
      warn "$name: could not move the unusable node_modules aside, leaving it untouched"
      failed=1
      continue
    fi
    echo "ensure-claude-mem-deps: $name: kept the old tree at $stash" >&2
  elif [ -e "$dest" ] || [ -L "$dest" ]; then
    # A wrong or dangling symlink. Removing it is safe: the tree is already
    # unusable, so the brief absence is not a new failure.
    rm -f "$dest"
  fi

  if link_atomically "$DEPS_DIR" "$dest"; then
    repaired=1
    echo "ensure-claude-mem-deps: $name: linked" >&2
  else
    warn "$name: failed to create the symlink"
    failed=1
  fi
done

if [ "$CHECK_ONLY" -eq 1 ]; then
  [ "$failed" -eq 0 ] || fail "one or more worker directories need a node_modules link"
  say "every worker directory resolves to a usable tree"
  exit 0
fi

if [ "$failed" -eq 1 ]; then
  fail "one or more worker directories could not be repaired"
fi

if [ "$repaired" -eq 1 ]; then
  echo "ensure-claude-mem-deps: repaired; the worker picks this up on its next start" >&2
else
  say "nothing to repair"
fi

exit 0
