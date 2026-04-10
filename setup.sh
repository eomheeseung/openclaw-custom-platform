#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────
#  OpenClaw Custom Platform — Setup Script
#  TideClaw 커스터마이징 자동 설치
# ─────────────────────────────────────────────────────────────
set -e

# ───── Configuration ─────
OPENCLAW_REPO="https://github.com/openclaw/openclaw.git"
OPENCLAW_COMMIT="64432f8e469cfc4e97fb792edf6fbd786d98060f"
TARGET_DIR="/opt/openclaw"

# Source = 이 스크립트가 있는 디렉토리
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# ───── Colors ─────
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

step() { echo -e "${BLUE}==>${NC} $1"; }
ok()   { echo -e "${GREEN} ✓${NC}  $1"; }
warn() { echo -e "${YELLOW} !${NC}  $1"; }
err()  { echo -e "${RED} ✗${NC}  $1"; }

# ───── Pre-flight checks ─────
step "Checking prerequisites"

if [ "$EUID" -ne 0 ]; then
  err "Run as root: sudo ./setup.sh"
  exit 1
fi

for cmd in git docker node; do
  if ! command -v "$cmd" >/dev/null 2>&1; then
    err "$cmd not found. Install it first."
    exit 1
  fi
done

if ! docker compose version >/dev/null 2>&1; then
  err "docker compose v2 not found"
  exit 1
fi

NODE_MAJOR=$(node -v | sed 's/v\([0-9]*\).*/\1/')
if [ "$NODE_MAJOR" -lt 22 ]; then
  warn "Node.js 22+ recommended (you have $(node -v))"
fi

ok "Prerequisites OK"

# ───── 1. Create target directory ─────
step "Creating target directory $TARGET_DIR"
mkdir -p "$TARGET_DIR"
ok "Target directory ready"

# ───── 2. Clone or update OpenClaw ─────
step "Cloning OpenClaw upstream (commit $OPENCLAW_COMMIT)"
if [ ! -d "$TARGET_DIR/repo" ]; then
  git clone "$OPENCLAW_REPO" "$TARGET_DIR/repo"
  ok "Cloned OpenClaw"
else
  warn "$TARGET_DIR/repo already exists, fetching updates..."
  cd "$TARGET_DIR/repo"
  git fetch origin
fi

cd "$TARGET_DIR/repo"
git checkout "$OPENCLAW_COMMIT"
ok "OpenClaw locked to $OPENCLAW_COMMIT"

# ───── 3. Copy customization files ─────
step "Copying TideClaw customization"

cp -r "$SCRIPT_DIR/nginx"     "$TARGET_DIR/"
cp -r "$SCRIPT_DIR/bootstrap" "$TARGET_DIR/"
cp -r "$SCRIPT_DIR/scripts"   "$TARGET_DIR/"
cp -r "$SCRIPT_DIR/plugins"   "$TARGET_DIR/"
cp    "$SCRIPT_DIR/docker-compose.yml" "$TARGET_DIR/"

# Make scripts executable
chmod +x "$TARGET_DIR/scripts/bin/dooray" 2>/dev/null || true

ok "Customization files copied"

# ───── 4. Setup data directory for user01 (default) ─────
step "Initializing default user (user01)"

if [ ! -d "$TARGET_DIR/data/user01" ]; then
  mkdir -p "$TARGET_DIR/data"
  cp -r "$SCRIPT_DIR/data-template" "$TARGET_DIR/data/user01"
  # BOOTSTRAP.md 마운트는 docker-compose가 처리
  ok "user01 data initialized"
else
  warn "user01 data already exists, skipping"
fi

# Shared documents directory
mkdir -p "$TARGET_DIR/shared/user01"

# OAuth tokens directory (empty, user must auth via web)
mkdir -p "$TARGET_DIR/auth/tokens"

# ───── 5. Build custom-ui ─────
step "Building custom-ui (React)"

mkdir -p "$TARGET_DIR/shared/user01/custom-ui"
cp -r "$SCRIPT_DIR/custom-ui/." "$TARGET_DIR/shared/user01/custom-ui/"

cd "$TARGET_DIR/shared/user01/custom-ui"
if [ -f "package-lock.json" ]; then
  npm install
elif [ -f "pnpm-lock.yaml" ]; then
  pnpm install
else
  npm install
fi

npx vite build

# Deploy built files to nginx-served directory
mkdir -p "$TARGET_DIR/custom-ui/assets"
cp -r dist/* "$TARGET_DIR/custom-ui/"

ok "custom-ui built and deployed"

# ───── 6. Build OpenClaw image ─────
step "Building OpenClaw Docker image (this may take a few minutes)"
cd "$TARGET_DIR"
docker compose build openclaw-user01
ok "Docker image built"

# ───── 7. Start services ─────
step "Starting services"
docker compose up -d
ok "Services started"

# ───── 8. Show status ─────
echo
step "Setup complete!"
docker compose ps

echo
echo -e "${GREEN}==================================================${NC}"
echo -e "${GREEN}  OpenClaw Custom Platform installed.${NC}"
echo -e "${GREEN}==================================================${NC}"
echo
echo "  Web UI:        http://localhost"
echo "  API server:    http://localhost:18799"
echo "  Data dir:      $TARGET_DIR/data/"
echo
echo "  Add a new user:"
echo "    sudo $TARGET_DIR/scripts/add-user.sh 02"
echo
echo "  View logs:"
echo "    docker compose -f $TARGET_DIR/docker-compose.yml logs -f"
echo
