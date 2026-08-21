#!/usr/bin/env sh
# Syncle one-command installer.
#
#   curl -fsSL https://raw.githubusercontent.com/osmanahmadxai/SYNCLE/main/install.sh | sh
#
# Add `-s -- up` to start it right away:
#
#   curl -fsSL https://raw.githubusercontent.com/osmanahmadxai/SYNCLE/main/install.sh | sh -s -- up
#
# Requires Docker (with Compose v2) and curl. Nothing else — Node, Postgres and
# Redis all run in containers, and the app image is downloaded prebuilt, so
# there is no compile step and no clone of this repository.
#
# Env overrides:
#   SYNCLE_HOME   where config lives          (default ~/.syncle)
#   SYNCLE_REF    git ref to fetch files from (default: newest release)
#   SYNCLE_IMAGE  app image to run            (default: matching release tag)
set -eu

REPO_RAW="https://raw.githubusercontent.com/osmanahmadxai/SYNCLE"
REPO_API="https://api.github.com/repos/osmanahmadxai/SYNCLE"
IMAGE_REPO="ghcr.io/osmanahmadxai/syncle"

SYNCLE_HOME="${SYNCLE_HOME:-$HOME/.syncle}"
COMPOSE_FILE="$SYNCLE_HOME/docker-compose.app.yml"
ENV_FILE="$SYNCLE_HOME/.env"

info() { printf '\033[36m==>\033[0m %s\n' "$1"; }
die()  { printf '\033[31merror:\033[0m %s\n' "$1" >&2; exit 1; }

command -v curl >/dev/null 2>&1 || die "curl is required."
command -v docker >/dev/null 2>&1 || die "Docker is required. Get it at https://docs.docker.com/get-docker/"
docker compose version >/dev/null 2>&1 || die "Docker Compose v2 is required (bundled with Docker Desktop or the compose plugin)."

# ── 1) Work out which version to install ────────────────────────────────────
# The newest published release by default. Falling back to main keeps the
# installer working before the first release exists.
REF="${SYNCLE_REF:-}"
if [ -z "$REF" ]; then
  REF=$(curl -fsSL "$REPO_API/releases/latest" 2>/dev/null \
        | sed -n 's/.*"tag_name"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' \
        | head -n 1) || true
  [ -n "$REF" ] || REF=main
fi

case "$REF" in
  v*) IMAGE_TAG="$REF" ;;
  *)  IMAGE_TAG="latest" ;;
esac
IMAGE="${SYNCLE_IMAGE:-$IMAGE_REPO:$IMAGE_TAG}"

info "Installing Syncle $REF"

# ── 2) Fetch the compose file and the launcher ──────────────────────────────
mkdir -p "$SYNCLE_HOME"

fetch() {
  curl -fsSL "$REPO_RAW/$REF/$1" -o "$2" \
    || die "could not download $1 from $REF"
}

fetch docker-compose.app.yml "$COMPOSE_FILE"
fetch bin/syncle "$SYNCLE_HOME/syncle"
chmod +x "$SYNCLE_HOME/syncle"

# ── 3) Settings compose reads from $SYNCLE_HOME/.env ────────────────────────
# The master key encrypts saved database credentials and signs session cookies.
# Generating one here beats the compose default (which stores a generated key
# inside the data volume, next to the data it protects). Never regenerate it:
# a new key makes existing stored credentials undecryptable.
new_key() {
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -base64 32
  elif command -v node >/dev/null 2>&1; then
    node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
  else
    head -c 32 /dev/urandom | base64 | tr -d '\n'
  fi
}

touch "$ENV_FILE"
chmod 600 "$ENV_FILE"

if grep -q '^SYNCLE_MASTER_KEY=.\{10\}' "$ENV_FILE" 2>/dev/null; then
  info "Keeping the existing encryption key"
else
  info "Generating an encryption key"
  KEY=$(new_key)
  # drop any empty/short previous entry, then append the real one
  tmp="$ENV_FILE.tmp"
  grep -v '^SYNCLE_MASTER_KEY=' "$ENV_FILE" > "$tmp" 2>/dev/null || true
  printf 'SYNCLE_MASTER_KEY=%s\n' "$KEY" >> "$tmp"
  mv "$tmp" "$ENV_FILE"
  chmod 600 "$ENV_FILE"
fi

# Pin the image so `syncle up` keeps running this version until `syncle update`.
tmp="$ENV_FILE.tmp"
grep -v '^SYNCLE_IMAGE=' "$ENV_FILE" > "$tmp" 2>/dev/null || true
printf 'SYNCLE_IMAGE=%s\n' "$IMAGE" >> "$tmp"
mv "$tmp" "$ENV_FILE"
chmod 600 "$ENV_FILE"

printf '%s\n' "$REF" > "$SYNCLE_HOME/version"

# ── 4) Put the launcher on PATH ─────────────────────────────────────────────
if install -m 0755 "$SYNCLE_HOME/syncle" /usr/local/bin/syncle 2>/dev/null; then
  BIN=/usr/local/bin/syncle
elif command -v sudo >/dev/null 2>&1 && sudo install -m 0755 "$SYNCLE_HOME/syncle" /usr/local/bin/syncle 2>/dev/null; then
  BIN=/usr/local/bin/syncle
else
  mkdir -p "$HOME/.local/bin"
  install -m 0755 "$SYNCLE_HOME/syncle" "$HOME/.local/bin/syncle"
  BIN="$HOME/.local/bin/syncle"
  case ":$PATH:" in
    *":$HOME/.local/bin:"*) ;;
    *) info "Add ~/.local/bin to your PATH:  export PATH=\"\$HOME/.local/bin:\$PATH\"" ;;
  esac
fi

info "Installed launcher at $BIN"

# ── 5) Optionally start immediately (`... | sh -s -- up`) ───────────────────
if [ "${1:-}" = "up" ] || [ "${1:-}" = "--start" ]; then
  exec "$BIN" up
fi

cat <<EOF

Syncle $REF is installed. Start it with:

  syncle up

Then open http://localhost:3002 (the launcher opens it for you).
EOF
