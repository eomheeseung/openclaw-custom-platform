/* 채팅에 raw tool/system 덤프가 노출되는 것을 막는 공통 필터.
   MessageList(stream 렌더)와 useWebSocket(history reload) 양쪽에서 import.
   분산 패치로 누락되는 케이스를 막기 위해 단일 진실원으로 통합.

   shouldHideMessage(role, content) → true면 채팅창에서 숨김. */

const RAW_TOOL_MARKERS: readonly string[] = [
  /* drive/RAG */
  '"chunk_index"',
  '"file_id"',
  '"folder_path"',
  '"mime_type"',
  '"modified_time"',
  '"snippet"',
  '"citation"',
  /* browser */
  '"cdpPort"',
  '"cdpReady"',
  '"userDataDir"',
  '"targetId"',
  '"navigation"',
  '"ttfb"',
  '"loadComplete"',
  '"byType"',
  '"resource_count"',
  '"totalRequests"',
  /* agent/session */
  '"childSessionKey"',
  '"modelApplied"',
  '"runId"',
  /* dooray API raw */
  '"workflowClass"',
  '"projects":[{',
  '"members":[{',
  '"tasks":[{',
  '"userCode"',
  '"externalEmailAddress"',
  /* gmail/calendar raw */
  '"resultSizeEstimate"',
  '"threadId"',
  '"labelIds"',
  '"messagesTotal"',
];

const EXEC_WRAPPER_MARKERS: readonly string[] = [
  'Process exited with code',
  'Command exited',
  'Command still running',
  'This operation was aborted',
  'Successfully wrote',
  'Source: memory/',
  'OpenClaw runtime context',
  'BEGIN_UNTRUSTED_CHILD_RESULT',
  'END_UNTRUSTED_CHILD_RESULT',
  '[Internal task completion event]',
  'runtime-generated, not user-authored',
  'Sender (untrusted metadata)',
  '===SOUL.md===',
  '===IDENTITY.md===',
  '===EMOJI===',
  'HEARTBEAT.md',
  '===AGENTS.md===',
  /* shell stdout 흔적 */
  'EXIT:0',
  'EXIT:1',
  'EXIT:2',
  'EXIT:127',
  '/usr/local/bin/',
  '/usr/local/sbin/',
  '/usr/bin/:',
  ':/usr/bin/',
];

const BOOTSTRAP_LEAK_MARKERS: readonly string[] = [
  '절대 위반 금지',
  '## 메모리 (이전 대화',
];

/* 인터랙티브 카드 fence — 이 안의 JSON은 raw dump 아님 (의도된 렌더링).
   biz-picker/sr-table/... JSON에 "projects":[{ 같은 raw 마커가 포함될 수 있어서
   먼저 예외 처리. */
const CARD_FENCE_MARKERS: readonly string[] = [
  '```biz-picker',
  '```sr-table',
  '```week-picker',
  '```grouping-editor',
  '```draft-card',
  '```download-card',
  '```work-draft',
  '```tool-pick',
];

/* 본문에 RAG 결과·exec 래퍼·시스템 덤프 마커가 하나라도 있으면 raw 덤프.
   한글 포함 여부와 무관하게 동작. */
/* 서브에이전트는 카드를 ```json {"kind":"sr-table","data":{…}} 형태로도 낸다.
   ```json 자체를 카드로 인정하면 평범한 JSON 응답까지 통과하므로 kind 키까지 확인한다. */
/* 모델은 같은 카드를 ```json 으로 감싸기도, 맨 JSON 으로 내기도 한다(실측 둘 다 관찰). */
/** 보고 담당에게 보낼 때 덧붙이는 마무리 지시 — 사용자에게 보일 내용이 아니다.
    (두레이 데몬이 붙이는 지시와 같은 목적. 웹은 이게 없어 카드가 자주 누락됐다) */
export const FINISH_HINT = '↳ 마무리 단계를 반드시 실행해라 (거기서 카드가 나온다). 결과를 네 말로 다시 쓰지 마라.';

