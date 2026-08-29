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
echo -e "\n${BOLD}[1/7] Checking system prerequisites...${NC}"

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
echo -e "\n${BOLD}[2/7] Checking Docker Engine & Sandbox environment...${NC}"
if ! command -v docker >/dev/null 2>&1 || ! docker info >/dev/null 2>&1; then
  echo -e "  ${YELLOW}!${NC} Docker not found or daemon not running. Attempting automatic installation..."
  if command -v curl >/dev/null 2>&1; then
    (curl -fsSL https://get.docker.com -o /tmp/get-docker.sh && (sh /tmp/get-docker.sh 2>/dev/null || sudo sh /tmp/get-docker.sh 2>/dev/null || true)) || true
    rm -f /tmp/get-docker.sh
    CURRENT_USER="$(whoami 2>/dev/null || echo root)"
    usermod -aG docker "$CURRENT_USER" 2>/dev/null || sudo usermod -aG docker "$CURRENT_USER" 2>/dev/null || true
    systemctl enable --now docker 2>/dev/null || sudo systemctl enable --now docker 2>/dev/null || service docker start 2>/dev/null || sudo service docker start 2>/dev/null || true
  fi
fi

if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
  echo -e "  ${GREEN}✓${NC} Docker Engine running (Containerized Sandbox available)"
else
  echo -e "  ${YELLOW}!${NC} Docker daemon is not active. OpenChat will operate in Host Agent mode."
fi

# 3. Determine target directory
echo -e "\n${BOLD}[3/7] Setting up OpenChat repository...${NC}"

TARGET_DIR="${OPENCHAT_DIR:-$HOME/.openchat/app}"

if [ -d "$TARGET_DIR/.git" ]; then
  echo -e "  ${BLUE}ℹ Existing installation found at: $TARGET_DIR${NC}"
  echo -e "  ${BOLD}Updating OpenChat to the latest version...${NC}"
  cd "$TARGET_DIR"

  # Backup .env if exists
  if [ -f ".env" ]; then
    cp -f .env /tmp/.openchat.env.bak 2>/dev/null || true
  fi

  # Force discard all local uncommitted changes and reset to origin/main
  git remote set-url origin https://github.com/smturtle2/open-chat.git 2>/dev/null || true
  git fetch --all --prune
  git checkout -f -B main origin/main
  git reset --hard origin/main
  git clean -fd -e .env -e .venv

  if [ -f "/tmp/.openchat.env.bak" ]; then
    cp -f /tmp/.openchat.env.bak .env 2>/dev/null || true
    rm -f /tmp/.openchat.env.bak 2>/dev/null || true
  fi

  echo -e "  ${GREEN}✓${NC} Repository updated to latest version ($(git rev-parse --short HEAD))"
else
  echo -e "  ${BOLD}Cloning OpenChat to: $TARGET_DIR...${NC}"
  mkdir -p "$(dirname "$TARGET_DIR")"
  git clone https://github.com/smturtle2/open-chat.git "$TARGET_DIR"
  cd "$TARGET_DIR"
  echo -e "  ${GREEN}✓${NC} Repository cloned successfully"
fi

# 4. Install Dependencies (Root & Client)
echo -e "\n${BOLD}[4/7] Installing dependencies & building frontend...${NC}"
echo "  📦 Installing backend and core dependencies..."
npm install --no-audit --no-fund

echo "  📦 Installing client frontend dependencies..."
(cd client && npm install --no-audit --no-fund)
echo -e "  ${GREEN}✓${NC} Dependencies installed successfully"

echo "  🔨 Building web application..."
(cd client && npm run build)
echo -e "  ${GREEN}✓${NC} Frontend built successfully"

# 5. Configure Python host tools if python3 is available
echo -e "\n${BOLD}[5/7] Setting up Python utilities...${NC}"
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

# 6. Pre-build Docker Sandbox environment
echo -e "\n${BOLD}[6/7] Preparing Docker Sandbox environment...${NC}"
if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
  if docker image inspect openchat-sandbox:v2 >/dev/null 2>&1; then
    echo -e "  ${GREEN}✓${NC} Docker sandbox image (openchat-sandbox:v2) ready"
  else
    echo "  🐳 Pre-building Docker sandbox image (openchat-sandbox:v2)..."
    if [ -f "Dockerfile.sandbox" ]; then
      docker build -f Dockerfile.sandbox -t openchat-sandbox:v2 . >/dev/null 2>&1 || true
    fi
    if docker image inspect openchat-sandbox:v2 >/dev/null 2>&1; then
      echo -e "  ${GREEN}✓${NC} Docker sandbox image built successfully"
    else
      echo -e "  ${YELLOW}!${NC} Docker sandbox image will build on first tool execution."
    fi
  fi
else
  echo -e "  ${BLUE}ℹ${NC} Docker unavailable — running in host agent mode"
fi

# 7. Environment configuration & Global CLI Launcher
echo -e "\n${BOLD}[7/7] Configuring environment & CLI launcher...${NC}"

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

# Create global launcher binary with service management
BIN_DIR="$HOME/.local/bin"
mkdir -p "$BIN_DIR"

LAUNCHER="$BIN_DIR/openchat"
cat << 'EOF' > "$LAUNCHER"
#!/usr/bin/env bash
# OpenChat Global Launcher & Service Manager
set -e

export OPENCHAT_HOME="${OPENCHAT_HOME:-$HOME/.openchat}"
APP_DIR="__TARGET_DIR_PLACEHOLDER__"

usage() {
  echo "OpenChat CLI"
  echo ""
  echo "Usage:"
  echo "  openchat                   Start OpenChat in foreground"
  echo "  openchat service <command> Manage background systemd service"
  echo ""
  echo "Service Commands:"
  echo "  openchat service install   Register and start OpenChat systemd service"
  echo "  openchat service start     Start the background service"
  echo "  openchat service stop      Stop the background service"
  echo "  openchat service restart   Restart the background service"
  echo "  openchat service status    View service status"
  echo "  openchat service logs      Follow real-time service logs"
  echo "  openchat service uninstall Remove systemd service"
  echo ""
}

case "${1:-}" in
  service)
    subcmd="${2:-}"
    case "$subcmd" in
      install|enable)
        echo "Registering OpenChat systemd service..."
        UNIT_FILE="/etc/systemd/system/openchat.service"
        TEMP_UNIT="/tmp/openchat.service.$$"
        CURRENT_USER="$(whoami 2>/dev/null || echo root)"
        NPM_BIN="$(command -v npm || echo /usr/bin/npm)"

        cat << UNIT > "$TEMP_UNIT"
