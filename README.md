# OpenClaw Custom Platform

OpenClaw 기반 멀티유저 AI 워크스페이스 — TideClaw 커스터마이징.

여러 사용자가 각자 격리된 컨테이너에서 AI 에이전트를 사용하고, 메일/일정/Drive/Dooray/GitHub 등 외부 서비스와 연동할 수 있는 사내 협업 플랫폼입니다.

---

## 1. 프로젝트 개요

| 항목 | 내용 |
|------|------|
| **목적** | 사내 직원이 각자 자기 워크스페이스에서 AI 에이전트를 통해 메일·문서·일정 등을 자동화 |
| **아키텍처** | nginx + 사용자별 격리 컨테이너 (Docker) + 중앙 API 서버 |
| **격리 단위** | 컨테이너 1개 = 사용자 1명. 데이터·세션·메모리 모두 분리 |
| **AI 모델** | 기본 `kimi-k2.5` (Moonshot). 다른 모델로 교체 가능 |
| **인증** | Google OAuth (도메인 제한) → 사용자 토큰 발급 → 컨테이너 매핑 |

---

## 2. 사용 기술

| 영역 | 기술 |
|------|------|
| **컨테이너 오케스트레이션** | Docker, Docker Compose v2 |
| **리버스 프록시** | nginx (alpine) |
| **OpenClaw 본체 (백엔드)** | Node.js 22, TypeScript |
| **호스트 API 서버 (`automap-api.js`)** | Node.js (vanilla, no framework) |
| **호스트 플러그인** (`plugins/`) | TypeScript, OpenClaw plugin SDK |
| **컨테이너 내 플러그인** (`extensions/`) | TypeScript |
| **Web UI** (`custom-ui/`) | React 18, TypeScript, Vite, Tailwind CSS |
| **데이터베이스** | sqlite-vec (RAG 임베딩 검색) |
| **임베딩 모델** | bge-m3 (Ollama, 호스트에서 실행) |
| **외부 API 연동** | Google Drive/Gmail/Calendar, NHN Dooray, GitHub |
| **메신저 연동** | Discord, Telegram (OpenClaw channels) |
| **PDF 처리** | Google Drive API 변환 (PDF → Google Docs → text) |
| **HWP/HWPX 처리** | [@rhwp/core](https://github.com/hahnlee/rhwp) WASM 파서 (텍스트 추출, SVG 변환) |
| **나라장터(G2B) 연동** | 입찰공고 조회 및 낙찰 이력 검색 |
| **VNC 패널** | 컨테이너 내 원격 데스크탑 제어 (noVNC) |
| **크론 스케줄러** | 메일 정기 발송, 로그 정리 등 예약 작업 |

---

## 3. 아키텍처

### 3.1 전체 구조

```
                        ┌──────────────┐
                        │   Browser    │
                        │  (사용자)     │
                        └──────┬───────┘
                               │ HTTPS / WS
                               ▼
                        ┌──────────────┐
                        │    nginx     │  ← 리버스 프록시
                        │  (port 80)   │     · /          → custom-ui
                        └──────┬───────┘     · /api/*     → automap-api
                               │              · /ws/userN  → openclaw-userN
              ┌────────────────┼────────────────┐
              │                │                │
              ▼                ▼                ▼
      ┌──────────────┐ ┌──────────────┐ ┌──────────────┐
      │  custom-ui   │ │ automap-api  │ │  openclaw-   │
      │  (React SPA) │ │ (Node.js)    │ │  userNN x N  │
      │              │ │ port 18799   │ │  (Docker)    │
      │  - 채팅 UI    │ │              │ │              │
      │  - 대시보드   │ │ - Drive API  │ │ - 게이트웨이  │
      │  - 외부 연동  │ │ - Gmail API  │ │ - LLM 호출   │
      │              │ │ - Dooray API │ │ - 도구 실행  │
      │              │ │ - File upload│ │ - 세션 관리  │
      └──────────────┘ │ - PDF 변환   │ └──────┬───────┘
                       └──────────────┘        │
                                               │ extensions/
                                               ▼
                                        ┌─────────────┐
                                        │  Plugins    │
                                        │  - dooray   │
                                        │  - file-share│
                                        │  - gmail    │
                                        │  - local-files│
                                        │  - rag      │
                                        └─────────────┘
```

### 3.2 컴포넌트 설명

#### nginx
- 단일 진입점. 도메인 (`claw.example.com`) 기반 라우팅
- `/` → `custom-ui` 정적 파일 서빙
- `/api/*` → `automap-api` (host port 18799)
- `/ws/userNN` → `openclaw-userNN` 컨테이너 (port 18000+NN)

#### custom-ui (React SPA)
- 사용자가 보는 웹 UI. nginx가 정적 파일로 서빙
- 좌측 독 (탭 전환), 사이드바 (에이전트/세션), 채팅, 대시보드
- WebSocket으로 컨테이너의 OpenClaw 게이트웨이와 직접 통신
- localStorage에 세션 라벨 캐시

#### automap-api.js (호스트 API 서버)
- Node.js vanilla HTTP 서버 (no Express, no framework)
- 모든 사용자 공통 백엔드 기능 제공
- **주요 엔드포인트:**
  - `/api/file/upload` — 파일 업로드 + 텍스트 추출 (PDF, Office)
  - `/api/file/download` — 파일 다운로드
  - `/api/integrations/{save,load}` — Dooray/GitHub 토큰 저장/조회
  - `/api/dooray/{projects,tasks,task,member}` — Dooray API 프록시
  - `/api/mail/*` — Gmail API 프록시
  - `/api/drive/*` — Google Drive API 프록시
  - `/api/calendar/*` — Google Calendar API 프록시
  - `/api/hwp/parse` — HWP/HWPX 텍스트 추출
  - `/api/hwp/info` — HWP 문서 메타데이터
  - `/api/hwp/export-svg` — HWP 페이지 → SVG 변환 + 저장
  - `/api/hwp/svg` — 변환된 SVG 파일 서빙 (브라우저에서 바로 열림)
  - `/api/bid/*` — 나라장터 입찰/낙찰 이력 조회
  - `/api/drive/advanced-search` — Drive 대용량 필터 검색
  - `/api/vnc/*` — VNC 세션 제어
  - `/api/calendar/*` — Google Calendar API 프록시
- OAuth 토큰 관리: `/opt/openclaw/auth/tokens/NN.json`

#### OpenClaw 컨테이너 (사용자별)
- 사용자 1명당 컨테이너 1개
- 각 컨테이너는 자기 데이터 디렉토리 마운트:
  - `/opt/openclaw/data/userNN` → `/home/node/.openclaw`
  - `/opt/openclaw/shared/userNN` → `/home/node/documents`
- WebSocket 게이트웨이로 LLM 호출, 도구 실행, 세션 관리
- 컨테이너 내 플러그인 (`extensions/`)이 실제 도구 제공

---

## 4. 데이터 흐름 (예: "주간보고 작성")

```
1. 사용자 채팅 입력 → Browser
2. WebSocket 메시지 → openclaw-user01 (게이트웨이)
3. 게이트웨이가 LLM (kimi-k2.5) 호출
4. LLM이 도구 호출 결정: gmail.search
5. extensions/gmail 플러그인 실행
   → automap-api.js에 HTTP 호출
   → automap-api가 Google Gmail API 호출
   → 응답 반환
6. LLM이 데이터봇 sub-agent 위임 (sessions_spawn)
7. 데이터봇이 결과 분석 후 비서에게 반환
8. 비서가 종합 응답 작성
9. WebSocket으로 Browser에 streaming
10. custom-ui가 화면에 렌더링
```

---

## 5. 디렉토리 구조

```
openclaw-custom-platform/
├── nginx/
│   └── default.conf          # 리버스 프록시 라우팅
├── bootstrap/
│   └── BOOTSTRAP.md          # 모든 사용자 공통 시스템 프롬프트
├── scripts/
│   ├── automap-api.js        # 중앙 API 서버
│   ├── rhwp-helper.mjs       # HWP/HWPX WASM 처리 헬퍼 (stdin→stdout JSON)
│   └── bin/
│       └── dooray            # Dooray CLI (컨테이너 마운트용)
├── plugins/                  # 호스트 플러그인
│   ├── dooray/
│   ├── file-share/
│   └── hwp/                  # HWP 도구 (hwp_read, hwp_info, hwp_export_page, hwp_from_drive)
├── custom-ui/                # React 소스 (Vite + Tailwind)
│   ├── src/
│   │   ├── App.tsx
│   │   ├── components/
│   │   ├── hooks/
│   │   └── types/
│   ├── package.json
│   └── vite.config.ts
├── data-template/            # 새 사용자 컨테이너 디폴트
│   ├── extensions/           # 플러그인 (dooray, gmail, local-files, rag, file-share, hwp, g2b, drive-advanced)
│   ├── agents/               # 빈 (OpenClaw가 첫 부팅 시 비서 1개 자동 생성)
│   └── ...
├── docker-compose.yml        # nginx + 사용자 컨테이너 정의
├── setup.sh                  # 자동 설치 스크립트
└── README.md
```

### 배포 후 (호스트)
```
/opt/openclaw/
├── repo/                     # OpenClaw 본체 (git clone, SHA 고정)
├── nginx/                    # 위 nginx/ 복사본
├── bootstrap/
├── scripts/
├── plugins/
├── custom-ui/                # 빌드된 React 정적 파일 (nginx 서빙)
│   ├── index.html
│   └── assets/
├── auth/tokens/              # OAuth 토큰 (시크릿, gitignore)
├── data/                     # 사용자별 데이터 (gitignore)
│   ├── user01/
│   ├── user02/
│   └── ...
├── shared/                   # 사용자별 다운로드 폴더
│   └── userNN/
└── docker-compose.yml
```

---

## 6. 빠른 시작

### 6.1 필수 조건
- Linux 호스트 (Ubuntu 22.04+ 권장)
- Docker 24+, Docker Compose v2
- Git
- Node.js 22+ (custom-ui 빌드용)
- pnpm 또는 npm
- (선택) Ollama (RAG 임베딩 사용 시)

### 6.2 설치

```bash
git clone https://github.com/eomheeseung/openclaw-custom-platform.git
cd openclaw-custom-platform
sudo ./setup.sh
```

`setup.sh`가 자동으로:
1. OpenClaw 본체 clone (`/opt/openclaw/repo/`) — 검증된 SHA로 고정
2. 우리 커스터마이징을 `/opt/openclaw/`로 복사
3. `data-template` → `/opt/openclaw/data/user01/` 복사 (디폴트 사용자)
4. `custom-ui` React 빌드 → `/opt/openclaw/custom-ui/`에 배포
5. `docker compose build` + `docker compose up -d`

설치 후 `http://localhost` (또는 설정한 도메인) 접속.

### 6.3 환경변수

`.env` 파일 작성 (gitignore됨):

```bash
# Google OAuth
GOOGLE_CLIENT_ID=...
GOOGLE_CLIENT_SECRET=...

# AI 모델 키
MOONSHOT_API_KEY=...
ANTHROPIC_API_KEY=...  # 선택
OPENAI_API_KEY=...      # 선택

# 도메인
DOMAIN=claw.example.com
```

---

## 7. 새 사용자 컨테이너 추가

```bash
sudo ./scripts/add-user.sh 16
```

자동으로:
- `data-template` → `/opt/openclaw/data/user16/` 복사
- `docker-compose.yml`에 `openclaw-user16` 서비스 추가
- 컨테이너 빌드 + 시작
- nginx 라우팅 추가
- OpenClaw가 첫 부팅 시 비서 에이전트 1개 자동 생성

---

## 8. 검증된 OpenClaw 버전

`setup.sh`에서 SHA로 고정:

```bash
OPENCLAW_REPO="https://github.com/openclaw/openclaw.git"
OPENCLAW_COMMIT="64432f8e469cfc4e97fb792edf6fbd786d98060f"
```

업그레이드 시 SHA만 갈아치우고 `setup.sh` 재실행.

---

## 9. 보안

- **OAuth 토큰**: `/opt/openclaw/auth/tokens/`에 저장, gitignore
- **Dooray/GitHub 토큰**: 사용자별 `/opt/openclaw/data/userNN/integrations.json`
- **사용자별 격리**: 컨테이너 간 데이터 공유 없음
- **도메인 제한**: 허용 도메인 이메일만 OAuth 가능 (자동 거부)
- **노출되는 포트**: 80 (nginx)만. 컨테이너는 모두 내부망

---

## 10. 라이선스

- **OpenClaw 본체**: 해당 프로젝트 라이선스 (https://github.com/openclaw/openclaw)
- **TideClaw 커스터마이징**: 이 repo의 `LICENSE` 참조

---

## 11. 문의

TideFlo Inc.