const KIND_CARD_RE = /^\s*(?:```json\s*)?\[?\s*\{\s*"kind"\s*:/;

/** 펜스 뒤에 **파싱되는 JSON** 이 실제로 있어야 카드로 인정한다.
    문자열만 보고 통과시키면 스크립트 소스(print("```work-draft…") 같은 코드)까지
    화면에 그대로 쏟아진다(실측: finish.py 소스가 대화에 노출). */
export function looksLikeRenderableCard(content: string): boolean {
  for (const fence of CARD_FENCES) {
    let i = content.indexOf(fence);
    while (i >= 0) {
      const rest = content.slice(i + fence.length);
      const start = rest.search(/[[{]/);
      if (start >= 0 && start < 40) {
        const body = rest.slice(start).replace(/```[\s\S]*$/, '').trim();
        try {
          JSON.parse(body);
          return true;
        } catch { /* 다음 후보 */ }
      }
      i = content.indexOf(fence, i + 1);
    }
  }
  return false;
}

export function containsRawDumpMarker(content: string): boolean {
  if (!content) return false;
  /* 카드 fence가 있으면 raw 덤프로 취급 X */
  for (const m of CARD_FENCE_MARKERS) {
    if (content.includes(m)) return false;
  }
  if (KIND_CARD_RE.test(content)) return false;
  for (const m of RAW_TOOL_MARKERS) {
    if (content.includes(m)) return true;
  }
  for (const m of EXEC_WRAPPER_MARKERS) {
    if (content.includes(m)) return true;
  }
  return false;
}

/* 웹챗 사용자 메시지 앞에 OpenClaw가 붙이는 래퍼([Bootstrap pending] 안내문 +
   Sender (untrusted metadata) JSON) 를 벗기고 실제 발화만 남긴다.
   ⚠ MessageList 의 렌더 경로도 이 함수를 쓴다 — 로직을 여기 한 곳에만 둘 것.
   래퍼를 못 벗기면(타임스탬프 없음) 원문을 그대로 돌려주므로, 호출부에서
   raw 마커 검사에 걸려 자연히 숨겨진다. */
export function stripUserWrapper(content: string): string {
  if (!content) return content;
  let out = content;
  const TS = /\[(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)\s+\d{4}-\d{2}-\d{2}\s+\d{1,2}:\d{2}\s+GMT[+-]\d+\]\s*/;
  if (out.startsWith('[Bootstrap pending]')) {
    const re = new RegExp(TS.source, 'g');
    let last: RegExpExecArray | null = null;
    let m: RegExpExecArray | null;
    while ((m = re.exec(out)) !== null) last = m;
    if (last) out = out.slice(last.index + last[0].length);
  } else {
    out = out.replace(new RegExp('^' + TS.source), '');
  }
  return out.trim();
}

/* 메시지 본문 본체로 사용자한테 보여줄 가치 있는지 판정. */
const CARD_FENCES = [
  '```work-draft', '```tool-pick', '```biz-picker', '```sr-table', '```week-picker',
  '```grouping-editor', '```draft-card', '```download-card',
];

export function shouldHideMessage(role: string, rawContent: string): boolean {
  const c = (rawContent || '').trim();
  if (!c) return true;

  /* 0-A. 도구 결과라도 **카드 블록이 들어 있으면 통과**시킨다.
     모델에게 카드를 출력하게 시키면 매번 자기 말로 요약해 카드가 사라진다(실측 5회+,
     비서·서브에이전트 양쪽). 스크립트가 카드를 출력하고 도구 결과로 흘려보내면
     모델이 개입할 여지가 없다. 에이전트가 늘어도 여기 손댈 것이 없다. */
  if (role === 'toolResult' && looksLikeRenderableCard(c)) return false;

  /* 0. role whitelist — user/assistant/system 셋만 통과.
     OpenClaw는 tool 결과를 role='toolResult', role='toolCall' 별도 메시지로 저장하는데
     frontend가 이를 일반 메시지처럼 받아서 raw가 노출되던 게 진짜 root cause. */
  if (role !== 'user' && role !== 'assistant' && role !== 'system') return true;

  /* 1. 사용자 메시지: 일반 raw 마커 + OpenClaw가 사용자 role로 위장해 보내는 시스템 인계 패턴 모두 hide */
  if (role === 'user') {
    /* 시스템이 user role 로 위장해 보내는 인계 메시지 — 래퍼 벗기기 전 원문 기준 판정 */
    if (/^HEARTBEAT(_[A-Z]+)?\b/i.test(c)) return true;
    if (/^System\s*\(untrusted\)\s*:/i.test(c)) return true;
    if (/An async command you ran earlier has completed/i.test(c)) return true;
    if (/Do not relay it to the user unless explicitly requested/i.test(c)) return true;
    if (/Exec completed \(kind-/i.test(c)) return true;

    /* ⚠ raw 마커 검사는 반드시 래퍼를 벗긴 뒤에 한다.
       OpenClaw 는 웹챗 사용자 발화 앞에 'Sender (untrusted metadata)' 블록을 항상 붙이는데,
       그 문자열이 EXEC_WRAPPER_MARKERS 에 있어서 원문 기준으로 검사하면
       사용자 메시지가 예외 없이 전부 숨겨진다 (히스토리 재로드 시 질문만 사라지던 원인). */
    const body = stripUserWrapper(c);
    if (!body) return true;                       // 래퍼만 있고 실제 발화 없음
    if (containsRawDumpMarker(body)) return true; // 벗긴 뒤에도 raw 덤프면 숨김
    return false;
  }

  /* 2. system 메시지: 작업 진행 표시는 통과, 나머지는 엄격 */
  if (role === 'system') {
    if (c.includes('작업 중...') || c.includes('완료')) return false;
    if (c.startsWith('---\nname:')) return true;
    if (c.startsWith('```bash') || c.includes('curl ')) return true;
    if (c.includes('Weather report')) return true;
    if (c.startsWith('{')) return true;
    if (containsRawDumpMarker(c)) return true;
    return false;
  }

  /* 3. assistant 메시지: raw 덤프 마커 / JSON 단독 응답 / BOOTSTRAP 누출 거름 */
  if (KIND_CARD_RE.test(c)) return false;        // 카드 묶음은 무조건 통과
  if (looksLikeRenderableCard(c)) return false;   // 문장 뒤에 붙은 펜스도 카드다
  if (containsRawDumpMarker(c)) return true;
  if (/^HEARTBEAT(_[A-Z]+)?\b/i.test(c)) return true;
  if (c === 'Source: memory/' || /^Source: memory\//.test(c)) return true;

  /* assistant 본문이 자연어 산문이 아닌 raw 출력 패턴이면 hide.
     한글 포함 여부 무관 — backend가 exec stdout을 본문에 박는 OpenClaw 고질 패턴 차단. */
  if (c.startsWith('/') && /^\/[a-z][\w/.-]+/i.test(c.split('\n')[0])) {
    /* "/usr/local/bin/gog" 같은 절대 경로 dump (마크다운 헤더 아닌) */
    if (!/^\/\s/.test(c)) return true;
  }
  if (c.startsWith('{') && (c.includes('EXIT:') || c.match(/}\s*EXIT:/))) return true;
  if (/}\s*EXIT:\d+\s*$/.test(c.trim())) return true;
  if (c.startsWith('{') && c.length > 80) {
    /* 200자 초과 + 자연어 산문 흐름 없으면 raw로 간주 */
    const hasProse = /[가-힣]{2,}(?:은|는|이|가|을|를|에|의|와|과|로|으로|에서|부터|까지|하다|입니다|습니다)/.test(c);
    if (!hasProse) return true;
  }

  /* BOOTSTRAP 룰을 그대로 응답한 경우 */
  if (/^#\s*시스템 규칙/i.test(c)) return true;
  for (const m of BOOTSTRAP_LEAK_MARKERS) {
    if (c.includes(m) && (c.includes('memory_search') || c.includes('BOOTSTRAP.md'))) return true;
  }

  /* JSON 단독 응답: { 로 시작해서 } 로 끝나는 본문이 200자 넘으면 거름.
     한글 포함이라도 본문 형식이 JSON이면 tool dump로 간주. */
  if (/^\{[\s\S]*\}$/.test(c) && c.length > 200) {
    const hasReadableProse = /[가-힣]{3,}\s+[가-힣]{2,}\s+[가-힣]{2,}/.test(c);
    if (!hasReadableProse) return true;
  }

  /* { 로 시작하면서 잘 알려진 tool 응답 키 조합이면 거름 */
  if (c.startsWith('{')) {
    if (c.includes('"status"') && c.includes('"accepted"')) return true;
    if (c.includes('"results"') || c.includes('"provider"') || c.includes('"score"')) return true;
    if (c.includes('"ok":true') && c.includes('"messageId"')) return true;
    if (c.includes('"ok"') && (c.includes('"error"') || c.includes('"account"') || c.includes('"events"') || c.includes('"files"') || c.includes('"drives"') || c.includes('"messages"') || c.includes('"content"'))) return true;
  }

  /* exec/shell 원시 출력 패턴 */
  if (c.startsWith('(') && c.endsWith(')') && (c.includes('Command exited') || c.includes('no output') || c.includes('Command still running'))) return true;
  if (/^tc-user\d+$/.test(c)) return true;
  if (/^total \d+/m.test(c) && /[d-]rwx/m.test(c)) return true;

  /* 너무 짧으면 거름 (로딩 표시 제외는 호출처에서 처리) */
  if (c.length < 2) return true;

  return false;
}

/* 표시 직전 본문 정리: 사용자한테 노이즈 prefix 제거. */
export function cleanDisplayContent(content: string): string {
  if (!content) return '';
  return content
    /* 두레이 데몬이 메시지에 함께 싣는 회신 지시 — 사용자에게 보일 내용이 아니다.
       BOOTSTRAP 은 세션 첫 턴에만 읽혀서 지시를 본문에 동봉할 수밖에 없다. */
    .replace(/\n*↳ 두레이에서 온 요청이다[\s\S]*$/g, '')
    .replace(/\n*↳ 마무리 단계를 반드시 실행해라[\s\S]*$/g, '')
    /* 스크립트 실행 결과의 부산물 — 카드만 보이면 된다 */
    .replace(/^\s*\{"ok":\s*(?:true|false)[^\n]*\}\s*$/gm, '')
    .replace(/^\s*Process exited with code \d+\.\s*$/gm, '')
    .replace(/```json\s*\{\s*"status"\s*:\s*"accepted"[\s\S]*?"modelApplied":\s*true\s*\}\s*```/g, '')
    .replace(/\{\s*"status"\s*:\s*"accepted"[\s\S]*?"modelApplied":\s*true\s*\}/g, '')
    .replace(/\n?Source: memory\/[^\n]*/g, '')
    .replace(/\n?Successfully wrote \d+ bytes to [^\n]*/g, '')
    .trim();
}