[Unit]
Description=OpenChat - Autonomous AI Assistant Server
After=network.target docker.service
Wants=docker.service

[Service]
Type=simple
User=$CURRENT_USER
WorkingDirectory=$APP_DIR
Environment=NODE_ENV=production
Environment=OPENCHAT_HOME=$OPENCHAT_HOME
EnvironmentFile=-$APP_DIR/.env
ExecStart=$NPM_BIN start
Restart=always
RestartSec=3
LimitNOFILE=65536

[Install]
WantedBy=multi-user.target
UNIT

        if [ "$CURRENT_USER" = "root" ]; then
          mv "$TEMP_UNIT" "$UNIT_FILE"
          systemctl daemon-reload
          systemctl enable --now openchat.service
        else
          sudo mv "$TEMP_UNIT" "$UNIT_FILE"
          sudo systemctl daemon-reload
          sudo systemctl enable --now openchat.service
        fi
        echo "✓ OpenChat service installed and started successfully!"
        ;;
      start)
        systemctl start openchat.service 2>/dev/null || sudo systemctl start openchat.service
        ;;
      stop)
        systemctl stop openchat.service 2>/dev/null || sudo systemctl stop openchat.service
        ;;
      restart)
        systemctl restart openchat.service 2>/dev/null || sudo systemctl restart openchat.service
        ;;
      status)
        systemctl status openchat.service --no-pager 2>/dev/null || sudo systemctl status openchat.service --no-pager
        ;;
      logs)
        journalctl -u openchat.service -f 2>/dev/null || sudo journalctl -u openchat.service -f
        ;;
      uninstall|remove)
        systemctl disable --now openchat.service 2>/dev/null || sudo systemctl disable --now openchat.service 2>/dev/null || true
        rm -f /etc/systemd/system/openchat.service 2>/dev/null || sudo rm -f /etc/systemd/system/openchat.service 2>/dev/null || true
        systemctl daemon-reload 2>/dev/null || sudo systemctl daemon-reload 2>/dev/null || true
        echo "✓ OpenChat service uninstalled."
        ;;
      *)
        usage
        exit 1
        ;;
    esac
    ;;
  help|--help|-h)
    usage
    ;;
  *)
    cd "$APP_DIR" && exec npm start "$@"
    ;;
esac
EOF

sed -i "s|__TARGET_DIR_PLACEHOLDER__|$TARGET_DIR|g" "$LAUNCHER"
chmod +x "$LAUNCHER"
echo -e "  ${GREEN}✓${NC} Created global launcher: $LAUNCHER"

# 7. Auto-restart systemd service if running
if command -v systemctl >/dev/null 2>&1; then
  if systemctl is-active openchat.service >/dev/null 2>&1; then
    echo -e "\n${BOLD}🔄 Restarting OpenChat background service with latest updates...${NC}"
    systemctl restart openchat.service 2>/dev/null || sudo systemctl restart openchat.service 2>/dev/null || true
    echo -e "  ${GREEN}✓${NC} OpenChat service restarted successfully"
  fi
fi

echo -e "\n${BOLD}${GREEN}=======================================================${NC}"
echo -e "${BOLD}${GREEN}   🎉 OpenChat setup & build completed successfully!   ${NC}"
echo -e "${BOLD}${GREEN}=======================================================${NC}"

echo -e "\n${BOLD}How to use OpenChat:${NC}"
echo -e "  • Start in foreground:      ${BOLD}${GREEN}openchat${NC}"
echo -e "  • Register system service:  ${BOLD}${BLUE}openchat service install${NC}"
echo -e "  • Check service status:     ${BOLD}${BLUE}openchat service status${NC}"
echo -e "  • View real-time logs:      ${BOLD}${BLUE}openchat service logs${NC}"

if [[ ":$PATH:" != *":$BIN_DIR:"* ]]; then
  echo -e "\n  ${YELLOW}Tip:${NC} Add ${BOLD}$BIN_DIR${NC} to your PATH to run ${BOLD}openchat${NC} from anywhere:"
  echo -e "    echo 'export PATH=\"\$HOME/.local/bin:\$PATH\"' >> ~/.bashrc"
fi

echo -e "\nThen open your browser at:"
echo -e "  ${BOLD}${GREEN}http://localhost:3000${NC}\n"
