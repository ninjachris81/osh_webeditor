#!/usr/bin/env bash
#
# Installer for the OSH database webapp.
# Target: Raspberry Pi OS (or any systemd-based Debian-like Linux).
#
# Usage:
#   sudo ./install.sh
#
# Optional environment overrides:
#   OSH_WEBAPP_DIR    installation directory   (default: /opt/osh-webapp)
#   OSH_WEBAPP_USER   user the service runs as (default: the sudo caller, or 'osh')
#   OSH_WEBAPP_NODE   Node.js major version from NodeSource if apt is too old
#                     (default: 20)
#
set -euo pipefail

APP_NAME="osh-webapp"
APP_DIR="${OSH_WEBAPP_DIR:-/opt/${APP_NAME}}"
APP_USER="${OSH_WEBAPP_USER:-${SUDO_USER:-osh}}"
SERVICE_FILE="/etc/systemd/system/${APP_NAME}.service"
SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MIN_NODE_MAJOR=16
NODESOURCE_MAJOR="${OSH_WEBAPP_NODE:-20}"

info() { echo -e "\033[1;32m[install]\033[0m $*"; }
warn() { echo -e "\033[1;33m[install]\033[0m $*"; }
err()  { echo -e "\033[1;31m[install]\033[0m $*" >&2; }

if [[ $EUID -ne 0 ]]; then
  err "Please run as root: sudo ./install.sh"
  exit 1
fi

if ! id "$APP_USER" >/dev/null 2>&1; then
  err "User '$APP_USER' does not exist. Create it first or set OSH_WEBAPP_USER to an existing user."
  exit 1
fi
APP_GROUP="$(id -gn "$APP_USER")"

# ---------------------------------------------------------- apt packages ----
info "Installing required apt packages ..."
export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y --no-install-recommends \
  ca-certificates \
  curl \
  gnupg \
  git \
  build-essential \
  nodejs \
  npm

# ---------------------------------------------------------------- Node.js ----
node_major() {
  node -v 2>/dev/null | sed 's/^v\([0-9]*\).*/\1/' || echo 0
}

install_node_from_nodesource() {
  info "Installing Node.js ${NODESOURCE_MAJOR}.x from NodeSource ..."
  curl -fsSL "https://deb.nodesource.com/setup_${NODESOURCE_MAJOR}.x" | bash -
  apt-get install -y nodejs
}

NODE_MAJOR="$(node_major)"
if [[ "$NODE_MAJOR" -gt 0 ]]; then
  info "Found Node.js $(node -v)"
fi

if [[ "$NODE_MAJOR" -lt "$MIN_NODE_MAJOR" ]]; then
  warn "Distribution Node.js is too old or missing (found: $(node -v 2>/dev/null || echo none), need >= ${MIN_NODE_MAJOR})."
  install_node_from_nodesource
  NODE_MAJOR="$(node_major)"
fi

if [[ "$NODE_MAJOR" -lt "$MIN_NODE_MAJOR" ]]; then
  err "Node.js >= ${MIN_NODE_MAJOR} is required but could not be installed."
  exit 1
fi

# -------------------------------------------------------------- npm setup ----
# Some distributions ship 'nodejs' without a working 'npm'. Fall back to the
# corepack-bundled npm in that case.
npm_cmd() {
  if command -v npm >/dev/null 2>&1; then
    echo "npm"
  elif command -v corepack >/dev/null 2>&1; then
    echo "corepack npm"
  else
    err "Neither npm nor corepack is available - cannot install dependencies."
    exit 1
  fi
}
NPM="$(npm_cmd)"
info "Using package manager: ${NPM}"

# ------------------------------------------------------- Application files ----
info "Installing application files to ${APP_DIR} ..."
mkdir -p "$APP_DIR"
cp "$SRC_DIR/server.js" "$SRC_DIR/package.json" "$SRC_DIR/config.example.json" "$APP_DIR/"
rm -rf "$APP_DIR/src" "$APP_DIR/public"
cp -r "$SRC_DIR/src" "$SRC_DIR/public" "$APP_DIR/"

CONFIG_WAS_CREATED=0
if [[ ! -f "$APP_DIR/config.json" ]]; then
  cp "$APP_DIR/config.example.json" "$APP_DIR/config.json"
  CONFIG_WAS_CREATED=1
fi

# ------------------------------------------------------------- Dependencies ----
if [[ -d "$SRC_DIR/node_modules" ]]; then
  info "Copying pre-built node_modules from the source tree ..."
  rm -rf "$APP_DIR/node_modules"
  cp -r "$SRC_DIR/node_modules" "$APP_DIR/"
else
  info "Installing npm dependencies (this can take a minute on a Pi) ..."
  cd "$APP_DIR"
  # shellcheck disable=SC2086
  $NPM install --omit=dev --no-audit --no-fund
fi

chown -R "$APP_USER:$APP_GROUP" "$APP_DIR"

# ------------------------------------------------------------------ systemd ----
info "Installing systemd service ${SERVICE_FILE} ..."
sed -e "s|__APP_DIR__|${APP_DIR}|g" \
    -e "s|__APP_USER__|${APP_USER}|g" \
    "$SRC_DIR/install/osh-webapp.service" > "$SERVICE_FILE"

systemctl daemon-reload
systemctl enable "${APP_NAME}.service"
systemctl restart "${APP_NAME}.service"

APP_PORT="$(node -e "try{console.log((require('${APP_DIR}/config.json').server||{}).port||8080)}catch(e){console.log(8080)}")"

echo
systemctl --no-pager --full status "${APP_NAME}.service" | head -n 12 || true
echo
info "Done."
info "  Web UI:  http://<pi-address>:${APP_PORT}/"
info "  Config:  ${APP_DIR}/config.json"
info "  Logs:    journalctl -u ${APP_NAME} -f"
info "  Control: systemctl {start|stop|restart|status} ${APP_NAME}"
if [[ "$CONFIG_WAS_CREATED" -eq 1 ]]; then
  echo
  warn "A default config.json was created."
  warn "Edit ${APP_DIR}/config.json with your PostgreSQL credentials, then run:"
  warn "  sudo systemctl restart ${APP_NAME}"
fi
