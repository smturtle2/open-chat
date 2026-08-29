#!/usr/bin/env bash
# ==============================================================================
# OpenChat - Linux One-Line Installer & Updater
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
echo -e "\n${BOLD}[1/6] Checking system prerequisites...${NC}"

# Node.js check
if ! command -v node >/dev/null 2>&1; then
  echo -e "${RED}❌ Node.js is not installed.${NC}"
  echo "Please install Node.js 20 or higher:"
  echo "  curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - && sudo apt-get install -y nodejs"
  exit 1
fi

NODE_VERSION=$(node -v | cut -d'v' -f2 | cut -d'.' -f1)
if [ "$NODE_VERSION" -lt 20 ]; then
  echo -e "${RED}❌ Node.js version $NODE_VERSION is too old. OpenChat requires Node.js 20+.${NC}"
  exit 1
fi
echo -e "  ${GREEN}✓${NC} Node.js $(node -v) detected"

# Git check
if ! command -v git >/dev/null 2>&1; then
  echo -e "${RED}❌ Git is not installed.${NC}"
  echo "Please install Git:"
  echo "  sudo apt update && sudo apt install -y git"
  exit 1
fi
echo -e "  ${GREEN}✓${NC} Git detected"

# Python 3 check (Optional but recommended)
if command -v python3 >/dev/null 2>&1; then
  echo -e "  ${GREEN}✓${NC} Python $(python3 --version | cut -d' ' -f2) detected"
fi

# Docker check & automatic installation
echo -e "\n${BOLD}[2/6] Checking Docker Engine & Sandbox environment...${NC}"
if ! command -v docker >/dev/null 2>&1 || ! docker info >/dev/null 2>&1; then
  echo -e "  ${YELLOW}!${NC} Docker not found or daemon not running. Attempting automatic installation..."
  if command -v curl >/dev/null 2>&1; then
    # Run official Docker installation script
    (curl -fsSL https://get.docker.com -o /tmp/get-docker.sh && (sh /tmp/get-docker.sh 2>/dev/null || sudo sh /tmp/get-docker.sh 2>/dev/null || true)) || true
    rm -f /tmp/get-docker.sh
    # Add user to docker group
    CURRENT_USER="$(whoami 2>/dev/null || echo root)"
    usermod -aG docker "$CURRENT_USER" 2>/dev/null || sudo usermod -aG docker "$CURRENT_USER" 2>/dev/null || true
    # Start docker daemon
    systemctl enable --now docker 2>/dev/null || sudo systemctl enable --now docker 2>/dev/null || service docker start 2>/dev/null || sudo service docker start 2>/dev/null || true
  fi
fi

if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
  echo -e "  ${GREEN}✓${NC} Docker Engine running (Containerized Sandbox available)"
else
  echo -e "  ${YELLOW}!${NC} Docker daemon is not active. OpenChat will operate in Host Agent mode."
fi

# 3. Determine target directory
echo -e "\n${BOLD}[3/6] Setting up OpenChat repository...${NC}"

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
  if [ -n "$(git status --porcelain 2>/dev/null || true)" ]; then
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

# 4. Install Dependencies (Root & Client)
echo -e "\n${BOLD}[4/6] Installing dependencies & building frontend...${NC}"
echo "  📦 Installing backend and core dependencies..."
npm install --no-audit --no-fund

echo "  📦 Installing client frontend dependencies..."
(cd client && npm install --no-audit --no-fund)
echo -e "  ${GREEN}✓${NC} Dependencies installed successfully"

echo "  🔨 Building web application..."
(cd client && npm run build)
echo -e "  ${GREEN}✓${NC} Frontend built successfully"

# 5. Configure Python host tools if python3 is available
echo -e "\n${BOLD}[5/6] Setting up Python utilities...${NC}"
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
    echo -e "  ${YELLOW}!${NC} Optional: install python3-venv for advanced web scraping tools."
  fi
fi

# 6. Environment configuration & Global CLI Launcher
echo -e "\n${BOLD}[6/6] Configuring environment & CLI launcher...${NC}"

# .env configuration
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

# Create global launcher binary
BIN_DIR="$HOME/.local/bin"
mkdir -p "$BIN_DIR"

LAUNCHER="$BIN_DIR/openchat"
cat << EOF > "$LAUNCHER"
#!/usr/bin/env bash
# OpenChat Global Launcher
export OPENCHAT_HOME="\${OPENCHAT_HOME:-\$HOME/.openchat}"
cd "$TARGET_DIR" && exec npm start "\$@"
EOF
chmod +x "$LAUNCHER"
echo -e "  ${GREEN}✓${NC} Created global launcher: $LAUNCHER"

echo -e "\n${BOLD}${GREEN}=======================================================${NC}"
echo -e "${BOLD}${GREEN}   🎉 OpenChat setup & build completed successfully!   ${NC}"
echo -e "${BOLD}${GREEN}=======================================================${NC}"

echo -e "\n${BOLD}How to start OpenChat:${NC}"
if [[ ":$PATH:" == *":$BIN_DIR:"* ]]; then
  echo -e "  Simply run:"
  echo -e "    ${BOLD}${GREEN}openchat${NC}"
else
  echo -e "  Run either:"
  echo -e "    ${BOLD}${GREEN}$LAUNCHER${NC}"
  echo -e "    or"
  echo -e "    ${BOLD}${BLUE}cd $TARGET_DIR && npm start${NC}"
  echo -e "\n  ${YELLOW}Tip:${NC} Add ${BOLD}$BIN_DIR${NC} to your PATH to run ${BOLD}openchat${NC} from anywhere:"
  echo -e "    echo 'export PATH=\"\$HOME/.local/bin:\$PATH\"' >> ~/.bashrc"
fi

echo -e "\nThen open your browser at:"
echo -e "  ${BOLD}${GREEN}http://localhost:3000${NC}\n"
