# OpenClaw 멀티유저 인프라 — 아키텍처 레퍼런스

이 문서는 `/opt/openclaw` 디렉토리의 OpenClaw 15유저 컨테이너 환경 전체 구조를 정리한다.
다른 Claude 세션이 처음 봐도 바로 파악할 수 있도록 **사실 기반 + 경로:라인**으로 작성.

---

## 1. 전체 구성 요약

- **Ubuntu 서버 1대** 위에 Docker로 15개 유저 컨테이너(`openclaw-user01`~`openclaw-user15`) + nginx 1개 운영
- 각 컨테이너 = 독립 OpenClaw gateway (Node.js) + Chrome browser + noVNC
- **호스트에서 도는 공용 서비스 2개**:
  - `automap-api` (Node.js, 포트 18799) — 메일/드라이브/도레이/OAuth 등 외부 API 중계
  - `openclaw-rag-api` (systemd service, 포트 18800) — RAG 검색 서비스
- nginx가 외부 포트 18001~18014 → 각 컨테이너 18789로 라우팅, 6080~6093 → noVNC

**docker-compose**: `/opt/openclaw/docker-compose.yml`

---

## 2. 호스트 디렉토리 레이아웃

```
/opt/openclaw/
├── docker-compose.yml         # 컨테이너 정의
├── auth/                      # Google OAuth 크레덴셜/토큰 (호스트에서만 읽음)
│   ├── client_secret.json
│   ├── users.json             # 유저 slot ↔ email 매핑
│   ├── integrations-user01.json
│   └── tokens/                # 사용자별 refresh token
├── bootstrap/
│   └── BOOTSTRAP.md           # 전역 BOOTSTRAP (모든 컨테이너에 read-only 마운트)
├── data/
│   ├── user01/.../...         # → 컨테이너 /home/node/.openclaw
│   └── user15/...
├── shared/
│   └── user01/
│       ├── custom-ui/         # React+Vite 소스 (수정 대상)
│       └── ...                # → 컨테이너 /home/node/documents
├── custom-ui/                 # 빌드된 정적 파일 (nginx가 서빙)
├── nginx/default.conf         # nginx 설정
├── repo/                      # OpenClaw gateway 소스 (TypeScript)
├── plugins/                   # dooray, file-share 등 공용 플러그인
├── rag/                       # RAG DB + node_modules
├── models/                    # 임베딩 모델
└── scripts/
    ├── automap-api.js         # 호스트 API 서버 (PID → PORT 18799)
    ├── bin/
    │   ├── gcurl              # curl 래퍼, userNN 자동 주입
    │   └── dooray             # Dooray CLI
    ├── sync-agents.sh         # 전체 유저 에이전트 동기화
    └── discord-automap.sh
```

---

## 3. 컨테이너 내부 마운트 (docker-compose.yml:61~99)

```
호스트 경로                                   →  컨테이너 경로
/opt/openclaw/data/user01                    →  /home/node/.openclaw       (유저 개인 데이터)
/opt/openclaw/shared/user01                  →  /home/node/documents       (문서 공유)
/mnt/gdrive                                  →  /home/node/gdrive          (Google Drive 마운트)
/opt/openclaw/bootstrap/BOOTSTRAP.md         →  /home/node/BOOTSTRAP.md    (읽기전용, 전역 공용)
/opt/openclaw/scripts/bin                    →  /opt/scripts               (gcurl 등)
/opt/openclaw/scripts/bin/dooray             →  /usr/local/bin/dooray
```

**주의: BOOTSTRAP.md는 단일 파일 바인드 마운트.** 호스트에서 파일을 rename/replace하면 inode가 바뀌어 컨테이너가 옛 파일 붙잡고 있음. **in-place 편집(`cat content > file`)**으로 inode 유지하거나 컨테이너 재시작.

### 컨테이너 네트워크

- 서브넷: `172.18.0.0/16`
- nginx: `172.18.0.100`
- user01~15: `172.18.0.11`~`172.18.0.25`
- **호스트(automap-api, rag-api)**: `172.18.0.1` (docker bridge gateway)

### 환경변수 (각 컨테이너)

