#!/usr/bin/env bash
# Install the private Node.js bridge on an existing Ubuntu WireGuard VM.
# Intentionally does NOT modify wg0, routing, iptables, GCP firewall, or SSH.
set -euo pipefail

if (( EUID != 0 )); then echo 'sudo bash deploy/install.sh 로 실행하세요.' >&2; exit 1; fi
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WG_IFACE="${WG_IFACE:-wg0}"
PORT="${PORT:-8080}"
SERVICE=ssamcafe-web
DEST=/opt/ssamcafe-web

[[ "$WG_IFACE" =~ ^[A-Za-z0-9_.-]+$ ]] || { echo 'WG_IFACE 형식 오류' >&2; exit 1; }
[[ "$PORT" =~ ^[0-9]{4,5}$ ]] && (( PORT >= 1024 && PORT <= 65535 )) || { echo 'PORT는 1024~65535 범위여야 합니다.' >&2; exit 1; }
[[ -f "$DIR/server.mjs" && -f "$DIR/public/index.html" && -f "$DIR/public/vendor/qrcode.mjs" ]] || { echo '전체 프로젝트 파일 및 QR 생성 모듈(public/vendor/qrcode.mjs)이 필요합니다.' >&2; exit 1; }
command -v ip >/dev/null || { echo 'ip 명령이 없습니다. iproute2 설치를 확인하세요.' >&2; exit 1; }
ip link show dev "$WG_IFACE" >/dev/null 2>&1 || { echo "$WG_IFACE 인터페이스가 보이지 않습니다. WireGuard가 실행 중인지 확인하세요." >&2; exit 1; }
WG_IP="$(ip -o -4 addr show dev "$WG_IFACE" | awk '{print $4}' | cut -d/ -f1 | head -n1)"
[[ -n "$WG_IP" ]] || { echo 'WireGuard 인터페이스의 IPv4 주소를 찾지 못했습니다.' >&2; exit 1; }

if ! command -v node >/dev/null 2>&1; then
  echo 'Node.js 설치 중 (기존 WireGuard 관련 패키지는 변경하지 않음)'
  apt-get update
  DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends nodejs
fi
NODE_BIN="$(command -v node)"
NODE_MAJOR="$($NODE_BIN -p 'Number(process.versions.node.split(".")[0])')"
(( NODE_MAJOR >= 18 )) || { echo "Node.js 18 이상이 필요합니다. 현재 $($NODE_BIN --version)" >&2; exit 1; }

if ! id -u ssamweb >/dev/null 2>&1; then
  useradd --system --home-dir "$DEST" --shell /usr/sbin/nologin ssamweb
fi
install -d -m 0755 -o root -g root "$DEST" "$DEST/public" "$DEST/public/vendor"
install -m 0644 -o root -g root "$DIR/server.mjs" "$DIR/package.json" "$DEST/"
for f in index.html app.js style.css manifest.webmanifest sample-data.json; do
  install -m 0644 -o root -g root "$DIR/public/$f" "$DEST/public/$f"
done
# QR generation is a local ES module; without copying this file, Safari import() fails.
install -m 0644 -o root -g root "$DIR/public/vendor/qrcode.mjs" "$DEST/public/vendor/qrcode.mjs"
# app only listens on wg0's address, never 0.0.0.0 or the GCP public interface.
cat >/etc/systemd/system/${SERVICE}.service <<UNIT
[Unit]
Description=Personal SSAMCAFE web bridge (WireGuard-only)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=ssamweb
Group=ssamweb
WorkingDirectory=$DEST
Environment=HOST=$WG_IP
Environment=PORT=$PORT
Environment=NODE_ENV=production
ExecStart=$NODE_BIN $DEST/server.mjs
Restart=on-failure
RestartSec=5
NoNewPrivileges=true
PrivateTmp=true
PrivateDevices=true
ProtectSystem=strict
ProtectHome=true
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectControlGroups=true
RestrictSUIDSGID=true
LimitNOFILE=2048
MemoryMax=220M

[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable --now "$SERVICE"
systemctl restart "$SERVICE"
sleep 2
systemctl is-active --quiet "$SERVICE" || { echo '서비스 시작 실패. journalctl -u ssamcafe-web -n 40 --no-pager 로 확인하세요.' >&2; exit 1; }
if command -v curl >/dev/null; then
  curl --noproxy '*' --fail --silent --max-time 4 "http://$WG_IP:$PORT/api/health" >/dev/null || { echo '서비스는 실행됐지만 /api/health 확인에 실패했습니다.' >&2; exit 1; }
  curl --noproxy '*' --fail --silent --max-time 4 -I "http://$WG_IP:$PORT/vendor/qrcode.mjs" >/dev/null || { echo 'QR 생성 모듈이 서버에 배포되지 않았거나 제공되지 않습니다.' >&2; exit 1; }
fi
# ONLY optional UFW ingress on VPN interface; do not open public ports.
if command -v ufw >/dev/null 2>&1 && ufw status | grep -qi '^Status: active'; then
  ufw allow in on "$WG_IFACE" to "$WG_IP" port "$PORT" proto tcp comment 'SSAMCAFE private VPN' >/dev/null
fi
cat <<DONE

배포 성공!
  VPN을 켠 아이패드/휴대폰에서: http://$WG_IP:$PORT
  서비스 상태: sudo systemctl status $SERVICE
  서비스 로그: sudo journalctl -u $SERVICE -n 40 --no-pager
  보안: $WG_IFACE 인터페이스에만 바인딩됨 (공용 포트 개방 없음)
  기존 WireGuard 설정/SSH/GCP 네트워크 규칙: 변경하지 않음

주의: 쌤카페 실계정 로그인 및 조회는 아직 검증되지 않았습니다.
DONE
