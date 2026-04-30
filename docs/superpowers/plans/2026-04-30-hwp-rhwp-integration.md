# HWP rhwp Integration Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 비서가 HWP/HWPX 파일을 @rhwp/core로 읽고 SVG 변환까지 할 수 있도록 통합

**Architecture:** automap-api.js에 rhwp 엔드포인트 3개 추가 + 기존 LibreOffice HWP 경로 교체 + hwp extension 작성 → user01 우선 배포

**Tech Stack:** @rhwp/core (WASM), Node.js 22, automap-api.js, TypeScript extension

---

### Task 1: @rhwp/core 설치 + rhwp-helper.mjs 작성

**Files:**
- Create: `/opt/openclaw/scripts/rhwp-helper.mjs`
- Create: `/root/openclaw-custom-platform/scripts/rhwp-helper.mjs` (소스 사본)
- Modify: `/opt/openclaw/scripts/` — npm install @rhwp/core

**작업:**
- [ ] `/opt/openclaw/scripts/` 에서 `npm install @rhwp/core`
- [ ] `rhwp-helper.mjs` 작성: stdin으로 `{op, fileBase64, page}` JSON 받아 처리
  - op: `parse` → 전체 텍스트 추출 (getPageTextLayout 모든 페이지)
  - op: `info` → getDocumentInfo() JSON
  - op: `export-svg` → renderPageSvg(page) SVG 문자열
- [ ] WASM 초기화: `import { initSync, HwpDocument } from '@rhwp/core'` + wasm 파일 경로 resolve
- [ ] measureTextWidth 폴리필 (글자 너비 근사값 — SVG 렌더링용)
- [ ] 소스 사본 `/root/openclaw-custom-platform/scripts/rhwp-helper.mjs` 에 복사
- [ ] 수동 테스트: `echo '{"op":"info","fileBase64":"..."}' | node /opt/openclaw/scripts/rhwp-helper.mjs`

---

### Task 2: automap-api.js 수정

**Files:**
- Modify: `/opt/openclaw/scripts/automap-api.js` (production)
- Modify: `/root/openclaw-custom-platform/scripts/automap-api.js` (source)

**작업:**
- [ ] `hwpProcess(op, fileBase64, extra)` 헬퍼 함수 추가 — rhwp-helper.mjs subprocess 호출
- [ ] 기존 LibreOffice HWP 경로 2곳 교체:
  - line ~1881 (`/api/file/upload` HWP 분기)
  - line ~1511 (`/api/drive/read` HWP 분기)
- [ ] 새 엔드포인트 3개 추가:
  - `POST /api/hwp/parse` — `{userNN, fileBase64, fileName}` → `{ok, text}`
  - `POST /api/hwp/info` — `{userNN, fileBase64}` → `{ok, info}`
  - `POST /api/hwp/export-svg` — `{userNN, fileBase64, page}` → `{ok, svgPath, downloadUrl}`
- [ ] SVG 저장 경로: `/opt/openclaw/data/user{NN}/workspace/hwp-exports/`
- [ ] SVG 1시간 TTL 정리: 서버 시작 시 + 매 시간 setInterval로 오래된 파일 삭제
- [ ] `systemctl restart openclaw-automap-api` 후 healthz 확인
- [ ] 두 파일 모두 동일하게 반영

---

### Task 3: hwp extension 작성 + user01 배포

**Files:**
- Create: `/root/openclaw-custom-platform/data-template/extensions/hwp/index.ts`
- Create: `/root/openclaw-custom-platform/plugins/hwp/index.ts`
- Deploy: `docker cp` → `openclaw-user01:/home/node/.openclaw/extensions/hwp/`

**도구 4개:**
- `hwp_read(filePath)` — 컨테이너 내 파일 읽어 텍스트 반환
- `hwp_info(filePath)` — 메타데이터 (페이지수/제목/작성자/날짜)
- `hwp_export_page(filePath, page?)` — 페이지 SVG 변환 → 다운로드 링크
- `hwp_from_drive(fileId)` — Google Drive에서 직접 HWP 파싱

**작업:**
- [ ] extension `index.ts` 작성 (dooray extension 패턴 참고)
- [ ] 파일 읽기: `fs.readFileSync(filePath)` → base64 → POST `/api/hwp/*`
- [ ] hwp_from_drive: `/api/hwp/parse?fromDrive=true&fileId=xxx&userNN=NN` 경로 또는 Drive 다운로드 후 parse
- [ ] `/root/openclaw-custom-platform/plugins/hwp/index.ts` 에도 동일 복사
- [ ] `docker cp` 로 user01 컨테이너에 배포
- [ ] 웹에서 테스트: user01 비서에게 HWP 파일 업로드 또는 Drive 파일 요청

---

### Task 4: 전체 배포 + git 커밋

**작업:**
- [ ] 웹 테스트 통과 확인
- [ ] user02~15 전체 컨테이너에 hwp extension 배포 (스크립트 반복)
- [ ] `/opt/openclaw/data/user{NN}/extensions/hwp/` sync (data-template 기준)
- [ ] git 커밋: `cd /root/openclaw-custom-platform && .git-push.sh`
