# SSAMCAFE Web for GCP + WireGuard (비공식·개인용)

**Node.js 18+만 필요, Python과 npm install 불필요.** 기존 Google Cloud VM에서 실행 중인 WireGuard 서버를 건드리지 않고, VPN 사용자만 접근할 수 있도록 만든 쌤카페 **조회 전용** 웹 클라이언트입니다.

## 중요한 사실

- 제공된 SSAMCAFE APK에서 확인한 API 요청·웹뷰 관련 코드를 바탕으로 만든 **비공식 프로토타입**입니다. 쌤카페와 무관한 개인 프로젝트입니다.
- **실제 쌤카페 서버에 로그인 성공하거나 실시간 데이터를 조회한 결과는 아닙니다.** 인증·기기 확인·HTML 구조가 달라 실서버에서 실패할 수 있습니다.
- 좌석 예약, 좌석 변경, 입퇴실, 결제 등 **쓰기 기능은 없습니다.** HTML에서 확인된 좌석/잔여시간만 표시하고, 알 수 없는 값은 `—`로 둡니다.
- 로그인 정보와 인증 토큰은 GCP VM의 Node.js 프로세스 메모리에만 보관합니다(서버 재시작 시 사라짐). 실제 공식 서버에는 앱과 유사한 인증 요청을 전송합니다.
- **본인이 허가받은 계정으로만 테스트하세요.** 앱 약관을 확인하고, 개인정보가 들어 있는 자료를 GitHub에 업로드하지 마세요.
- 이 프로젝트는 공개 GitHub 저장소 `junhy1203/stdcafe`에 코드만 저장합니다. **실제 비밀번호·인증 토큰·세션·기기 식별값·로그를 저장소에 올리면 안 됩니다.** `.gitignore`는 환경 파일을 제외하지만, 별도로 실수하지 않도록 주의하세요.

## 권장 배포 구성

- VM: 기존 `instance-20261114-122510` (Ubuntu 24.04, GCP `us-west1`, 정확한 존은 자동 탐색)
- WireGuard: 기존 `wg0`, VPN 내부 IPv4 주소 `10.66.66.1/24`, UDP `51820`
- 웹: Node.js가 **`10.66.66.1:8080`으로만 바인딩**, 공인 IP로 서비스 포트를 공개하지 않음
- iPad·휴대폰·PC: WireGuard VPN 연결 후 `http://10.66.66.1:8080` 접속

설치 스크립트는 실행 시 `wg0`의 현재 IPv4 주소를 다시 자동으로 확인합니다. WireGuard 설정, iptables/NAT, 기존 방화벽의 공개 포트, GCP 인스턴스 구성은 수정하지 않습니다. UFW가 활성 상태라면 `wg0` 인터페이스에 한정된 TCP 8080 허용 규칙만 추가합니다.

## 설치 — iPad에서도 가능 (Google Cloud Shell)

GitHub에 올라온 소스를 사용하므로 ZIP 업로드가 필요 없습니다.