```
OPENCLAW_GATEWAY_TOKEN=tc-user01   # ⚠ 컨테이너 내부는 tc-userNN 형식
OPENCLAW_GATEWAY_PORT=18789
TZ=Asia/Seoul
MOONSHOT_API_KEY / OPENAI_API_KEY / ANTHROPIC_API_KEY
DISPLAY=:99
PLAYWRIGHT_BROWSERS_PATH=/home/node/.cache/ms-playwright
```

참고: 사용자가 웹 UI 접속할 때는 **`openclaw-user{NN}-token`** 형식의 토큰 사용 (nginx에서 변환 또는 다른 메커니즘).

---

## 4. automap-api (호스트, 포트 18799)

**실행 파일**: `/opt/openclaw/scripts/automap-api.js` (Node.js, PID 확인: `ss -tlnp | grep 18799`)

**역할**: 컨테이너에서 호출할 수 없는 외부 API를 호스트에서 대신 호출 (OAuth 토큰 관리 포함).

**주요 엔드포인트** (automap-api.js:1~30 주석):
- `POST /automap` — Discord 자동 매핑
- `POST /sync` — 에이전트 동기화
- `GET /oauth/google` / `/callback` — Google OAuth2 플로우
- `POST /api/mail/send`, `GET /api/mail/search`, `/api/mail/read`
- `GET /api/drive/list` `/search` `/read` `/shared`
- `GET/POST /api/integrations/save` `/load` (Dooray, GitHub 토큰)
- `GET /api/dooray/projects` `/tasks` `/task`
- `GET /api/admin/users` `/containers` `/agents/:slot` `/config`
- `POST /api/admin/containers/restart`

**컨테이너 IP ↔ userNN 매핑**: `refreshContainerIpMap()` (automap-api.js:40~)가 `docker inspect`로 주기적 갱신해서 어느 컨테이너에서 온 요청인지 식별.

---

## 5. gcurl 스크립트 (`/opt/openclaw/scripts/bin/gcurl`)

컨테이너 안에서 `/opt/scripts/gcurl`로 접근. curl 래퍼로 userNN 자동 주입.

```bash
#!/bin/bash
NN=$(echo $OPENCLAW_GATEWAY_TOKEN | grep -oP "user\K\d+")
[ -z "$NN" ] && NN="01"

URL="http://172.18.0.1:18799${ENDPOINT}"

if [ -z "$BODY" ]; then
  curl -s -X "$METHOD" "$URL"
else
  # JSON body에 userNN 필드 자동 추가
  BODY=$(echo "$BODY" | python3 -c "import sys,json; d=json.load(sys.stdin); d['userNN']='${NN}'; print(json.dumps(d,ensure_ascii=False))")
  curl -s -X "$METHOD" "$URL" -H 'Content-Type: application/json' -d "$BODY"
fi
```

**사용법 (정확한 형식)**:
```bash
gcurl POST /api/mail/send '{"to":"x@y.com","subject":"제목","body":"본문"}'
gcurl GET /api/mail/search '{"query":"is:unread","max":10}'
```

**잘못된 예**: `gcurl gmail send --to ...` (CLI 스타일 X). 에이전트가 자주 헷갈리니 BOOTSTRAP.md에 정확한 형식 박아놓기 필요.

---

## 6. 에이전트 & 시스템 프롬프트 구성

### 6.1 유저당 에이전트 목록 (user01 기준)

`/home/node/.openclaw/openclaw.json`의 `agents.list`:
- `secretary` (비서, **default**), `developer`, `reviewer`, `planner`, `marketer`, `legal`, `finance`
- 각각 Discord 버전 존재: `{id}-discord`

**default agent**: secretary (첫 엔트리).

### 6.2 시스템 프롬프트 파일 레이어

우선순위 (낮음 → 높음), 게이트웨이가 컴포즈해서 model에 system prompt로 전송:

```
/home/node/BOOTSTRAP.md                              ← 전역 (호스트 마운트, 모든 유저 공통)
/home/node/SOUL.md, AGENTS.md, IDENTITY.md 등        ← 전역 보조
/home/node/.openclaw/BOOTSTRAP.md                    ← 유저별 (있으면 덮어씀)
/home/node/.openclaw/workspace-{agentId}/SOUL.md     ← 에이전트별 (필수)
/home/node/.openclaw/workspace-{agentId}/AGENTS.md   ← 에이전트별 (필수)
/home/node/.openclaw/workspace-{agentId}/BOOTSTRAP.md ← 에이전트별 (선택, 있는 에이전트만)
```

