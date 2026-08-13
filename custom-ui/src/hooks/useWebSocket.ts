import { useState, useEffect, useRef, useCallback } from 'react';
import type { Message, ConnectionStatus, Agent, Session, ProtocolFrame } from '../types';
import { shouldHideMessage } from '../utils/messageFilter';
import { resolveAgentFor } from '../utils/agentRouting';
import { FINISH_HINT, isConfirmRequest } from '../utils/messageFilter';

interface UseWebSocketProps {
  url: string;
  token: string;
}

interface UseWebSocketReturn {
  connectionStatus: ConnectionStatus;
  messages: Message[];
  sendMessage: (content: string) => void;
  /** 프론트가 직접 assistant 메시지를 화면에 삽입 (LLM 우회 · 서버 저장 안 됨) */
  injectAssistantMessage: (content: string) => void;
  agents: Agent[];
  sessions: Session[];
  currentSession: string | null;
  createSession: (agentId?: string) => void;
  switchSession: (sessionKey: string) => void;
  clearSession: () => void;
  loadSessionHistory: (sessionKey: string) => void;
  deleteSession: (sessionKey: string) => Promise<void>;
  stopChat: () => void;
  isLoading: boolean;
  /** 진행 단계 문구 (없으면 빈 문자열) */
  progress: string;
  apiCallCount: number;
  sendRequest: (method: string, params?: Record<string, unknown>) => Promise<ProtocolFrame>;
  fetchAgents: () => Promise<void>;
  fetchSessions: () => Promise<void>;
}

/* 브라우저는 nginx 를 거쳐 오므로 서버가 IP 로 사용자를 못 알아낸다 — 주소의 token 에서 뽑는다 */
function draftQuery(): string {
  const t = typeof window !== 'undefined'
    ? new URLSearchParams(window.location.search).get('token') || '' : '';
  const m = t.match(/user(\d+)/i);
  return m ? `?userNN=${m[1].padStart(2, '0')}` : '';
}

function generateId(): string {
  return crypto.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function sessionsCacheKey(token: string): string {
  const m = token.match(/user(\d+)/i);
  const slot = m ? m[1].padStart(2, '0') : 'default';
  return `tideclaw-sessions-cache-${slot}`;
}

function loadCachedSessions(token: string): Session[] {
  try {
    const raw = localStorage.getItem(sessionsCacheKey(token));
    if (!raw) return [];
    return JSON.parse(raw) as Session[];
  } catch { return []; }
}

function saveCachedSessions(token: string, sessions: Session[]) {
  try { localStorage.setItem(sessionsCacheKey(token), JSON.stringify(sessions)); } catch { /* ignore */ }
}

function humanizeAgentError(raw: string): string {
  const msg = (raw || '').trim();
  if (!msg) return '⚠️ 알 수 없는 오류가 발생했어요. 잠시 후 다시 시도해주세요.';
  const lower = msg.toLowerCase();

  // Unknown model — 모델 카탈로그에서 찾지 못함
  const unknownModel = msg.match(/Unknown model:\s*([^\s,)]+)/i);
  if (unknownModel) {
    return `⚠️ 모델 사용 불가\n\n선택된 모델 \`${unknownModel[1]}\`을(를) 현재 사용할 수 없어요. 관리자에게 문의하시거나 다른 모델로 전환해주세요.\n\n원본: ${msg}`;
  }

  // 잔액 부족 / 계정 정지
  if (/insufficient[_\s-]?balance|insufficient_quota|account.*suspend|suspended.*balance/i.test(msg)) {
    return `⚠️ API 잔액 부족\n\n현재 사용 중인 API 키의 잔액이 부족하거나 계정이 일시 정지되었어요. 관리자에게 문의해주세요.\n\n원본: ${msg}`;
  }

  // 인증 실패
  if (/\b401\b|unauthorized|invalid.*api.*key|authentication.*fail|invalid_api_key/i.test(msg)) {
    return `⚠️ 인증 실패\n\nAPI 키가 유효하지 않거나 만료되었어요. 관리자에게 문의해주세요.\n\n원본: ${msg}`;
  }

  // Rate limit / 429
  if (/\b429\b|rate.?limit|too many requests|quota.*exceed|usage.*limit/i.test(msg)) {
    return `⚠️ API 사용량 한도 초과\n\n짧은 시간에 너무 많은 요청을 보냈거나 일/월 한도에 도달했어요. 잠시 후 다시 시도해주세요.\n\n원본: ${msg}`;
  }

  // 과부하 / 503
  if (/overload|\b503\b|service.?unavailable|server.?busy/i.test(msg)) {
    return `⚠️ 서버 과부하\n\nAI 모델 서버가 일시적으로 과부하 상태예요. 잠시 후 다시 시도해주세요.\n\n원본: ${msg}`;
  }

  // 타임아웃
  if (/timeout|timed out|deadline.*exceed/i.test(msg)) {
    return `⚠️ 응답 시간 초과\n\n모델이 정해진 시간 안에 응답하지 못했어요. 다시 시도하거나 질문을 짧게 나눠보세요.\n\n원본: ${msg}`;
  }

  // 네트워크
  if (/network|fetch failed|econnrefused|enotfound|socket hang up|connection.*reset/i.test(msg)) {
    return `⚠️ 네트워크 오류\n\n외부 모델 서버와 연결하지 못했어요. 잠시 후 다시 시도해주세요.\n\n원본: ${msg}`;
  }

  // Context length
  if (/context.?length|context.?window|too.?many.?tokens|maximum.?context/i.test(msg)) {
    return `⚠️ 컨텍스트 길이 초과\n\n대화가 너무 길어서 모델이 처리할 수 있는 한도를 넘었어요. 새 세션을 시작하거나 /compact를 실행해주세요.\n\n원본: ${msg}`;
  }

  // Failover
  if (/FailoverError|all providers failed|no.?provider.?available/i.test(msg)) {
    return `⚠️ 모든 모델 사용 불가\n\n등록된 모든 모델/키가 일시적으로 응답하지 못해요. 잠시 후 다시 시도하거나 관리자에게 문의해주세요.\n\n원본: ${msg}`;
  }

  // 권한
  if (/\b403\b|forbidden|permission.?denied/i.test(msg)) {
    return `⚠️ 권한 없음\n\n이 작업을 수행할 권한이 없어요. 관리자에게 문의해주세요.\n\n원본: ${msg}`;
  }

  // 기본
  return `⚠️ 오류 발생\n\n${msg}`;
}

