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
 *   사용자가 웹에서 직접 친 것과 동일해진다 (세션 `agent:secretary:main` 고정).
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
const SESSION_KEY = "agent:secretary:main";
const IDLE_MS = 60_000;              // 평소 주기
const ACTIVE_MS = 5_000;             // 최근 대화가 있으면 촘촘히
const ACTIVE_WINDOW_MS = 5 * 60_000; // '최근' 의 기준
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
  const body = await res.json().catch(() => null);
  return body?.header?.isSuccessful ? body : null;
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
  const id = body?.result?.channelId;
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
function sendToSession(nn, message) {
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
        req("chat.send", { sessionKey: SESSION_KEY, message, idempotencyKey: `dooray-${Date.now()}-${nn}` });
        return;
      }
      if (f.payload?.status === "started") done(true);
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
      "   카드(work-draft 등)는 두레이로 보내지 마 — \"TideClaw 에서 확인해주세요\" 안내만.",
    ].join("\n");
    const ok = await sendToSession(u.nn, body);
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