**핵심 설계 의도** (사용자 확언):
- `BOOTSTRAP.md`(전역) = **모든 컨테이너 공통 규칙** (도구 사용법 등)
- 호스트의 `/opt/openclaw/bootstrap/BOOTSTRAP.md` 하나만 수정하면 15유저 전체 반영
- `SOUL.md`(workspace별) = 에이전트 성격/역할 + 사용자 커스터마이징 가능
- 에이전트별 workspace에 BOOTSTRAP이 없어도 전역 BOOTSTRAP이 시스템 프롬프트에 포함돼야 함

### 6.3 프롬프트 로딩 코드 (게이트웨이)

- **시작점**: `/opt/openclaw/repo/src/agents/pi-embedded-runner/run/attempt.ts:1723~1733`
  - `resolveBootstrapContextForRun({ workspaceDir, config, sessionKey, sessionId, contextMode, runKind })` 호출
- **workspace 파일 로더**: `/opt/openclaw/repo/src/agents/workspace.ts`
  - 상수: `DEFAULT_BOOTSTRAP_FILENAME = "BOOTSTRAP.md"` (workspace.ts:31)
  - `bootstrapPath = path.join(dir, DEFAULT_BOOTSTRAP_FILENAME)` (workspace.ts:354)
  - BOOTSTRAP은 workspace setup 완료되면 파일 목록에서 숨김 (테스트: `agents-mutate.test.ts:634`)
- **크론 경로**: `/opt/openclaw/repo/src/cron/isolated-agent/run.ts:531~532`
  - `bootstrapContextMode: agentPayload?.lightContext ? "lightweight" : undefined`
  - `bootstrapContextRunKind: "cron"`
- **주의**: 크론 isolated 세션 → session jsonl 자체에는 system prompt가 안 찍힘(매 API 호출마다 프롬프트에 prepend). jsonl에서 BOOTSTRAP 내용이 안 보이는 건 **불포함이 아니라 단지 기록 안 됨**일 수 있음. 실제 포함 여부는 `resolveBootstrapContextForRun` 반환값 확인 필요.

### 6.4 BOOTSTRAP 편집 시 주의

- 호스트에서 편집 시 **inode 보존 필수** (단일 파일 바인드 마운트 특성)
- 안전한 방법: 신내용을 `/tmp/new.md`로 저장 후 `cat /tmp/new.md > /opt/openclaw/bootstrap/BOOTSTRAP.md` (truncate 방식, inode 유지)
- 컨테이너에서 `stat -c '%i %s' /home/node/BOOTSTRAP.md`로 inode·크기 확인
- 만약 inode 달라지면 해당 컨테이너 `docker restart`

---

## 7. 플러그인 시스템

**위치**: `/home/node/.openclaw/extensions/{plugin-name}/index.ts`

**주요 플러그인**:
- `gmail` — `mail_send`, `mail_search`, `mail_read` 도구 등록. 내부적으로 `automap-api`의 `/api/mail/*` 호출
- `dooray` — 도레이 프로젝트/작업 조회
- `file-share` — 파일 공유
- `rag` — `rag_search`, `rag_status` (로컬 RAG DB)

**Gmail 플러그인 도구 등록** (`/home/node/.openclaw/extensions/gmail/index.ts`):
```ts
api.registerTool({
  name: 'mail_send',
  description: `tideflo.com 회사 계정으로 이메일을 발송합니다. 반드시 이 도구를 사용하세요.`,
  parameters: { to, subject, body, cc?, bodyHtml? },
  execute: async (_, params) => apiRequest('POST', '/api/mail/send', { userNN, ...params })
});
```

크론 isolated 세션에서도 플러그인 도구는 전부 등록됨 (로그에서 `Gmail tools registered for user01` 확인).

**이론상으로는 `mail_send`가 있음에도** 실제로 kimi 모델이 isolated 세션에서 `mail_send`를 안 고르고 `exec`로 `gog gmail send` 같은 CLI 시도 → 실패. 원인:
- kimi tool-use가 비결정적 (메모리: `project_gmail_integration.md`)
- isolated 세션은 매번 빈 컨텍스트라 도구 선택 학습이 누적되지 않음

