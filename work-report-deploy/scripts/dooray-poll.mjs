#!/usr/bin/env node
/**
 * 두레이 수신 데몬 — 두레이 '나와의 대화' 를 폴링해 `..` 로 시작하는 지시를 세션에 넣는다.
 *
 * 왜 폴링인가: 두레이가 우리 서버를 호출할 수 없다. 사내망(192.168.50.101)이라 콜백 경로가 없고,
 *   두레이 API 에 long polling·스트리밍도 없다(실측). 나가는 요청만 되므로 우리가 물어본다.
 *   호출 제한은 계정 단위 burst 20 / 초당 5회 충전 → 14명 60초 주기는 한도의 5%.
 *
 * 왜 `chat.send` 인가: `/hooks/agent` 는 격리 세션에서 돌고 결과만 메인에 통지한다(실측).
 *   그러면 카드가 웹 UI 대화창에 뜨지 않는다. 웹 UI 와 똑같이 WebSocket `chat.send` 로 넣어야
 *   사용자가 웹에서 직접 친 것과 동일해진다 (세션 `agent:secretary:dooray` 고정 — 사이드바에 뜬다).
 *
 * 회신은 하지 않는다 — 비서가 BOOTSTRAP 규칙에 따라 notify.py 로 두레이에 답한다.
 *   데몬이 응답까지 맡으면 카드 판단·요약을 데몬이 하게 되어 역할이 겹친다.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname } from "node:path";
import { createRequire } from "node:module";

const require = createRequire("/opt/openclaw/repo/");
const WebSocket = require("ws");

const DATA = "/opt/openclaw/data";
const PREFIX = "..";                 // `/` 는 두레이 슬래시 커맨드 팝업과 겹쳐서 제외
// `:main` 은 쓰지 않는다 — 웹 UI 가 사이드바에서 의도적으로 숨긴다
// (Sidebar.tsx: ":main 진입점 세션은 숨김 — cron/mention 자동 메시지 누적 컨테이너 역할만").
// main 으로 보내면 대화가 사용자 눈에 보이지 않는다(실측).
//
// 주 단위로 끊는다: 한 세션에 계속 쌓으면 몇 주 뒤 컨텍스트가 무거워진다.
// 업무보고 자체가 주 단위라 리듬도 맞고, 사이드바에 주차별로 남아 되짚기 쉽다.
const SESSION_PREFIX = "agent:secretary:dooray-";

/** ISO 주차 (월요일 시작). draft-YYYY-Www 파일명과 같은 규칙이어야 한다. */
function isoWeek(now = new Date()) {
  const t = new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()));
  const day = t.getUTCDay() || 7;            // 일요일(0) → 7
  t.setUTCDate(t.getUTCDate() + 4 - day);    // 그 주 목요일로 이동 = ISO 기준 연도 결정
  const year = t.getUTCFullYear();
  const jan1 = new Date(Date.UTC(year, 0, 1));
  const week = Math.ceil(((t - jan1) / 86400000 + 1) / 7);
  return `${year}-W${String(week).padStart(2, "0")}`;
}

const sessionKeyFor = (week) => `${SESSION_PREFIX}${week}`;
const sessionLabelFor = (week) => `두레이 대화 · ${week}`;

/** 두레이에서 웹으로 건너올 링크 — 해당 주차 대화가 바로 열린다.
 *  UI 경로 규칙: /chat/<agentId>/<sessionTail> → sessionKey `agent:<agentId>:<tail>` (App.tsx).
 *  게이트웨이가 세션 키를 소문자로 저장하므로 tail 도 소문자여야 한다. */
function webLink(nn, week) {
  const cfg = readJson(`${DATA}/user${nn}/openclaw.json`);
  const token = cfg?.gateway?.auth?.token || "";
  const tail = `dooray-${week}`.toLowerCase();
  return `http://claw.tideflo.work/chat/secretary/${tail}${token ? `?token=${token}` : ""}`;
}
// 두레이 호출 제한은 계정 단위 burst 20 / 초당 5회 충전.
// 15초 주기 × 14명 = 0.93회/초 → 한도의 19%. 여유가 있으니 응답성을 택한다.
const IDLE_MS = 15_000;               // 평소에도 15초 안에는 잡는다
const ACTIVE_MS = 5_000;              // 대화 중이면 더 촘촘히
const ACTIVE_WINDOW_MS = 30 * 60_000; // 5분은 짧다 — 답 받고 6분 뒤 물으면 느려졌다(실측)
const API = "https://api.dooray.com/messenger/v1/channels";

