#!/usr/bin/env bash
# ==============================================================================
# OpenChat - One-Line Installer & Updater
# The Self-Hosted, Open-Source Alternative to ChatGPT & Claude
#
# Usage:
#   Install or Update: curl -fsSL https://raw.githubusercontent.com/smturtle2/open-chat/main/install.sh | bash
# ==============================================================================

set -euo pipefail

BOLD='\033[1m'
GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m' # No Color

echo -e "${BOLD}${BLUE}=======================================================${NC}"
echo -e "${BOLD}${GREEN}   🚀 OpenChat: Self-Hosted AI Assistant Installer   ${NC}"
echo -e "${BOLD}${BLUE}=======================================================${NC}"

# 1. Check prerequisites
echo -e "\n${BOLD}[1/5] Checking system prerequisites...${NC}"

# Node.js check
if ! command -v node >/dev/null 2>&1; then
  echo -e "${RED}❌ Node.js is not installed.${NC}"
  echo "Please install Node.js 20 or higher from https://nodejs.org or via your package manager."
  exit 1
fi

NODE_VERSION=$(node -v | cut -d'v' -f2 | cut -d'.' -f1)
if [ "$NODE_VERSION" -lt 20 ]; then
  echo -e "${RED}❌ Node.js version $NODE_VERSION is too old. Requires Node.js 20+.${NC}"
  exit 1
fi
echo -e "  ${GREEN}✓${NC} Node.js $(node -v) detected"

# Git check
if ! command -v git >/dev/null 2>&1; then
  echo -e "${RED}❌ Git is not installed.${NC}"
  exit 1
fi
echo -e "  ${GREEN}✓${NC} Git detected"

# Python 3 check
if command -v python3 >/dev/null 2>&1; then
  echo -e "  ${GREEN}✓${NC} Python $(python3 --version | cut -d' ' -f2) detected"
fi

# Docker check (Optional)
if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
  echo -e "  ${GREEN}✓${NC} Docker daemon running (Containerized Sandbox available)"
else
  echo -e "  ${YELLOW}!${NC} Docker not found or not running — OpenChat will run in Host Agent mode."
fi

# 2. Determine target directory
echo -e "\n${BOLD}[2/5] Setting up OpenChat repository...${NC}"

TARGET_DIR="${OPENCHAT_DIR:-}"

if [ -z "$TARGET_DIR" ]; then
  if [ -f "package.json" ] && grep -q '"name": "openchat"' "package.json" 2>/dev/null; then
    TARGET_DIR="$(pwd)"
  else
    TARGET_DIR="$HOME/.openchat/app"
  fi
fi

if [ -d "$TARGET_DIR/.git" ]; then
  echo -e "  ${BLUE}ℹ Existing installation found at: $TARGET_DIR${NC}"
  echo -e "  ${BOLD}Updating OpenChat to the latest version...${NC}"
  cd "$TARGET_DIR"
  if [ -n "$(git status --porcelain)" ]; then
    echo -e "  ${YELLOW}!${NC} Local modifications found — preserving local files."
  else
    git fetch origin main >/dev/null 2>&1 || true
    git pull origin main >/dev/null 2>&1 || true
  fi
  echo -e "  ${GREEN}✓${NC} Repository is ready"
else
  echo -e "  ${BOLD}Cloning OpenChat to: $TARGET_DIR...${NC}"
  mkdir -p "$(dirname "$TARGET_DIR")"
  git clone https://github.com/smturtle2/open-chat.git "$TARGET_DIR"
  cd "$TARGET_DIR"
  echo -e "  ${GREEN}✓${NC} Repository cloned successfully"
fi

# 3. Install Dependencies
echo -e "\n${BOLD}[3/5] Installing dependencies...${NC}"
echo "  📦 Installing root dependencies..."
npm install

echo "  📦 Installing frontend dependencies and building web app..."
npm run build
echo -e "  ${GREEN}✓${NC} Frontend built successfully"

# 4. Configure Python host tools if python3 is available
echo -e "\n${BOLD}[4/5] Setting up Python utilities...${NC}"
if command -v python3 >/dev/null 2>&1; then
  if [ ! -f ".venv/bin/pip" ]; then
    rm -rf .venv >/dev/null 2>&1 || true
    python3 -m venv .venv 2>/dev/null || true
  fi
  if [ -f ".venv/bin/pip" ]; then
    .venv/bin/pip install --upgrade pip requests beautifulsoup4 markdownify >/dev/null 2>&1 || true
    echo -e "  ${GREEN}✓${NC} Python virtual environment configured"
  elif command -v pip3 >/dev/null 2>&1; then
    pip3 install --user requests beautifulsoup4 markdownify >/dev/null 2>&1 || true
    echo -e "  ${GREEN}✓${NC} Python packages installed"
  else
    echo -e "  ${YELLOW}!${NC} Optional: install python3-pip or python3-venv for advanced web scraping tools."
  fi
fi

# 5. Environment configuration
echo -e "\n${BOLD}[5/5] Checking configuration...${NC}"
if [ ! -f .env ]; then
  cat << 'EOF' > .env
# OpenChat Configuration
PORT=3000
LLM_BASE_URL=https://opencode.ai/zen/go/v1
LLM_MODEL=muse-spark-1.2-contributor
LLM_API_KEY=
OPENCHAT_THOUGHT_RETENTION=task
EOF
  echo -e "  ${GREEN}✓${NC} Created .env template"
else
  echo -e "  ${GREEN}✓${NC} Existing .env preserved"
fi

echo -e "\n${BOLD}${GREEN}=======================================================${NC}"
echo -e "${BOLD}${GREEN}   🎉 OpenChat setup & build completed successfully!   ${NC}"
echo -e "${BOLD}${GREEN}=======================================================${NC}"
echo -e "\nTo start OpenChat, run:"
echo -e "  ${BOLD}${BLUE}cd $TARGET_DIR && npm start${NC}"
echo -e "\nThen open your browser at:"
echo -e "  ${BOLD}${GREEN}http://localhost:3000${NC}\n"
