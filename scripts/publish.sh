#!/usr/bin/env bash
#
# Publish, with the preflight that actually catches the ways this goes wrong.
#
# The objective is a published package, and the two failure modes that waste a
# release are both invisible until npm rejects the upload:
#
#   1. Authenticated as the wrong npm account. The scope @ephillipe is already
#      owned by an npm account named "ephillipe" (verified: npmjs.com 404s for a
#      user that does not exist and returns 200 for this one). Publishing as any
#      other account is rejected with a permissions error.
#   2. Re-publishing a version that is already on the registry, which the
#      registry refuses outright and which cannot be undone.
#
# Neither is something to discover by running the publish twice.
#
# This never logs in. `npm login` is interactive and needs a human; this script
# reports what is missing and stops.
#
# Usage: publish.sh [--dry-run] [--skip-verify]
#   --dry-run      run every check, then stop short of uploading
#   --skip-verify  skip the tarball install check (it resolves deps over the network)

set -euo pipefail

REPO_DIR="$(cd -P "$(dirname "$0")/.." && pwd -P)"
cd "$REPO_DIR"

DRY_RUN=0
SKIP_VERIFY=0
while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY_RUN=1 ;;
    --skip-verify) SKIP_VERIFY=1 ;;
    --help|-h)
      sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *)
      echo "publish: unknown argument: $1" >&2
      exit 2
      ;;
  esac
  shift
done

NAME="$(node -p "require('./package.json').name")"
VERSION="$(node -p "require('./package.json').version")"
SCOPE="${NAME#@}"
SCOPE="${SCOPE%%/*}"
[ "$SCOPE" = "$NAME" ] && SCOPE=""

die() {
  echo "publish: $*" >&2
  exit 1
}
step() { echo; echo "== $*"; }

# ---------------------------------------------------------------- 1. auth ---

step "Checking authentication"
WHOAMI="$(npm whoami 2>/dev/null || true)"
if [ -z "$WHOAMI" ]; then
  cat >&2 <<EOF
publish: not authenticated with registry.npmjs.org.

  ~/.npmrc on this machine holds only a GitHub Packages token scoped to
  npm.pkg.github.com, which is not accepted by the public registry.

Run this yourself, in a terminal, because it is interactive:

  npm login

It may then ask for a one-time code, if the account has 2FA enabled. Nothing
else is needed; the token npm writes to ~/.npmrc is picked up automatically.
EOF
  exit 1
fi
echo "  authenticated as: $WHOAMI"

if [ -n "$SCOPE" ] && [ "$WHOAMI" != "$SCOPE" ]; then
  echo "  WARNING: the scope @$SCOPE is owned by the npm account named '$SCOPE'," >&2
  echo "           but you are logged in as '$WHOAMI'." >&2
  echo "           The registry will reject this publish on scope permissions." >&2
  echo "           If '$WHOAMI' is an org you administer, this is fine; otherwise" >&2
  echo "           run: npm logout && npm login" >&2
fi

# ------------------------------------------------------ 2. name/version ---

step "Checking what the registry already has"
if npm view "$NAME@$VERSION" version >/dev/null 2>&1; then
  die "$NAME@$VERSION is already published. The registry will not accept it again
  and versions cannot be reused, so bump the version in package.json first."
fi
echo "  $NAME@$VERSION is free"

if npm view "$NAME" version >/dev/null 2>&1; then
  echo "  note: $NAME already has published versions:"
  npm view "$NAME" versions --json 2>/dev/null | sed 's/^/    /'
else
  echo "  $NAME has never been published; this will be the first release"
fi

# ------------------------------------------------------------ 3. the tree ---

step "Checking the tree is green"
bun run typecheck
echo "  typecheck ok"
bun test 2>&1 | tail -4 | sed 's/^/  /'

# ------------------------------------------------------------ 4. the bytes ---

if [ "$SKIP_VERIFY" -eq 1 ]; then
  step "Skipping the tarball install check"
else
  step "Verifying the tarball installs and loads"
  "$REPO_DIR/scripts/verify-tarball.sh" 2>&1 | sed 's/^/  /'
fi

# --------------------------------------------------------- 5. dry publish ---

step "npm publish --dry-run"
npm publish --dry-run 2>&1 | tail -6 | sed 's/^/  /'

# ---------------------------------------------------------------- publish ---

if [ "$DRY_RUN" -eq 1 ]; then
  step "Dry run complete, nothing was uploaded"
  echo "  Re-run without --dry-run to publish $NAME@$VERSION"
  exit 0
fi

step "Publishing $NAME@$VERSION"
npm publish
echo
echo "Published https://www.npmjs.com/package/$NAME/v/$VERSION"