**권장 우회**: BOOTSTRAP.md에 "메일 발송은 반드시 `gcurl POST /api/mail/send` 형식으로" 명시 (exec 도구 + 정확한 명령어 템플릿).

---

## 8. gog vs gcurl

- **gog** = Google Workspace CLI (`gog gmail send ...`) — **비활성화됨**
  - 시도하면: `ERROR: gog send는 비활성화됨. gcurl을 사용하세요.`
- **gcurl** = 회사 메일 API 래퍼 (정답)

에이전트가 학습 데이터에 의존해서 `gog gmail send` 같은 CLI 스타일을 먼저 시도하는 경우가 많음. BOOTSTRAP에 강력히 경고 필요.

---

## 9. 크론 시스템

**데이터 파일**: `/home/node/.openclaw/cron/jobs.json`
**실행 이력**: `/home/node/.openclaw/cron/runs/{jobId}.jsonl`

**크론 작업 스키마** (`/opt/openclaw/repo/src/gateway/protocol/schema/cron.ts` 참고):
```json
{
  "id": "uuid",
  "name": "작업 이름",
  "enabled": true,
  "schedule": { "kind": "cron", "expr": "*/5 * * * *", "tz": "Asia/Seoul" },
  "sessionTarget": "isolated" | "main" | "session:...",
  "wakeMode": "now",
  "payload": {
    "kind": "agentTurn" | "systemEvent",
    "message": "..." | "text": "..."
  },
  "delivery": {
    "mode": "none" | "announce" | "webhook",
    "channel": "telegram" | "discord"    // 선택, 여러 채널 있을 때 필수
  }
}
```

### 9.1 sessionTarget의 실제 의미

- **main**: `sessionKey`가 고정 (예: `agent:secretary:main` 또는 `agent:secretary:{숫자}`). **같은 jsonl 파일에 계속 append**. 채팅이랑 같은 세션 공유 → 이전 대화 맥락 유지 → 도구 선택 안정.
- **isolated**: 매 실행마다 **새 sessionKey + 새 jsonl** 생성 (`agent:secretary:cron:{jobId}:run:{runId}`). 컨텍스트 0에서 시작 → 도구 선택이 흔들리기 쉬움.

### 9.2 delivery 규칙 (`/opt/openclaw/repo/src/cron/isolated-agent/run.ts:98~112`)

- `disableMessageTool: cron-owned ? true : deliveryRequested`
  - **크론 세션은 기본적으로 `message` 도구 비활성화** — 응답은 cron runner가 직접 채널로 전달
- `delivery.mode: "none"` → 외부 전송 없이 UI 활동 로그에만 기록 (웹 전용)
- `delivery.mode: "announce"` + `channel: "telegram"|"discord"` → 해당 채널로 발송
- 다중 채널 설정된 유저에서 `channel` 누락 시 `Channel is required` 에러
- Channel selection: `/opt/openclaw/repo/src/infra/outbound/channel-selection.ts:196~205`

### 9.3 주간보고 vs 성능측정 크론 비교

user05/user13에 있는 주간보고 크론:
- `sessionTarget: "main"`, `sessionKey: "agent:secretary:{숫자}"` (persistent)
- `payload.kind: "systemEvent"` (일반 agentTurn과 다름)
- 실제 실행 로그 분석: `exec` 도구로 `gcurl POST /api/mail/send` 호출 → 성공
  - SOUL.md의 "exec, gog 금지" 규칙은 **실질적으로 무시됨** (메모리 `project_gmail_integration.md`)

user01 우리가 만든 성능측정 크론:
- `sessionTarget: "isolated"`, 새 세션
- isolated + kimi → `mail_send` 도구 안 쓰고 `gog`/`sendmail`/`curl SMTP` 등 엉뚱한 시도

**결론**: 크론에서 메일 보내려면 `sessionTarget: "main"` 또는 BOOTSTRAP에 gcurl 강제 템플릿 필수.

---

## 10. 채널 (Channel) 시스템

`/opt/openclaw/repo/src/utils/message-channel.ts`

- `INTERNAL_MESSAGE_CHANNEL = "webchat"` (내부, 딜리버리 대상 아님)
- 외부 딜리버리 채널: `telegram`, `discord`, `slack`, `signal`, `googlechat`, `tui` 등
- listConfiguredMessageChannels — 유저가 실제 구성한 채널만 반환