export function useWebSocket({ url, token }: UseWebSocketProps): UseWebSocketReturn {
  const ws = useRef<WebSocket | null>(null);
  const [connectionStatus, setConnectionStatus] = useState<ConnectionStatus>({
    connected: false,
    health: 'connecting',
  });
  const [messages, setMessages] = useState<Message[]>([]);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [sessions, setSessions] = useState<Session[]>(() => loadCachedSessions(token));
  const [currentSession, setCurrentSession] = useState<string | null>(null);
  const [apiCallCount, setApiCallCount] = useState(0);
  const [isSending, setIsSending] = useState(false);
  /* 지금 무슨 단계인지 — 초 숫자만 늘어나면 멈춘 건지 도는 건지 알 수 없다(실측 200초) */
  const [progress, setProgress] = useState('');

  const reconnectTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);
  const messageIdCounter = useRef(0);
  const authenticated = useRef(false);
  const pendingRequests = useRef<Map<string, (frame: ProtocolFrame) => void>>(new Map());
  const currentRunId = useRef<string | null>(null);
  const mainRunId = useRef<string | null>(null); // chat.send에서 시작된 메인 runId
  const knownRunIds = useRef<Set<string>>(new Set()); // 메인 세션의 runId 목록
  const subagentReturned = useRef<boolean>(false); // 서브에이전트 종료 → 비서로 전달된 상태
  const mentionSessionKeys = useRef<Map<string, string>>(new Map()); // mention sessionKey → target agentId
  const mentionParentByKey = useRef<Map<string, string>>(new Map()); // mention sessionKey → parent sessionKey
  /* 직전에 응답한 멘션 에이전트 — 카드 조작·후속 질문이 비서로 새지 않게 이어 붙인다.
     "예정사항에 항목 추가해줘" 처럼 에이전트 이름이 없는 후속 문장이 비서로 가면
     비서가 다시 위임하면서 카드가 사라진다(실측). */
  const lastMentionAgentRef = useRef<string | null>(null);
  /* 확정·발송 요청이었는지 — 그때는 초안 카드를 다시 그리지 않는다 */
  const lastWasConfirm = useRef(false);
  const agentsRef = useRef<Agent[]>([]);
  const tokenRef = useRef(token);
  tokenRef.current = token;

  // 레거시 session-title:* localStorage 캐시 일회성 정리
  useEffect(() => {
    try {
      const keysToRemove: string[] = [];
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k && k.startsWith('session-title:')) keysToRemove.push(k);
      }
      keysToRemove.forEach(k => localStorage.removeItem(k));
    } catch {}
  }, []);

  // 멘션 로그 localStorage 헬퍼 (부모 세션별로 멘션 주고받기 저장)
  type MentionLogEntry = {
    id: string;
    role: 'user' | 'assistant';
    content: string;
    ts: number;
    mentionAgentId: string;
  };
  const mentionLogKey = (parentKey: string) => `mention-log:${tokenRef.current}:${parentKey}`;
  const readMentionLog = (parentKey: string): MentionLogEntry[] => {
    try {
      const raw = localStorage.getItem(mentionLogKey(parentKey));
      if (!raw) return [];
      const arr = JSON.parse(raw);
      return Array.isArray(arr) ? arr : [];
    } catch { return []; }
  };
  const appendMentionLog = (parentKey: string, entry: MentionLogEntry) => {
    try {
      const log = readMentionLog(parentKey);
      log.push(entry);
      localStorage.setItem(mentionLogKey(parentKey), JSON.stringify(log));
    } catch {}
  };

  // Stable sendRequest — no deps, uses ws ref directly
  const sendRequest = useCallback((method: string, params: Record<string, unknown> = {}): Promise<ProtocolFrame> => {
    return new Promise((resolve, reject) => {
      if (ws.current?.readyState !== WebSocket.OPEN) {
        reject(new Error('WebSocket not connected'));
        return;
      }
      const id = generateId();
      const frame = { type: 'req', id, method, params };
      pendingRequests.current.set(id, resolve);
      ws.current.send(JSON.stringify(frame));
      setTimeout(() => {
        if (pendingRequests.current.has(id)) {
          pendingRequests.current.delete(id);
          reject(new Error(`Request ${method} timed out`));
        }
      }, 30000);
    });
  }, []);

  const fetchAgents = useCallback(async () => {
    try {
      const configRes = await sendRequest('config.get', {});
      const configPayload = (configRes as { payload?: Record<string, unknown> }).payload;
      const config = configPayload?.config as Record<string, unknown>;
      const agentsConfig = config?.agents as Record<string, unknown> || {};
      const list = (agentsConfig?.list as Array<Record<string, unknown>>) || [];
      const agentList = list.map(a => {
        const identity = a.identity as { name?: string; emoji?: string } | undefined;
        const subagents = a.subagents as { allowAgents?: string[] } | undefined;
        return {
          id: (a.id as string) || '',
          name: identity?.name || (a.name as string) || (a.id as string) || '',
          emoji: identity?.emoji || '',
          subagents: subagents?.allowAgents,
          default: (a.default as boolean) || false,
          aliases: (a.aliases as string[]) || [],
        };
      });
      /* 별칭은 서버 파일에 있다 — openclaw.json 에 넣으면 스키마가 거부한다(실측: 재시작 루프).
         두레이 데몬과 같은 파일을 보므로 채널마다 다르게 동작하지 않는다. */
      try {
        const nn = (tokenRef.current.match(/user(\d+)/)?.[1] || '').padStart(2, '0');
        const r = await fetch(`/api/agent-aliases?userNN=${nn}`, { credentials: 'include' });
        const j = await r.json() as { ok?: boolean; aliases?: Record<string, string[]> };
        if (j?.ok && j.aliases) {
          for (const a of agentList) a.aliases = j.aliases[a.id] || [];
        }
      } catch { /* 별칭이 없어도 이름 매칭은 동작한다 */ }
      setAgents(agentList);
      agentsRef.current = agentList;
    } catch (err) {
      console.error('Failed to fetch agents:', err);
    }
  }, [sendRequest]);

  const fetchSessions = useCallback(async () => {
    try {
      const res = await sendRequest('sessions.list', {
        limit: 50,
        activeMinutes: 10080,
        includeLastMessage: true,
        includeDerivedTitles: true,
      });
      const payload = (res as { payload?: Record<string, unknown> }).payload;
      if (payload?.sessions) {
        const sessionList = (payload.sessions as Array<{
          key: string;
          agentId?: string;
          label?: string;
          updatedAt?: number;
          startedAt?: number;
          endedAt?: number;
          lastMessageAt?: number;
          messageCount?: number;
          derivedTitle?: string;
        }>).map(s => {
          // 서버 응답의 실제 필드명: updatedAt (startedAt/endedAt도 있음)
          const lastTs = s.updatedAt ?? s.endedAt ?? s.startedAt ?? s.lastMessageAt;
          // 세션 이름 정리: derivedTitle > 정리된 label > 날짜 fallback
          // 노이즈 라벨 판별 (사용자에게 보이면 안 되는 패턴)
          const isNoise = (s: string) => !s
            || s.includes('untrusted')
            || s.includes('Sender')
            || s.includes('metadata')
            || s.startsWith('[파일:')
            || s.toUpperCase().includes('HEARTBEAT')
            || /\[Bootstrap pending\]/i.test(s)
            || /Please read BOOTSTRAP\.md/i.test(s)
            || /^[a-zA-Z0-9_-]{6,16}(\s*\(.*\))?$/i.test(s);

          const rawLabel = (s.label || '').trim();
          const dt = (s.derivedTitle || '').trim();
          const fmtDate = (ts?: number) => {
            if (!ts) return '';
            const d = new Date(ts);
            return `${d.getMonth() + 1}월 ${d.getDate()}일 ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
          };

          // 서버 derivedTitle 우선, 그 다음 서버 label, 마지막 날짜 fallback (localStorage 캐시 제거)
          let displayLabel = '';
          if (dt && !isNoise(dt)) {
            displayLabel = dt;
          } else if (!isNoise(rawLabel)) {
            displayLabel = rawLabel;
          } else if (lastTs) {
            displayLabel = `${fmtDate(lastTs)} 대화`;
          } else {
            const parts = s.key.split(':');
            displayLabel = `대화 ${parts[parts.length - 1] || ''}`.trim();
          }
          return {
            sessionKey: s.key,
            agentId: s.agentId,
            label: displayLabel,
            lastMessageAt: lastTs ? new Date(lastTs).toISOString() : undefined,
            messageCount: s.messageCount,
            derivedTitle: s.derivedTitle,
          };
        });
        setSessions(sessionList);
        saveCachedSessions(token, sessionList);
      }
    } catch (err) {
      console.error('Failed to fetch sessions:', err);
    }
  }, [sendRequest, token]);

  // Use refs for handlers so connect() never needs to change
  const handlersRef = useRef({
    onChallenge: async (nonce: string) => {},
    onChatEvent: (payload: Record<string, unknown>) => {},
    onAgentEvent: (payload: Record<string, unknown>) => {},
  });

  // Keep handlers up to date via ref (no dependency chain)
  handlersRef.current.onChallenge = async (nonce: string) => {
    try {
      const res = await sendRequest('connect', {
        minProtocol: 3,
        maxProtocol: 3,
        client: {
          id: 'openclaw-control-ui',
          displayName: 'TideClaw Chat',
          version: '1.0.0',
          platform: 'web',
          mode: 'webchat',
        },
        scopes: ['operator.admin'],
        caps: ['tool-events'],
        auth: { token: tokenRef.current },
      });
      const payload = (res as { payload?: Record<string, unknown> }).payload;
      if (payload?.type === 'hello-ok') {
        authenticated.current = true;
        setConnectionStatus({ connected: true, health: 'ok', lastPing: new Date() });
        fetchAgents();
        fetchSessions();
        const snapshot = payload.snapshot as { sessionDefaults?: { mainSessionKey?: string } } | undefined;
        if (snapshot?.sessionDefaults?.mainSessionKey) {
          setCurrentSession(prev => prev || snapshot.sessionDefaults!.mainSessionKey!);
        }
      }
    } catch (err) {
      console.error('Authentication failed:', err);
      setConnectionStatus({ connected: false, health: 'error' });
    }
  };

  handlersRef.current.onChatEvent = (payload: Record<string, unknown>) => {
    const state = payload.state as string;
    const runId = payload.runId as string;
    const message = payload.message as {
      content?: Array<{ type: string; text?: string }> | string;
    } | undefined;

    let text = '';
    if (message?.content) {
      if (typeof message.content === 'string') {
        text = message.content;
      } else if (Array.isArray(message.content)) {
        text = message.content.filter(b => b.type === 'text' && b.text).map(b => b.text).join('');
      }
    }

    setApiCallCount(prev => prev + 1);

    if (state === 'delta') {
      // sessionKey 기반 필터링: payload의 sessionKey가 현재 세션과 다르면 서브에이전트
      const evtSessionKey = payload.sessionKey as string | undefined;
      const mentionAgentId = evtSessionKey ? mentionSessionKeys.current.get(evtSessionKey) : undefined;
      const isMention = !!mentionAgentId;
      if (!isMention && evtSessionKey && currentSession && evtSessionKey !== currentSession) {
        return; // 서브에이전트 스트리밍 숨기기
      }
      // sessionKey가 없으면 기존 runId 기반 fallback
      if (!evtSessionKey && mainRunId.current && !knownRunIds.current.has(runId)) {
        return;
      }
      currentRunId.current = runId;
      knownRunIds.current.add(runId);
      setMessages(prev => {
        // 이전 run의 isLoading 메시지 전부 완료 처리 (도구 카드는 정리, working 카드는 유지)
        const cleared = prev.map(m => {
          if (m.isLoading && m.id !== `run-${runId}`) {
            // 도구 카드면 toolCalls도 completed로 마킹 + duration 계산
            if (m.id.startsWith('toolcall-') && m.toolCalls && m.toolCalls.length > 0) {
              const elapsed = Date.now() - m.timestamp.getTime();
              return {
                ...m,
                isLoading: false,
                toolCalls: m.toolCalls.map(t => ({ ...t, status: 'completed' as const, duration: t.duration || elapsed })),
              };
            }
            // working 카드는 isLoading 유지 (서브에이전트 작업 중)
            if (m.id.startsWith('working-')) {
              return m;
            }
            return { ...m, isLoading: false };
          }
          return m;
        });
        // 같은 runId의 기존 assistant 메시지 찾아서 update
        const existingIdx = cleared.findIndex(m => m.role === 'assistant' && m.id === `run-${runId}`);
        if (existingIdx >= 0) {
          return cleared.map((m, i) => i === existingIdx ? { ...m, content: text, isLoading: true } : m);
        }
        // NEW assistant message: working 카드는 그대로 유지 (sessions_spawn end에서 처리)
        return [...cleared, { id: `run-${runId}`, role: 'assistant' as const, content: text, timestamp: new Date(), isLoading: true, mentionAgentId }];
      });
    } else if (state === 'final') {
      // 서브에이전트 final은 메인 채팅에 표시 안 함 (sessionKey 우선)
      const evtSessionKey = payload.sessionKey as string | undefined;
      const mentionAgentId = evtSessionKey ? mentionSessionKeys.current.get(evtSessionKey) : undefined;
      const isMention = !!mentionAgentId;
      const isSubagent = !isMention && ((evtSessionKey && currentSession && evtSessionKey !== currentSession)
        || (!evtSessionKey && mainRunId.current && !knownRunIds.current.has(runId)));
      if (isSubagent) {
        // 서브에이전트 final → sessionKey에서 agentId 추출해서 해당 working 카드 제거
        const subSessionKey = (payload.sessionKey as string) || '';
        const m1 = subSessionKey.match(/^agent:([^:]+):/);
        const m2 = subSessionKey.match(/agent[:_-]([a-zA-Z0-9_-]+)/);
        const endedAgentId = m1?.[1] || m2?.[1] || '';

        setMessages(prev => {
          let updated = prev;
          if (endedAgentId) {
            // 정확한 agentId 매칭
            updated = prev.filter(m => !(m.id.startsWith('working-') && m.id.endsWith(`-${endedAgentId}`)));
          } else {
            // 매칭 실패 시 fallback: 가장 오래된 working 1개
            const idx = prev.findIndex(m => m.id.startsWith('working-'));
            if (idx >= 0) {
              updated = [...prev.slice(0, idx), ...prev.slice(idx + 1)];
            }
          }
          // 도구 카드 정리
          return updated.map(m => {
            if (m.isLoading && m.id.startsWith('toolcall-') && m.toolCalls && m.toolCalls.length > 0) {
              const elapsed = Date.now() - m.timestamp.getTime();
              return {
                ...m,
                isLoading: false,
                toolCalls: m.toolCalls.map(t => ({ ...t, status: 'completed' as const, duration: t.duration || elapsed })),
              };
            }
            return m;
          });
        });
        return;
      }
      knownRunIds.current.add(runId);
      currentRunId.current = null;
      setIsSending(false);
      setMessages(prev => {
        // parent final → 도구 카드 정리 + working 카드 제거
        let updated = prev.filter(m => !m.id.startsWith('working-')).map(m => {
          if (m.isLoading && m.id.startsWith('toolcall-') && m.toolCalls && m.toolCalls.length > 0) {
            const elapsed = Date.now() - m.timestamp.getTime();
            return {
              ...m,
              isLoading: false,
              toolCalls: m.toolCalls.map(t => ({ ...t, status: 'completed' as const, duration: t.duration || elapsed })),
            };
          }
          if (m.isLoading && m.id.startsWith('tool-')) {
            return { ...m, isLoading: false };
          }
          return m;
        });

        const idx = updated.findIndex(m => m.id === `run-${runId}`);
        if (idx >= 0) {
          updated[idx] = { ...updated[idx], content: text, isLoading: false, mentionAgentId: mentionAgentId || updated[idx].mentionAgentId };
          return updated;
        }
        return [...updated, { id: `run-${runId}`, role: 'assistant' as const, content: text, timestamp: new Date(), isLoading: false, mentionAgentId }];
      });
      // mention 세션 완료 → 부모 세션 로그에 응답 저장 후 map 정리
      if (mentionAgentId) lastMentionAgentRef.current = mentionAgentId;
      if (isMention && evtSessionKey && mentionAgentId) {
        const parentKey = mentionParentByKey.current.get(evtSessionKey);
        if (parentKey) {
          appendMentionLog(parentKey, {
            id: `run-${runId}`,
            role: 'assistant',
            content: text,
            ts: Date.now(),
            mentionAgentId,
          });
        }
        mentionSessionKeys.current.delete(evtSessionKey);
        mentionParentByKey.current.delete(evtSessionKey);
      }
      if (!isMention) {
        fetchSessions();
        setTimeout(() => fetchSessions(), 1500);
      }
      /* 업무보고 초안 카드는 도구 출력에 실려 있는데, 게이트웨이는 verbose='full' 일 때만
         그 내용을 실어 보낸다(확인: allowToolOutput = verbose === "full").
         그래서 실시간에는 카드가 도착하지 않고 새로고침해야 보였다(실측 2회).
         전체 도구 출력을 켜면 모든 명령 결과가 화면에 쏟아지므로, 초안만 직접 받아 그린다. */
      // 메인 실행은 payload 에 sessionKey 가 없다(서브에이전트일 때만 실린다) —
      // 화면이 보고 있는 세션으로 판단해야 카드가 뜬다(실측: 조건이 안 맞아 계속 안 떴다)
      const wrKey = evtSessionKey || currentSession || '';
      if (/^agent:work-report:/.test(wrKey) && !lastWasConfirm.current) {
        fetch(`/api/work-report/draft${draftQuery()}`, { credentials: 'include' })
          .then(r => r.json())
          .then(j => {
            if (!j?.ok || !j.draft) return;
            const body = '```work-draft\n' + JSON.stringify(j.draft, null, 2) + '\n```';
            setMessages(prev => prev.some(m => m.id === `draft-${runId}`) ? prev : [...prev, {
              id: `draft-${runId}`,
              role: 'toolResult' as const,
              content: body,
              timestamp: new Date(),
            }]);
          })
          .catch(() => { /* 초안이 없으면 그냥 안 그린다 */ });
      }
    } else if (state === 'error') {
      currentRunId.current = null;
      setIsSending(false);
      setProgress('');
      const errorMessage = (payload.errorMessage as string) || '';
      const friendly = humanizeAgentError(errorMessage);
      setMessages(prev => {
        const idx = prev.findIndex(m => m.id === `run-${runId}`);
        if (idx >= 0) {
          const updated = [...prev];
          updated[idx] = { ...updated[idx], content: friendly, isLoading: false };
          return updated;
        }
        return [...prev, { id: `run-${runId}`, role: 'assistant' as const, content: friendly, timestamp: new Date(), isLoading: false }];
      });
    } else if (state === 'aborted') {
      currentRunId.current = null;
      setIsSending(false);
      setProgress('');
      setMessages(prev => {
        const idx = prev.findIndex(m => m.id === `run-${runId}`);
        if (idx >= 0) {
          const updated = [...prev];
          updated[idx] = { ...updated[idx], content: updated[idx].content + '\n\n[중단됨]', isLoading: false };
          return updated;
        }
        return prev;
      });
    }
  };

  handlersRef.current.onAgentEvent = (payload: Record<string, unknown>) => {
    const stream = payload.stream as string;
    const data = payload.data as Record<string, unknown> | undefined;
    if (stream !== 'tool' || !data) return;

    const phase = data.phase as string;
    const toolName = data.toolName as string || data.name as string || '';
    const runId = payload.runId as string;

    // 내부 도구는 카드에서 제외 (위임 뱃지로 대체 표시)
    const HIDDEN_TOOLS = new Set(['sessions_spawn', 'sessions_yield', 'sessions_continue', 'sessions_complete', 'sessions_resume']);


    if (phase === 'start') {
      const cmd = JSON.stringify(data.args || data.input || {});
      const stage = /build_draft/.test(cmd) ? '자료를 모으는 중입니다'
        : /polish/.test(cmd) ? '항목을 다듬는 중입니다'
        : /finish/.test(cmd) ? '초안을 정리하는 중입니다'
        : /send_report/.test(cmd) ? '메일을 준비하는 중입니다'
        : '';
      if (stage) setProgress(stage);
    }

    // 일반 도구 호출 표시 (내부 도구 제외)
    if (toolName && !HIDDEN_TOOLS.has(toolName) && phase === 'start') {
      const input = data.input as Record<string, unknown> | undefined;
      const args = data.args as Record<string, unknown> | undefined;
      const toolId = data.toolUseId as string || `tool-${runId}-${toolName}-${Date.now()}`;
      const argsStr = JSON.stringify(args || input || {}).slice(0, 200);
      const msgId = `toolcall-${toolId}`;
      setMessages(prev => {
        if (prev.some(m => m.id === msgId)) return prev;
        return [...prev, {
          id: msgId,
          role: 'system' as const,
          content: `🔧 **${toolName}** 실행 중...`,
          timestamp: new Date(),
          isLoading: true,
          toolCalls: [{ id: toolId, name: toolName, status: 'running', args: argsStr }],
        }];
      });
    } else if (phase === 'end' && !HIDDEN_TOOLS.has(toolName)) {
      const toolUseId = data.toolUseId as string || '';
      setMessages(prev => {
        // Match by toolUseId first, then by toolName, then any running tool
        let idx = -1;
        if (toolUseId) {
          idx = prev.findIndex(m => m.id === `toolcall-${toolUseId}`);
        }
        if (idx < 0 && toolName) {
          idx = prev.findIndex(m => m.id.startsWith('toolcall-') && m.toolCalls?.[0]?.name === toolName && m.isLoading);
        }
        if (idx < 0) {
          // Fallback: find the most recent running tool call
          for (let i = prev.length - 1; i >= 0; i--) {
            if (prev[i].id.startsWith('toolcall-') && prev[i].isLoading) { idx = i; break; }
          }
        }
        if (idx >= 0) {
          const updated = [...prev];
          const name = updated[idx].toolCalls?.[0]?.name || toolName || 'tool';
          const elapsed = Date.now() - updated[idx].timestamp.getTime();
          updated[idx] = {
            ...updated[idx],
            content: `✅ **${name}** 완료`,
            isLoading: false,
            toolCalls: [{ ...updated[idx].toolCalls![0], status: 'completed', duration: elapsed }],
          };
          return updated;
        }
        return prev;
      });
    }

    if (toolName === 'sessions_spawn' && phase === 'start') {
      const input = data.input as Record<string, unknown> | undefined;
      const args = data.args as Record<string, unknown> | undefined;
      const agentId = args?.agentId as string
        || input?.agentId as string
        || data.targetAgentId as string
        || data.agentId as string
        || '서브에이전트';
      // 현재 메인 에이전트(부모) 추정
      const sourceSession = sessions.find(s => s.sessionKey === currentSession);
      const sourceAgentId = sourceSession?.agentId || agents.find(a => a.default)?.id;
      const sourceAgent = agents.find(a => a.id === sourceAgentId);
      const sourceDisplay = sourceAgent ? `${sourceAgent.emoji || '🤖'} ${sourceAgent.name}` : '🤖 비서';

      const targetAgent = agents.find(a => a.id === agentId);
      const targetDisplay = targetAgent ? `${targetAgent.emoji || '🤖'} ${targetAgent.name}` : agentId;

      const task = args?.task as string || input?.task as string || '';
      const preview = task.length > 60 ? task.slice(0, 60) + '...' : task;
      const msgId = `tool-${runId}-${agentId}`;
      const workingMsgId = `working-${runId}-${agentId}`;
      setMessages(prev => {
        const exists = prev.some(m => m.id === msgId);
        const workingExists = prev.some(m => m.id === workingMsgId);
        const additions: typeof prev = [];
        if (!exists) {
          additions.push({
            id: msgId,
            role: 'system' as const,
            content: preview
              ? `${sourceDisplay} → ${targetDisplay}에게 위임 (${preview})`
              : `${sourceDisplay} → ${targetDisplay}에게 위임`,
            timestamp: new Date(),
            isLoading: false,
          });
        }
        if (!workingExists) {
          additions.push({
            id: workingMsgId,
            role: 'system' as const,
            content: `⚙️ ${targetDisplay} 작업 중`,
            timestamp: new Date(),
            isLoading: true,
          });
        }
        return additions.length > 0 ? [...prev, ...additions] : prev;
      });
    }
    // sessions_spawn end는 즉시 발생하므로 무시.
    // working 카드 제거는 subagent의 final 이벤트와 parent final에서 처리.
  };

  // Stable frame handler — uses ref, never changes
  const handleFrame = useCallback((frame: ProtocolFrame) => {
    switch (frame.type) {
      case 'res': {
        const handler = pendingRequests.current.get(frame.id);
        if (handler) {
          pendingRequests.current.delete(frame.id);
          handler(frame);
        }
        break;
      }
      case 'event': {
        const ef = frame as { event: string; payload: Record<string, unknown> };
        switch (ef.event) {
          case 'connect.challenge':
            handlersRef.current.onChallenge((ef.payload as { nonce: string }).nonce);
            break;
          case 'chat':
            handlersRef.current.onChatEvent(ef.payload);
            break;
          case 'agent':
            handlersRef.current.onAgentEvent(ef.payload);
            break;
          case 'tick':
            setConnectionStatus(prev => ({ ...prev, lastPing: new Date() }));
            break;
          case 'shutdown':
            setConnectionStatus({ connected: false, health: 'error' });
            break;
        }
        break;
      }
    }
  }, []); // no deps — stable forever

  // Connect — also stable, only depends on handleFrame (which is stable)
  const connectRef = useRef<() => void>(() => {});
  connectRef.current = () => {
    if (!url || !token) return;
    if (ws.current?.readyState === WebSocket.OPEN || ws.current?.readyState === WebSocket.CONNECTING) return;

    authenticated.current = false;
    setConnectionStatus({ connected: false, health: 'connecting' });

    try {
      ws.current = new WebSocket(url);
      ws.current.onopen = () => console.log('WebSocket connected, waiting for challenge...');
      ws.current.onmessage = (event) => {
        try {
          handleFrame(JSON.parse(event.data) as ProtocolFrame);
        } catch (err) {
          console.error('Failed to parse WebSocket frame:', err);
        }
      };
      ws.current.onclose = () => {
        authenticated.current = false;
        setConnectionStatus({ connected: false, health: 'error' });
        pendingRequests.current.clear();
        reconnectTimeout.current = setTimeout(() => connectRef.current(), 3000);
      };
      ws.current.onerror = (err) => console.error('WebSocket error:', err);
    } catch (err) {
      console.error('WebSocket connection failed:', err);
      setConnectionStatus({ connected: false, health: 'error' });
      reconnectTimeout.current = setTimeout(() => connectRef.current(), 3000);
    }
  };

  // Convert File to base64 data URL
  const fileToBase64 = (file: File): Promise<string> => {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as string);
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
  };

  /* 프론트에서 assistant 메시지를 직접 채팅에 삽입 (LLM 우회).
     세션 없으면 새로 만들고 활성화. QuickActions "지난 주 보고서" 같은 결정론적 응답에 사용. */
  const injectAssistantMessage = useCallback((content: string) => {
    let activeSessionKey = currentSession;
    if (!activeSessionKey) {
      const fallbackAgentId = (typeof window !== 'undefined' ? window.location.pathname.match(/^\/chat\/([^/]+)/)?.[1] : null) || null;
      if (fallbackAgentId) {
        activeSessionKey = `agent:${fallbackAgentId}:${generateId().slice(0, 8)}`;
        setCurrentSession(activeSessionKey);
      }
    }
    const assistantMsg: Message = {
      id: `msg-${++messageIdCounter.current}`,
      role: 'assistant',
      content,
      timestamp: new Date(),
    };
    setMessages(prev => [...prev.filter(m => !m.id.startsWith('working-')), assistantMsg]);
  }, [currentSession]);

  // Send chat message
  const sendMessage = useCallback(async (contentRaw: string, attachments?: File[]) => {
    /* 담당 에이전트가 문장에서 드러나면 **그 에이전트와의 대화로 전환**한다.
       비서에게 맡기면 위임 결과를 자기 말로 다시 써서 카드가 사라지고(실측),
       멘션으로 보내면 임시 세션이라 이력이 남지 않는다(서버에 안 쌓이고 사이드바에서도 숨겨진다).
       `@` 를 직접 친 경우는 원래 의도대로 '잠깐 물어보기'(임시 세션)로 둔다. */
    const content = contentRaw;
    const autoAgent = resolveAgentFor(contentRaw, agentsRef.current);
    // @멘션 파싱: 메시지 맨 앞 @<agentId> 감지
    const mentionMatch = content.match(/^@([a-zA-Z0-9_-]+)\s+([\s\S]*)$/);
    let mentionTargetId: string | null = null;
    let mentionRest = '';
    if (mentionMatch) {
      const candidateId = mentionMatch[1];
      const candidate = agentsRef.current.find(a => a.id === candidateId && !a.id.endsWith('-discord'));
      if (candidate) {
        mentionTargetId = candidate.id;
        mentionRest = mentionMatch[2].trim();
      }
    }

    const idempotencyKey = generateId();
    // ChatGPT 방식: currentSession 없으면 selectedAgent 기반으로 새 세션 키를 즉시 생성하고 set
    let activeSessionKey = currentSession;
    /* 자동 라우팅: 지금 대화가 그 담당이 아니면 담당과의 새 대화로 옮긴다.
       이미 그 담당과 이야기 중이면 그대로 이어간다. */
    if (autoAgent && !mentionTargetId) {
      const cur = String(activeSessionKey || '');
      if (!cur.startsWith(`agent:${autoAgent.id}:`)) {
        activeSessionKey = `agent:${autoAgent.id}:${generateId().slice(0, 8)}`;
        setCurrentSession(activeSessionKey);
        /* 대화가 담당에게 넘어간 것을 눈에 보이게 남긴다.
           아무 표시 없이 화면만 바뀌면 사용자는 무슨 일이 일어났는지 알 수 없다. */
        setMessages(prev => [...prev, {
          id: `route-${idempotencyKey}`,
          role: 'system' as const,
          content: `${autoAgent.emoji || '↳'} ${autoAgent.name}가 이어받았습니다`,
          timestamp: new Date(),
        }]);
      }
    }

    if (!activeSessionKey) {
      // 첫 메시지 발신 시 — selectedAgent의 id 기반 새 세션 자동 생성
      // (selectedAgent는 외부 prop이므로 fallback으로 'main' 유지)
      const fallbackAgentId = (typeof window !== 'undefined' ? window.location.pathname.match(/^\/chat\/([^/]+)/)?.[1] : null) || null;
      if (fallbackAgentId) {
        activeSessionKey = `agent:${fallbackAgentId}:${generateId().slice(0, 8)}`;
        setCurrentSession(activeSessionKey);
      }
    }
    const parentSessionKey = activeSessionKey || 'main';
    let sessionKey = parentSessionKey;
    if (mentionTargetId) {
      // 별도 mention sessionKey 생성
      sessionKey = `agent:${mentionTargetId}:mention-${generateId().slice(0, 8)}`;
      mentionSessionKeys.current.set(sessionKey, mentionTargetId);
      mentionParentByKey.current.set(sessionKey, parentSessionKey);
    }

    // Build attachments array for images + extract text from documents
    const apiAttachments: Array<{ type: string; mimeType: string; content: string }> = [];
    const fileTexts: string[] = [];
    const fileLabels: string[] = [];

    if (attachments && attachments.length > 0) {
      for (const file of attachments) {
        if (file.type.startsWith('image/')) {
          try {
            const dataUrl = await fileToBase64(file);
            const [header, data] = dataUrl.split(',');
            const mimeType = header.match(/:(.*?);/)?.[1] || 'image/png';
            apiAttachments.push({ type: 'image', mimeType, content: data });
            fileLabels.push(`[이미지: ${file.name}]`);
          } catch (err) {
            console.error('Failed to read image:', err);
          }
        } else {
          // Document files → upload to API for text extraction
          try {
            const dataUrl = await fileToBase64(file);
            const base64Data = dataUrl.split(',')[1];
            const userNN = tokenRef.current.replace('tc-user', '');
            const resp = await fetch('/api/file/upload', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ userNN, fileName: file.name, mimeType: file.type, content: base64Data }),
            });
            const result = await resp.json();
            if (result.ok && result.content) {
              fileTexts.push(`[파일: ${file.name}]\n${result.content}`);
            } else {
              fileTexts.push(`[파일: ${file.name}] 텍스트 추출 실패: ${result.error || '알 수 없는 오류'}`);
            }
            fileLabels.push(`[파일: ${file.name}]`);
          } catch (err) {
            console.error('Failed to upload file:', err);
            fileLabels.push(`[파일: ${file.name} - 업로드 실패]`);
          }
        }
      }
    }

    // Build final message with file contents
    let finalMessage = mentionTargetId ? mentionRest : (content || '');
    if (fileTexts.length > 0) {
      finalMessage = (finalMessage ? finalMessage + '\n\n' : '') + fileTexts.join('\n\n');
    }

    // 멘션인 경우: 현재 채팅의 직전 assistant 응답을 컨텍스트로 prepend
    if (mentionTargetId) {
      const lastAssistant = [...messages].reverse().find(m => m.role === 'assistant' && !m.isLoading && m.content);
      const sourceAgent = agentsRef.current.find(a => {
        const cur = sessions.find(s => s.sessionKey === currentSession);
        return cur ? a.id === cur.agentId : a.default;
      });
      const sourceName = sourceAgent?.name || '현재 에이전트';
      if (lastAssistant) {
        finalMessage = `다른 에이전트("${sourceName}")와 사용자가 대화 중이며, 사용자가 당신의 의견을 요청했습니다.\n\n${sourceName}의 직전 응답:\n"""\n${lastAssistant.content}\n"""\n\n사용자 요청: ${finalMessage}`;
      } else {
        finalMessage = `다른 에이전트("${sourceName}")의 세션에서 사용자가 당신을 호출했습니다.\n\n사용자 요청: ${finalMessage}`;
      }
    }

    // Display user message (멘션 원본 content 유지 — 사용자가 입력한 그대로)
    const displayContent = fileLabels.length > 0
      ? `${fileLabels.join(' ')}${content ? '\n' + content : ''}`
      : content;

    const userMsg: Message = {
      id: `msg-${++messageIdCounter.current}`,
      role: 'user',
      content: displayContent,
      timestamp: new Date(),
      mentionAgentId: mentionTargetId || undefined,
    };
    setMessages(prev => [...prev.filter(m => !m.id.startsWith('working-')), userMsg]);
    // 멘션인 경우 부모 세션 로그에 사용자 메시지 저장
    if (mentionTargetId) {
      appendMentionLog(parentSessionKey, {
        id: userMsg.id,
        role: 'user',
        content: displayContent,
        ts: userMsg.timestamp.getTime(),
        mentionAgentId: mentionTargetId,
      });
    }
    setIsSending(true);
    if (!mentionTargetId) {
      mainRunId.current = null;
      knownRunIds.current.clear();
    }

    // Send message with attachments parameter (not in message field)
    /* 보고 담당에게 보낼 때는 마무리 지시를 함께 싣는다.
       두레이는 데몬이 같은 지시를 붙여 카드가 잘 나오는데, 웹은 그게 없어
       모델이 마지막 단계(카드 출력)를 자주 건너뛰었다(실측). 화면에서는 숨긴다. */
    const routedId = autoAgent?.id || mentionTargetId;
    /* ⚠ 업무보고에만 붙인다. 사업 주간보고에는 finish.py 가 없어서
       없는 파일을 찾느라 오히려 헤맨다(스크립트: weekly_report/sr_fetch/hwpx_gen). */
    lastWasConfirm.current = isConfirmRequest(finalMessage);
    if (routedId === 'work-report' && !lastWasConfirm.current) {
      finalMessage = `${finalMessage}\n\n${FINISH_HINT}`;
    }

    const messagePayload: Record<string, unknown> = { sessionKey, message: finalMessage || '', idempotencyKey };
    if (apiAttachments.length > 0) {
      messagePayload.attachments = apiAttachments;
    }

    sendRequest('chat.send', messagePayload)
      .then((res) => {
        const payload = (res as { payload?: Record<string, unknown> }).payload;
        if (payload?.status === 'started') {
          setApiCallCount(prev => prev + 1);
          const rid = payload.runId as string;
          if (rid) {
            mainRunId.current = rid;
            knownRunIds.current.add(rid);
          }
        }
      })
      .catch((err) => {
        console.error('chat.send failed:', err);
        if (mentionTargetId) {
          mentionSessionKeys.current.delete(sessionKey);
        }
        setMessages(prev => [...prev, {
          id: `err-${++messageIdCounter.current}`,
          role: 'system',
          content: `메시지 전송 실패: ${err.message}`,
          timestamp: new Date(),
        }]);
      });
  }, [currentSession, sendRequest, messages, sessions]);

  const createSession = useCallback((agentId?: string) => {
    lastMentionAgentRef.current = null;   // 대화가 바뀌면 이어가기도 끊는다
    const agent = agentId || 'main';
    const label = generateId().slice(0, 8);
    const newKey = `agent:${agent}:${label}`;
    setCurrentSession(newKey);
    setMessages([]);
  }, []);

  // ChatGPT 방식: 빈 시작 화면으로 진입 (currentSession 비움, 메시지 비움)
  const clearSession = useCallback(() => {
    lastMentionAgentRef.current = null;   // 대화가 바뀌면 이어가기도 끊는다
    setCurrentSession(null);
    setMessages([]);
  }, []);

  const switchSession = useCallback((sessionKey: string) => {
    lastMentionAgentRef.current = null;   // 대화가 바뀌면 이어가기도 끊는다
    setCurrentSession(sessionKey);
    sendRequest('chat.history', { sessionKey, limit: 200 })
      .then((res) => {
        const payload = (res as { payload?: Record<string, unknown> }).payload;
        {
          const historyMessages = ((payload?.messages || []) as Array<{
            role: string;
            content: Array<{ type: string; text?: string }> | string;
            timestamp?: number;
          }>).map((m, idx) => {
            let text = '';
            if (typeof m.content === 'string') text = m.content;
            else if (Array.isArray(m.content)) text = m.content.filter(b => b.type === 'text' && b.text).map(b => b.text).join('');
            return {
              id: `hist-${idx}`,
              role: m.role as 'user' | 'assistant' | 'system',
              content: text,
              timestamp: m.timestamp ? new Date(m.timestamp) : new Date(),
            };
          }).filter(m => {
            // history 추가 정리: 서브에이전트/runtime 메타 노이즈는 user/assistant 무관 hide
            const c = m.content.trim();
            if (c.includes('<<<')) return false;
            if (c.includes('subagent task')) return false;
            if (c.includes('session_key: agent:')) return false;
            if (c.includes('Action:') && c.includes('subagent')) return false;
            if (c.includes('Stats: runtime') && c.includes('tokens')) return false;
            if (/^[d-]rwx/.test(c)) return false;
            if (c.includes('Command still running') && c.includes('pid')) return false;
            // 공통 필터 통과
            return !shouldHideMessage(m.role, m.content);
          });
          // localStorage 멘션 로그 병합 (타임스탬프 순)
          const mentionLog = readMentionLog(sessionKey);
          const mentionMsgs: Message[] = mentionLog.map((e, i) => ({
            id: `mention-hist-${i}-${e.id}`,
            role: e.role,
            content: e.content,
            timestamp: new Date(e.ts),
            mentionAgentId: e.mentionAgentId,
          }));
          const merged = [...historyMessages, ...mentionMsgs].sort(
            (a, b) => a.timestamp.getTime() - b.timestamp.getTime()
          );
          setMessages(merged);
          /* 초안 카드는 기록에서 잘려 온다 — 게이트웨이가 메시지 하나를 8,000자로 자르는데
             카드 JSON 은 9~23KB 다. 잘린 JSON 은 파싱이 안 돼 카드가 사라진다(실측:
             페이지를 나갔다 오면 없어짐). 카드가 있던 자리면 초안을 다시 받아 그린다. */
          if (/^agent:work-report:/.test(sessionKey)
              && merged.some(m => (m.content || '').includes('```work-draft'))) {
            fetch(`/api/work-report/draft${draftQuery()}`, { credentials: 'include' })
              .then(r => r.json())
              .then(j => {
                if (!j?.ok || !j.draft) return;
                const body = '```work-draft\n' + JSON.stringify(j.draft, null, 2) + '\n```';
                setMessages(prev => prev.some(m => m.id === 'draft-history') ? prev : [...prev, {
                  id: 'draft-history',
                  role: 'toolResult' as const,
                  content: body,
                  timestamp: merged[merged.length - 1]?.timestamp || new Date(),
                }]);
              })
              .catch(() => { /* 초안이 없으면 그냥 안 그린다 */ });
          }
        }
      })
      .catch(err => console.error('chat.history failed:', err));
  }, [sendRequest]);

  const deleteSession = useCallback(async (sessionKey: string) => {
    try {
      await sendRequest('sessions.delete', { key: sessionKey, deleteTranscript: true });
      // 멘션 로그도 함께 제거
      try { localStorage.removeItem(`mention-log:${tokenRef.current}:${sessionKey}`); } catch {}
      // If deleting the current session, clear messages and reset
      if (sessionKey === currentSession) {
        setCurrentSession(null);
        setMessages([]);
      }
      fetchSessions();
    } catch (err) {
      console.error('sessions.delete failed:', err);
    }
  }, [sendRequest, currentSession, fetchSessions]);

  const stopChat = useCallback(async () => {
    // 현재 세션 abort
    const sessionKey = currentSession || 'main';
    const runId = currentRunId.current;
    sendRequest('chat.abort', runId ? { sessionKey, runId } : { sessionKey })
      .catch(err => console.error('chat.abort failed:', err));

    // 모든 활성 세션도 abort (서브에이전트 포함)
    try {
      const res = await sendRequest('sessions.list', { limit: 50, activeMinutes: 5 });
      const payload = (res as { payload?: Record<string, unknown> }).payload;
      const allSessions = (payload?.sessions || []) as Array<{ key: string }>;
      for (const s of allSessions) {
        if (s.key !== sessionKey) {
          sendRequest('chat.abort', { sessionKey: s.key }).catch(() => {});
        }
      }
    } catch { /* ignore */ }
  }, [currentSession, sendRequest]);

  const isLoading = isSending || messages.some(m => m.isLoading);

  const loadSessionHistory = switchSession;

  // Connect on mount, reconnect only when url/token actually change
  useEffect(() => {
    if (!url || !token) return;

    connectRef.current();

    return () => {
      if (reconnectTimeout.current) clearTimeout(reconnectTimeout.current);
      authenticated.current = false;
      pendingRequests.current.clear();
      ws.current?.close();
      ws.current = null;
    };
  }, [url, token]); // only url and token — no callback deps

  return {
    connectionStatus,
    messages,
    sendMessage,
    injectAssistantMessage,
    agents,
    sessions,
    currentSession,
    createSession,
    switchSession,
    clearSession,
    loadSessionHistory,
    deleteSession,
    stopChat,
    isLoading,
    progress,
    apiCallCount,
    sendRequest,
    fetchAgents,
    fetchSessions,
  };
}
