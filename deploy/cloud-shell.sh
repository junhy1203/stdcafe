#!/usr/bin/env bash
# Run this from a Git checkout inside Google Cloud Shell.
# No Cloud firewall changes, no new VM creation; existing WireGuard stays online.
set -euo pipefail
VM_NAME="${VM_NAME:-instance-20261114-122510}"
SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
command -v gcloud >/dev/null || { echo 'Google Cloud Shell에서 실행하세요 (gcloud 필요).' >&2; exit 1; }
PROJECT="$(gcloud config get-value project 2>/dev/null)"
[[ -n "$PROJECT" && "$PROJECT" != '(unset)' ]] || { echo 'Cloud Shell에서 gcloud config set project 프로젝트ID 를 먼저 실행하세요.' >&2; exit 1; }
ZONE="${ZONE:-$(gcloud compute instances list --project "$PROJECT" --filter="name=$VM_NAME" --format='value(zone)' | head -n 1 | sed 's@.*/@@')}"
[[ -n "$ZONE" ]] || { echo "$VM_NAME VM을 프로젝트 $PROJECT 에서 찾지 못했습니다." >&2; exit 1; }
echo "GCP project=$PROJECT; VM=$VM_NAME; zone=$ZONE"
REMOTE_DIR="$(basename "$SRC")"
[[ "$REMOTE_DIR" =~ ^[A-Za-z0-9_.-]+$ ]] || { echo "소스 디렉터리 이름이 올바르지 않습니다." >&2; exit 1; }
echo '프로젝트 파일을 기존 VM으로 전송합니다...'
gcloud compute scp --project "$PROJECT" --zone "$ZONE" --recurse "$SRC" "$VM_NAME:~/"
echo '기존 VM에 서비스 설치 중 (WireGuard 유지)...'
gcloud compute ssh "$VM_NAME" --project "$PROJECT" --zone "$ZONE" --command "sudo bash \"\$HOME/$REMOTE_DIR/deploy/install.sh\""