**CronManager UI 에서 (`/opt/openclaw/shared/user01/custom-ui/src/components/CronManager.tsx`)**:
- 크론 생성 시 "전달 채널" 선택: `웹(mode:none) / 디스코드 / 텔레그램`
- 에이전트 선택 UI는 제거됨 → 비서 고정

---

## 11. 커스텀 UI

- **소스**: `/opt/openclaw/shared/user01/custom-ui/src/` (React + Vite + Tailwind)
- **빌드**: `cd /opt/openclaw/shared/user01/custom-ui && npm run build`
- **배포**: `rm -rf /opt/openclaw/custom-ui/* && cp -r ./dist/* /opt/openclaw/custom-ui/`
- **nginx**: 3000 포트에서 `/usr/share/nginx/custom-ui` (= 호스트 `/opt/openclaw/custom-ui`) 정적 서빙
- **접속**: `http://192.168.50.101:3000/?token=openclaw-user{NN}-token`
- **주의**: 단일 빌드를 모든 유저가 공유 → 토큰으로만 유저 구분. 유저별 UI 커스터마이징은 불가능 (아직).

**배포 안 되는 흔한 실수**:
- `docker cp`로 컨테이너 안으로 복사하려 시도 → 효과 없음 (nginx는 호스트 `/opt/openclaw/custom-ui` 서빙)
- `/opt/openclaw/shared/user01/custom-ui/dist/` 수정 후 재복사 누락

---

## 12. noVNC (가상 데스크톱)

- Xvfb + x11vnc + websockify 스택
- 컨테이너 재시작 시 프로세스 죽음 → **수동 재시작 필요**:
```bash
docker exec -u root openclaw-user01 bash -c "
  Xvfb :99 -screen 0 1280x720x24 &
  sleep 1
  x11vnc -display :99 -nopw -forever -shared -rfbport 5900 &
  sleep 1
  websockify --web /usr/share/novnc 6080 localhost:5900 &
"
```
- 접속: `http://192.168.50.101:608{1..93}/vnc.html` (nginx 라우팅)

---

## 13. 브라우저 도구 (browser)

- 각 컨테이너에 Chrome 설치 (`/usr/bin/google-chrome`)
- CDP 포트: **18800** (컨테이너 내부 전용, 외부 미노출)
- 에이전트가 `browser` 도구로 조작 (action=open/act/snapshot/evaluate)
- 실패 흔한 원인:
  - DBus 소켓 없음 → 대부분 warning, headless면 통과
  - `/home/node/.cache/` 권한 → shader cache 에러 (warning)
  - Chrome 좀비 프로세스 누적 → 가끔 재시작 필요

**주의**: 크론에서 `browser` 도구 쓸 때 `Sandbox browser is unavailable` 에러가 나면 `target: "host"`로 전환 재시도하게 됨.

---

## 14. 에이전트 간 위임 (sessions_spawn)

- 비서 `subagents.allowAgents: ["developer","reviewer","planner","marketer","legal","finance"]`
- `sessions_spawn({ agentId, task })` 호출 → 서브에이전트 세션 생성 → `sessions_yield`로 결과 대기
- 결과는 비서 세션에 `source: subagent` 이벤트로 주입

**문제 사례**: SOUL.md에 "혼자 다 하지 마, 반드시 팀원에게 분배해"라고 적혀있어서 비서가 단순 측정 같은 것도 개발봇에 위임 → 토큰 2배, 레이턴시 증가.

---

## 15. 인증 & 디바이스 페어링

- **Gateway 토큰 (UI용)**: `openclaw-user{NN}-token`
- **Gateway 토큰 (컨테이너 env)**: `tc-user{NN}` (형식 다름)
- **필수 파일 (데이터 볼륨 안)**:
  - `/home/node/.openclaw/identity/device.json`
  - `/home/node/.openclaw/identity/device-auth.json`
  - `/home/node/.openclaw/devices/paired.json`
  - 없으면 "gateway token mismatch" 에러
- **config**:
  - `dangerouslyDisableDeviceAuth: true` 설정됨 (페어링 파일은 여전히 필요)
  - `allowedOrigins: ["*"]`

---

## 16. 모델 설정