const log = (...a) => console.log(new Date().toISOString(), ...a);

function readJson(path, fallback = null) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return fallback;
  }
}

function writeJson(path, obj) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(obj, null, 2));
  // 원자적 교체 — 데몬이 죽어도 상태 파일이 반쯤 쓰인 채 남지 않게
  writeFileSync(path, readFileSync(tmp));
}

async function dooray(token, path, init = {}) {
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: { Authorization: `dooray-api ${token}`, "Content-Type": "application/json", ...(init.headers || {}) },
  });
  const raw = await res.text().catch(() => "");
  let body = null;
  try { body = JSON.parse(raw); } catch { return null; }
  if (!body?.header?.isSuccessful) return null;
  // ⚠ 두레이 ID 는 19자리 정수라 2^53 을 넘는다. JSON.parse 가 뒷자리를 반올림해
  // 3829042038568752240 → …752000 이 된다(실측). 원문에서 문자열로 다시 뽑는다.
  body.__raw = raw;
  return body;
}

function rawId(body, field) {
  const m = new RegExp(`"${field}"\\s*:\\s*"?(\\d+)"?`).exec(body?.__raw || "");
  return m ? m[1] : null;
}

/** '나와의 대화' 는 채널 목록에 나오지 않는다 — direct-send 응답의 channelId 로만 알 수 있다. */
async function resolveChannel(nn, token, memberId, state) {
  if (state.channelId) return state.channelId;
  const body = await dooray(token, "/direct-send", {
    method: "POST",
    body: JSON.stringify({
      organizationMemberId: String(memberId),
      text: `[TideClaw] 수신 연결됨. «${PREFIX}» 로 시작하면 제가 처리합니다. 예) ${PREFIX}이번 주 보고 초안 만들어줘`,
    }),
  });
  const id = rawId(body, "channelId");
  if (id) {
    state.channelId = String(id);
    log(`user${nn} 채널 확인 ${state.channelId}`);
  }
  return state.channelId;
}

function users() {
  const out = [];
  for (let i = 1; i <= 16; i++) {
    const nn = String(i).padStart(2, "0");
    const integ = readJson(`${DATA}/user${nn}/integrations.json`);
    const d = integ?.dooray;
    // 봇 URL 이 없으면 알림이 안 뜬다 — 수신만 열어두면 답이 온 걸 모른다
    if (d?.token && d?.memberId && d?.botUrl) out.push({ nn, token: d.token, memberId: d.memberId });
  }
  return out;
}

/** 웹 UI 와 같은 경로. challenge → connect → chat.send. */
function sendToSession(nn, message, sessionKey, label) {
  return new Promise((resolve) => {
    const cfg = readJson(`${DATA}/user${nn}/openclaw.json`);
    const token = cfg?.gateway?.auth?.token;
    if (!token) return resolve(false);
    // Origin 헤더가 없으면 게이트웨이가 거부한다 (controlUi.allowedOrigins 검사).
    // ws 클라이언트는 브라우저와 달리 Origin 을 자동으로 붙이지 않는다.
    const ws = new WebSocket(`ws://127.0.0.1:${18000 + Number(nn)}`, {
      headers: { Origin: `http://127.0.0.1:${18000 + Number(nn)}` },
    });
    const timer = setTimeout(() => { try { ws.close(); } catch {} resolve(false); }, 20_000);
    let id = 0;
    const req = (method, params) => ws.send(JSON.stringify({ type: "req", id: `r${++id}`, method, params }));
    const done = (ok) => { clearTimeout(timer); try { ws.close(); } catch {} resolve(ok); };

    ws.on("error", (e) => { log(`user${nn} ws 오류`, e.message); done(false); });
    ws.on("message", (raw) => {
      let f;
      try { f = JSON.parse(raw.toString()); } catch { return; }
      if (f.type === "event" && f.event === "connect.challenge") {
        req("connect", {
          minProtocol: 3, maxProtocol: 3,
          // client.id 는 게이트웨이가 상수로 검증한다 — 웹 UI 와 같은 값이어야 통과
          client: { id: "openclaw-control-ui", displayName: "TideClaw Dooray", version: "1.0.0", platform: "node", mode: "webchat" },
          scopes: ["operator.admin"], caps: [], auth: { token },
        });
        return;
      }
      if (f.type !== "res") return;
      if (f.payload?.type === "hello-ok") {
        req("chat.send", { sessionKey, message, idempotencyKey: `dooray-${Date.now()}-${nn}` });
        return;
      }
      if (f.payload?.status === "started") {
        // 이름 지정은 chat.send **뒤에** — 세션이 없으면 patch 가 조용히 실패한다(실측).
        // derivedTitle 이 노이즈(부트스트랩·해시 문구)일 때 웹 UI 가 이 label 을 쓴다.
        if (label) { req("sessions.patch", { key: sessionKey, label }); return; }
        done(true);
      } else if (f.payload?.entry) done(true);   // sessions.patch 응답
      else if (f.error) { log(`user${nn} chat.send 실패`, JSON.stringify(f.error).slice(0, 120)); done(false); }
    });
  });
}