1. [Google Cloud Console](https://console.cloud.google.com/compute/instances)에 로그인하고 **Cloud Shell(>_)**을 실행합니다.
2. 아래 명령을 붙여넣습니다.

```bash
 git clone https://github.com/junhy1203/stdcafe.git
 bash stdcafe/deploy/cloud-shell.sh
```

스크립트는 현재 GCP 프로젝트에서 기존 `instance-20261114-122510` VM을 찾고, 파일을 해당 VM에 복사한 뒤 `systemd` 서비스를 설치합니다. VM 이름이나 프로젝트가 다르면 실제 값에 맞춰 변경하세요. VM의 SSH 연결 승인 또는 Cloud Shell의 API 권한 승인이 필요할 수 있습니다.

3. WireGuard에 연결된 아이패드에서 **`http://10.66.66.1:8080`** 접속을 시도합니다. 실제 `wg0` 주소가 다르면 설치 스크립트에서 안내한 주소를 사용하세요.
4. 로그인은 본인 계정으로만 시험하세요. **비밀번호를 GitHub·ChatGPT 채팅에 입력하지 마세요.**

사파리에서 VPN 접속이 안 될 경우, VPN의 AllowedIPs에 VM의 VPN 주소가 포함되어 있는지 확인하세요. VM 보안 정책은 원래 설정을 유지합니다.

### 설치 확인

VM의 SSH 세션에서 아래 명령으로 진단합니다.

```bash
sudo systemctl status ssamcafe-web --no-pager
curl -fsS http://10.66.66.1:8080/api/health
sudo journalctl -u ssamcafe-web -n 40 --no-pager
```

다음 설치 시에도 `bash ~/stdcafe/deploy/cloud-shell.sh`로 해당 서비스만 다시 배포할 수 있습니다. **WireGuard 설정은 유지됩니다.**

## GitHub 소스 관리

저장소: https://github.com/junhy1203/stdcafe

파일을 수정할 때는 위 저장소에서 변경하고, Cloud Shell에서 아래를 실행해 서버를 업데이트합니다.

```bash
cd ~/stdcafe && git pull --ff-only && bash deploy/cloud-shell.sh
```

이 저장소의 소스는 공개되므로 로그인 정보, 서버 주소와 비밀키, WireGuard 구성파일을 커밋하면 안 됩니다. GitHub Pages는 Node.js 서버를 실행할 수 없으므로, **웹서비스는 기존 GCP VM에서 실행**합니다.

## 직접 개발/테스트 (PC 또는 VM)

```bash
node --version # v18 이상
npm test       # 표준 node:test만 사용, 외부 패키지 설치 불필요
node server.mjs
```

기본 바인딩은 `127.0.0.1:8080`입니다. `http://127.0.0.1:8080`으로 확인할 수 있습니다. VPN 접근은 설치 스크립트를 사용하세요. 테스트는 모의 인증 서버를 사용하며 실서버에 요청하지 않습니다.

## 구조

- `server.mjs`: HTTP 서버·읽기 전용 API·인증 세션·기본 HTML 판독
- `public/`: 반응형 UI (좌석·잔여시간 조회, 샘플 데이터 분리)
- `tests/server.test.mjs`: 모의 로그인, CSRF, 토큰 보호, 4개 조회 및 로그아웃 검사
- `deploy/install.sh`: VM에 Node.js systemd 서비스 설치, `wg0` 주소로만 바인딩
- `deploy/cloud-shell.sh`: 기존 GCP VM에 파일 업로드+설치 자동화
- `deploy/undo.sh`: 웹 서버만 제거 (WireGuard 유지)

## 주의 및 문제 해결

| 현상 | 확인할 내용 |
|---|---|
| `wg0` 없음 | WireGuard 서비스가 실행 중인지 `sudo wg show`로 확인. 이 프로젝트는 WireGuard를 재설정하지 않음 |
| Cloud Shell에서 VM 없음 | `gcloud config get-value project` 확인, GCP VM의 실제 프로젝트 선택 |
| 웹사이트 미접속 | 아이패드/폰에서 WireGuard 활성화 여부, `wg0` 주소, VM의 systemd 서비스, UFW VPN 규칙 |
| HTTP 401 / 로그인 실패 | 계정 문제, 기기 등록 또는 실제 서버 프로토콜 불일치 가능성 |
| 로그인되지만 데이터 없음 | 현재 앱에서만 생성되는 쿠키, 추가 JS, 매장 연동 또는 페이지 HTML 구조 차이 가능성 |
| 자리별 좌석표가 비어 있음 | 좌석 상태를 확인할 수 있는 공식 응답 스키마가 검증되지 않아 임의 데이터 표시를 차단한 상태 |

VPN 접속이 아닌 공개 URL로 접속시키지 마세요. WireGuard 터널 안에서만 HTTP를 사용하는 구성입니다. 공개 인터넷에서 접속시키려면 HTTPS·별도 인증·접근 제한·로그 감사 등 추가 보안 조치가 필요합니다.
