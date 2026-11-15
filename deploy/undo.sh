#!/usr/bin/env bash
# Removes only SSAMCAFE service; leaves WireGuard untouched.
set -euo pipefail
(( EUID == 0 )) || { echo 'sudo bash deploy/undo.sh' >&2; exit 1; }
systemctl disable --now ssamcafe-web.service 2>/dev/null || true
rm -f /etc/systemd/system/ssamcafe-web.service
systemctl daemon-reload
rm -rf /opt/ssamcafe-web
printf '쌤카페 웹 서비스 파일을 제거했습니다. WireGuard 설정은 변경하지 않았습니다.\n'
