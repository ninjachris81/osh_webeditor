#!/usr/bin/env bash
#
# Removes the OSH database webapp and its systemd service.
#
# Usage:
#   sudo ./uninstall.sh
#
set -euo pipefail

APP_NAME="osh-webapp"
APP_DIR="${OSH_WEBAPP_DIR:-/opt/${APP_NAME}}"
SERVICE_FILE="/etc/systemd/system/${APP_NAME}.service"

if [[ $EUID -ne 0 ]]; then
  echo "Please run as root: sudo ./uninstall.sh" >&2
  exit 1
fi

systemctl disable --now "${APP_NAME}.service" 2>/dev/null || true
rm -f "$SERVICE_FILE"
systemctl daemon-reload
rm -rf "$APP_DIR"

echo "Removed ${APP_NAME} (service + ${APP_DIR})."