async function pollUser(u, state) {
  const channelId = await resolveChannel(u.nn, u.token, u.memberId, state);
  if (!channelId) return;
  const body = await dooray(u.token, `/${channelId}/logs?size=20`);
  if (!body) return;

  const last = Number(state.lastSeq || 0);
  // seq 필터 파라미터가 없어(실측 무시됨) 최신 목록을 받아 클라이언트에서 자른다.
  const fresh = (body.result || [])
    .filter((m) => Number(m.seq) > last)
    .filter((m) => String(m.sender?.member?.organizationMemberId) === String(u.memberId))
    .filter((m) => (m.text || "").trim().startsWith(PREFIX))
    .sort((a, b) => Number(a.seq) - Number(b.seq));

  // 처리 여부와 무관하게 커서를 올린다 — 안 그러면 봇 알림·잡담이 매 주기 재검사된다
  const maxSeq = Math.max(last, ...(body.result || []).map((m) => Number(m.seq) || 0));
  if (maxSeq > last) state.lastSeq = maxSeq;

  for (const m of fresh) {
    const text = m.text.trim().slice(PREFIX.length).trim();
    if (!text) continue;
    state.lastActiveAt = Date.now();
    // 회신 지시를 메시지에 함께 싣는다 — BOOTSTRAP 은 세션 첫 턴에만 읽히므로
    // 이미 진행 중인 세션에는 새 규칙이 반영되지 않는다(실측: 회신 누락).
    const body = [
      `[두레이] ${text}`,
      "",
      "↳ 두레이에서 온 요청이다. 답한 뒤 반드시 두레이로도 회신해라:",
      `   exec: python3 /home/node/documents/work-report/scripts/notify.py ${u.nn} "3줄 이내 요약"`,
      `   카드(work-draft 등)는 두레이로 보내지 마. 대신 이 링크를 회신에 그대로 붙여라:`,
      `   ${webLink(u.nn, isoWeek())}`,
    ].join("\n");
    const week = isoWeek();
    const labelIfNew = state.labeledWeek === week ? null : sessionLabelFor(week);
    const ok = await sendToSession(u.nn, body, sessionKeyFor(week), labelIfNew);
    if (ok && labelIfNew) state.labeledWeek = week;   // 이름 지정은 주에 한 번이면 된다
    log(`user${u.nn} seq${m.seq} → ${ok ? "투입" : "실패"}: ${text.slice(0, 40)}`);
  }
}

async function main() {
  log(`두레이 수신 데몬 시작 (접두사 «${PREFIX}»)`);
  for (;;) {
    const list = users();
    for (const u of list) {
      const path = `${DATA}/user${u.nn}/work-report/dooray-state.json`;
      const state = readJson(path, {}) || {};
      const active = Date.now() - Number(state.lastActiveAt || 0) < ACTIVE_WINDOW_MS;
      if (Date.now() - Number(state.checkedAt || 0) < (active ? ACTIVE_MS : IDLE_MS)) continue;
      state.checkedAt = Date.now();
      try {
        await pollUser(u, state);
      } catch (e) {
        log(`user${u.nn} 폴링 오류`, e.message);   // 한 사람 실패가 전체를 멈추면 안 된다
      }
      writeJson(path, state);
    }
    await new Promise((r) => setTimeout(r, 2_000));
  }
}

main();
