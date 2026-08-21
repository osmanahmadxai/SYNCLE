#!/usr/bin/env sh
# Syncle one-command installer.
#
#   curl -fsSL https://raw.githubusercontent.com/osmanahmadxai/SYNCLE/main/install.sh | sh
#
# Add `-s -- up` to also build and start it right away:
#
#   curl -fsSL https://raw.githubusercontent.com/osmanahmadxai/SYNCLE/main/install.sh | sh -s -- up
#
# Requires: Docker (with Compose v2) and git. Nothing else — Node, Postgres and
# Redis all run inside containers.
set -eu

REPO="${SYNCLE_REPO:-https://github.com/osmanahmadxai/SYNCLE.git}"
SYNCLE_HOME="${SYNCLE_HOME:-$HOME/.syncle}"
APP_DIR="$SYNCLE_HOME/app"

info() { printf '\033[36m==>\033[0m %s\n' "$1"; }
die()  { printf '\033[31merror:\033[0m %s\n' "$1" >&2; exit 1; }

command -v git >/dev/null 2>&1 || die "git is required. Install it and re-run."
command -v docker >/dev/null 2>&1 || die "Docker is required. Get it at https://docs.docker.com/get-docker/"
docker compose version >/dev/null 2>&1 || die "Docker Compose v2 is required (bundled with Docker Desktop or the compose plugin)."

# 1) Fetch or update the app. Installs track the latest release tag; set
#    SYNCLE_CHANNEL=main to ride the development branch instead.
CHANNEL="${SYNCLE_CHANNEL:-release}"
if [ -d "$APP_DIR/.git" ]; then
  info "Updating Syncle in $APP_DIR"
  git -C "$APP_DIR" fetch --tags --quiet origin
else
  info "Cloning Syncle into $APP_DIR"
  mkdir -p "$SYNCLE_HOME"
  git clone "$REPO" "$APP_DIR"
fi
if [ "$CHANNEL" = "main" ]; then
  git -C "$APP_DIR" checkout --quiet main
  git -C "$APP_DIR" pull --ff-only
else
  TAG=$(git -C "$APP_DIR" tag --list 'v*' --sort=-v:refname | head -n 1)
  if [ -n "$TAG" ]; then
    info "Using release $TAG (SYNCLE_CHANNEL=main for the development branch)"
    git -C "$APP_DIR" checkout --quiet "$TAG"
  else
    info "No release tags found — using main"
    git -C "$APP_DIR" checkout --quiet main
    git -C "$APP_DIR" pull --ff-only
  fi
fi

# 2) Install the `syncle` launcher onto PATH.
LAUNCHER="$APP_DIR/bin/syncle"
chmod +x "$LAUNCHER"
if install -m 0755 "$LAUNCHER" /usr/local/bin/syncle 2>/dev/null; then
  BIN=/usr/local/bin/syncle
elif command -v sudo >/dev/null 2>&1 && sudo install -m 0755 "$LAUNCHER" /usr/local/bin/syncle 2>/dev/null; then
  BIN=/usr/local/bin/syncle
else
  mkdir -p "$HOME/.local/bin"
  install -m 0755 "$LAUNCHER" "$HOME/.local/bin/syncle"
  BIN="$HOME/.local/bin/syncle"
  case ":$PATH:" in
    *":$HOME/.local/bin:"*) ;;
    *) info "Add ~/.local/bin to your PATH:  export PATH=\"\$HOME/.local/bin:\$PATH\"" ;;
  esac
fi

info "Installed launcher at $BIN"

# 3) Optionally start immediately when invoked as `... | sh -s -- up`.
if [ "${1:-}" = "up" ] || [ "${1:-}" = "--start" ]; then
  info "Starting Syncle (first run builds the image — this can take a few minutes)"
  exec "$BIN" up
fi

cat <<EOF

Syncle is installed. Start it with:

  syncle up

Then open http://localhost:3002 (the launcher opens it for you).
EOF
