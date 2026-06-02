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

/* 본문에 RAG 결과·exec 래퍼·시스템 덤프 마커가 하나라도 있으면 raw 덤프.
   한글 포함 여부와 무관하게 동작. */
export function containsRawDumpMarker(content: string): boolean {
  if (!content) return false;
  for (const m of RAW_TOOL_MARKERS) {
    if (content.includes(m)) return true;
  }
  for (const m of EXEC_WRAPPER_MARKERS) {
    if (content.includes(m)) return true;
  }
  return false;
}

/* 메시지 본문 본체로 사용자한테 보여줄 가치 있는지 판정. */
export function shouldHideMessage(role: string, rawContent: string): boolean {
  const c = (rawContent || '').trim();
  if (!c) return true;

  /* 0. role whitelist — user/assistant/system 셋만 통과.
     OpenClaw는 tool 결과를 role='toolResult', role='toolCall' 별도 메시지로 저장하는데
     frontend가 이를 일반 메시지처럼 받아서 raw가 노출되던 게 진짜 root cause. */
  if (role !== 'user' && role !== 'assistant' && role !== 'system') return true;

  /* 1. 사용자 메시지: 일반 raw 마커 + OpenClaw가 사용자 role로 위장해 보내는 시스템 인계 패턴 모두 hide */
  if (role === 'user') {
    if (containsRawDumpMarker(c)) return true;
    if (/^HEARTBEAT(_[A-Z]+)?\b/i.test(c)) return true;
    /* OpenClaw 시스템 인계 메시지 패턴 (user role로 위장됨) */
    if (/^System\s*\(untrusted\)\s*:/i.test(c)) return true;
    if (/An async command you ran earlier has completed/i.test(c)) return true;
    if (/Do not relay it to the user unless explicitly requested/i.test(c)) return true;
    if (/Exec completed \(kind-/i.test(c)) return true;
    if (/^\[Bootstrap pending\]/i.test(c) && !/\n\[(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)[^\]]+\]\s*\S/.test(c)) {
      /* BOOTSTRAP pending 뒤에 진짜 사용자 발화([Day YYYY-...] 문장)가 없으면 hide */
      return true;
    }
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
    .replace(/```json\s*\{\s*"status"\s*:\s*"accepted"[\s\S]*?"modelApplied":\s*true\s*\}\s*```/g, '')
    .replace(/\{\s*"status"\s*:\s*"accepted"[\s\S]*?"modelApplied":\s*true\s*\}/g, '')
    .replace(/\n?Source: memory\/[^\n]*/g, '')
    .replace(/\n?Successfully wrote \d+ bytes to [^\n]*/g, '')
    .trim();
}
