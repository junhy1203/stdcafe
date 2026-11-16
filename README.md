# SSAMCAFE Web — 비공식 개인용 조회 클라이언트

**쌤카페의 매장·이용권·좌석 정보를 웹에서 조회하기 위한 개인 프로젝트**입니다. Node.js 서버를 기존 GCP VM의 **WireGuard VPN 내부에만** 연결하도록 구성했습니다. 공식 쌤카페 서비스와 관계가 없습니다.

> **실험적 구현:** Android 앱의 API·WebView 흐름을 참고했습니다. 실제 계정·매장별 응답이 다를 수 있으며 로그인이나 개별 좌석 조회의 정상 작동을 보장하지 않습니다.

## 현재 구현

- **로그인 및 진단:** 공식 서버와의 인증 호환성 확인, 로그인 오류 및 데이터 조회 진단
- **이용권·매장:** 앱 홈 및 이용권 API에서 확인된 정보 표시
- **좌석 집계:** 전체 좌석과 사용 중인 좌석 수로 빈자리 계산
- **개별 좌석도:** 좌석번호·점유 상태·좌표를 실제 응답에서 확인할 수 있을 때만 그림으로 표현
- **현장 QR:** 서버가 제공한 본인 QR을 표시해 매장 스캐너에 제시하는 방식

좌석별 조회 시 앱 개인석 화면인 `/mobile/purchase/personal.do`를 우선 확인하고, `/mobile/enterSeatView.do`와 `/mobile/seatChangeView.do`를 보조 경로로 사용합니다. 동적 화면의 읽기 전용 API 후보를 찾는 파서도 있습니다. **실제 좌석 정보가 반환되지 않으면 임의의 좌석을 생성하지 않습니다.**

### 좌석별 조회가 실패했을 때 — 상세 진단 v14

1. **좌석 현황 → 개별 좌석 상태 조회**를 먼저 실행합니다.
2. **좌석 조회 진단 복사** 또는 **상세 진단 JSON 저장**을 누릅니다.
3. 긴 보고서는 저장된 `stdcafe-seat-diagnostics-v14.json` 파일로 공유할 수 있습니다.

진단은 개인석·입실·자리변경 화면별로 다음을 수집합니다. *응답 HTTP 상태/MIME/문자 수/지문, 요청 소요시간, 화면 이동 경로, HTML 태그·폼·입력 필드의 이름 및 타입, 좌석 관련 DOM 클래스/속성, JavaScript의 AJAX·POST·GET 호출 횟수 및 정적 API 경로, 외부 JS 파일 분석, 차트 응답의 JSON 필드 구조 및 좌석 점유 상태코드별 개수, 홈 API 필드 이름과 좌석 집계*. 코드가 명시한 읽기 전용 GET/POST 후보만 검사합니다. `personal.do`의 `checkbox` 폼을 근거 없이 POST하는 동작은 제외했습니다.

**보안:** 비밀번호·로그인 토큰·쿠키 값·폼 입력값·회원 이름·매장명·원본 HTML/JS·응답 원문을 진단 파일에 담지 않습니다. 주소는 첫 번째 쌤카페 도메인의 경로만 기록하며 쿼리 값은 포함하지 않습니다. 진단 JSON이라도 공개 게시글이나 공개 GitHub 이슈에 그대로 올리지 마세요.

잔여시간은 공식 앱과 교차 검증이 필요하며, `REMAIN_PERIOD`의 분 단위 해석도 잠정적입니다. 결제·좌석 변경·온라인 입실 확정은 지원하지 않습니다.

## 로컬 실행

Node.js **18 이상**이 필요합니다. Python이나 외부 npm 의존성 설치는 필요하지 않습니다.

```bash
git clone https://github.com/junhy1203/stdcafe.git
cd stdcafe
npm test
npm start
```

로컬 기본 주소는 `http://127.0.0.1:8080`입니다. 자동화 테스트는 모의 응답을 사용하므로 실제 매장 호환성을 보장하지 않습니다.

## GCP + WireGuard 배포

Cloud Shell에서 기존 VM에 배포하는 스크립트가 준비되어 있습니다.

```bash
git clone https://github.com/junhy1203/stdcafe.git
bash stdcafe/deploy/cloud-shell.sh
```

`deploy/cloud-shell.sh`는 기존 VM에 업로드, `deploy/install.sh`는 `systemd` 서비스 설치, `deploy/undo.sh`는 웹 서비스 되돌리기를 담당합니다. **스크립트에 기존 VM 이름·프로젝트·VPN 구성 전제가 있으므로 실행 전에 확인**하세요. VPN 주소와 인터페이스가 다르면 실제 환경에 맞춰 조정해야 합니다.

운영 상태 확인:

```bash
sudo systemctl status ssamcafe-web --no-pager
sudo journalctl -u ssamcafe-web -n 40 --no-pager
```

## 저장소 구성

| 경로 | 역할 |
| --- | --- |
| `server.mjs` | HTTP 서버, 세션, 외부 요청, 읽기 전용 조회 API |
| `seat-map.mjs` | 좌석 HTML/JSON 파싱 및 API 후보 추출 |
| `public/` | 모바일·데스크톱 대시보드와 좌석도 UI |
| `public/vendor/qrcode.mjs` | 로컬 QR 생성 라이브러리 |
| `tests/` | 모의 인증·좌석·보안 테스트 |
| `deploy/` | GCP·WireGuard 기반 배포 도구 |

## 보안과 제한

- 본인 또는 허가받은 계정으로만 테스트하세요.
- 비밀번호, 인증 토큰, 쿠키, 개인 데이터, VPN 설정 및 실제 로그를 GitHub에 올리지 마세요.
- 세션은 서버 프로세스 메모리에 저장되어 서버 재시작 시 소멸할 수 있습니다.
- **공인 IP의 웹 포트를 열지 말고 WireGuard 내부에서만 접속**하세요.
- 공식 서버의 변경으로 로그인, 이용권, 좌석 분석 기능이 언제든 실패할 수 있습니다.
- 샘플 좌석 데이터는 UI 개발용이며 실제 매장 상태가 아닙니다.