- `/home/node/.openclaw/openclaw.json`의 `agents.defaults.model.primary`
- 현재 전체 유저: `moonshot/kimi-k2.5`
- **kimi 특성**:
  - tool-use 비결정적 (같은 상황에서 다른 도구 선택)
  - isolated 세션에서 특히 불안정
  - 메일 관련해선 BOOTSTRAP에 정확한 명령 템플릿 박아둬야 안정

**모델 교체 제안 금지** (사용자 명시): feedback_no_model_swap.md 참고.

---

## 17. systemd 서비스 (호스트)

```
openclaw-rag-api.service         # RAG 검색 API (포트 18800)
openclaw-watch-agents.service    # 에이전트 생성/삭제 감지 → 자동 sync
```

확인: `systemctl list-units | grep openclaw`

---

## 18. 자주 하는 작업

### BOOTSTRAP.md 수정 (모든 유저 반영)
```bash
# inode 유지하며 수정
python3 /tmp/edit_bootstrap.py   # /tmp/new.md 생성
cat /tmp/new.md > /opt/openclaw/bootstrap/BOOTSTRAP.md
docker exec openclaw-user01 stat -c '%i %s' /home/node/BOOTSTRAP.md   # inode 확인
```

### Custom UI 빌드 & 배포
```bash
cd /opt/openclaw/shared/user01/custom-ui && npm run build
rm -rf /opt/openclaw/custom-ui/*
cp -r /opt/openclaw/shared/user01/custom-ui/dist/* /opt/openclaw/custom-ui/
```

### 유저 전체 sync (에이전트/설정 변경 시)
```bash
/opt/openclaw/scripts/sync-agents.sh
```

### 컨테이너 재시작 (config 변경 후)
```bash
docker restart openclaw-user01
# noVNC 재시작 필요 (위 12번)
# healthz 확인: curl http://192.168.50.101:18001/healthz
```

### 크론 실행 이력 확인
```bash
docker exec openclaw-user{NN} cat /home/node/.openclaw/cron/jobs.json
docker exec openclaw-user{NN} tail -n 1 /home/node/.openclaw/cron/runs/{jobId}.jsonl
```

### 에이전트 세션 내용 확인
```bash
docker exec openclaw-user{NN} ls -t /home/node/.openclaw/agents/secretary/sessions/ | head
```

---

## 19. 주요 메모리 문서 (사용자 auto-memory)

`/root/.claude/projects/-home-tideclaw/memory/MEMORY.md` 인덱스 참고:
- `infra_setup.md` — 인프라 요약
- `project_gmail_integration.md` — 메일 API·kimi 한계
- `feedback_no_model_swap.md` — 모델 교체 제안 금지
- `feedback_sync_all.md` — 베이스 설정 변경 시 user01~15 전체 sync
- `feedback_config_change.md` — config 수정 후 nginx 재시작 + healthz 필수
- `project_mention_followups.md` — @멘션 후속 작업

---

## 20. 알려진 이슈 / 주의사항

1. **단일 파일 바인드 마운트의 inode 문제** — 호스트에서 rename 방식으로 파일 교체하면 컨테이너가 옛 inode 붙잡음. 항상 truncate(`>`)로 덮어쓰기.
2. **kimi isolated 세션 도구 선택 불안정** — 크론 등 컨텍스트 없는 곳에선 mail_send 같은 플러그인 도구 안 쓰고 엉뚱한 경로 시도. BOOTSTRAP에 정확한 명령 템플릿 필요.
3. **SOUL.md "exec, gog 금지" 규칙 사실상 무력화** — 실제 주간보고 크론은 exec+gcurl 씀. SOUL.md와 실제 동작 불일치.
4. **browser 도구 타임아웃 가끔 발생** — Sandbox 초기화 실패, 재시도하면 대부분 해결.
5. **gcurl 사용법 헷갈림** — 에이전트가 `gcurl gmail send --to ...` 같은 CLI 형식 추측. 반드시 `gcurl METHOD /api/경로 'JSON'` 형식.
6. **크론 에러 로그가 UI 활동 로그에 계속 표시** — 서버 jsonl 파일에서 폴링. 개별 삭제는 `/home/node/.openclaw/cron/runs/{id}.jsonl` 제거 필요.

---

*Last updated: 2026-04-13. Session에서 조사·검증됨. 부정확한 부분 발견 시 업데이트할 것.*
