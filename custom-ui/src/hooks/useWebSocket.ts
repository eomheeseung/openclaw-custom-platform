import { useState, useEffect, useRef, useCallback } from 'react';
import type { Message, ConnectionStatus, Agent, Session, ProtocolFrame } from '../types';

interface UseWebSocketProps {
  url: string;
  token: string;
}

interface UseWebSocketReturn {
  connectionStatus: ConnectionStatus;
  messages: Message[];
  sendMessage: (content: string) => void;
  agents: Agent[];
  sessions: Session[];
  currentSession: string | null;
  createSession: (agentId?: string) => void;
  switchSession: (sessionKey: string) => void;
  loadSessionHistory: (sessionKey: string) => void;
  deleteSession: (sessionKey: string) => Promise<void>;
  stopChat: () => void;
  isLoading: boolean;
  apiCallCount: number;
  sendRequest: (method: string, params?: Record<string, unknown>) => Promise<ProtocolFrame>;
  fetchAgents: () => Promise<void>;
  fetchSessions: () => Promise<void>;
}

function generateId(): string {
  return crypto.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export function useWebSocket({ url, token }: UseWebSocketProps): UseWebSocketReturn {
  const ws = useRef<WebSocket | null>(null);
  const [connectionStatus, setConnectionStatus] = useState<ConnectionStatus>({
    connected: false,
    health: 'connecting',
  });
  const [messages, setMessages] = useState<Message[]>([]);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [currentSession, setCurrentSession] = useState<string | null>(null);
  const [apiCallCount, setApiCallCount] = useState(0);
  const [isSending, setIsSending] = useState(false);

  const reconnectTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);
  const messageIdCounter = useRef(0);
  const authenticated = useRef(false);
  const pendingRequests = useRef<Map<string, (frame: ProtocolFrame) => void>>(new Map());
  const currentRunId = useRef<string | null>(null);
  const mainRunId = useRef<string | null>(null); // chat.send에서 시작된 메인 runId
  const knownRunIds = useRef<Set<string>>(new Set()); // 메인 세션의 runId 목록
  const subagentReturned = useRef<boolean>(false); // 서브에이전트 종료 → 비서로 전달된 상태
  const tokenRef = useRef(token);
  tokenRef.current = token;

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
        };
      });
      setAgents(agentList);
    } catch (err) {
      console.error('Failed to fetch agents:', err);
    }
  }, [sendRequest]);

  const fetchSessions = useCallback(async () => {
    try {
      const res = await sendRequest('sessions.list', {
        limit: 50,
        activeMinutes: 1440,
        includeLastMessage: true,
        includeDerivedTitles: true,
      });
      const payload = (res as { payload?: Record<string, unknown> }).payload;
      if (payload?.sessions) {
        const sessionList = (payload.sessions as Array<{
          key: string;
          agentId?: string;
          label?: string;
          lastMessageAt?: number;
          messageCount?: number;
          derivedTitle?: string;
        }>).map(s => {
          // 세션 이름 정리: derivedTitle > 정리된 label > 날짜 fallback
          // 노이즈 라벨 판별 (사용자에게 보이면 안 되는 패턴)
          const isNoise = (s: string) => !s
            || s.includes('untrusted')
            || s.includes('Sender')
            || s.includes('metadata')
            || s.startsWith('[파일:')
            || /^[a-zA-Z0-9_-]{6,16}(\s*\(.*\))?$/i.test(s);

          const rawLabel = (s.label || '').trim();
          const dt = s.derivedTitle || '';
          // localStorage에서 첫 사용자 메시지 캐시 조회
          let cachedTitle = '';
          try { cachedTitle = localStorage.getItem(`session-title:${s.key}`) || ''; } catch {}
          const fmtDate = (ts?: number) => {
            const d = ts ? new Date(ts) : new Date();
            return `${d.getMonth() + 1}월 ${d.getDate()}일 ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
          };

          let displayLabel = '';
          if (cachedTitle) {
            displayLabel = cachedTitle;
          } else if (dt && !isNoise(dt)) {
            displayLabel = dt;
          } else if (!isNoise(rawLabel)) {
            displayLabel = rawLabel;
          } else {
            // 무조건 날짜 fallback
            displayLabel = `${fmtDate(s.lastMessageAt)} 대화`;
          }
          return {
            sessionKey: s.key,
            agentId: s.agentId,
            label: displayLabel,
            lastMessageAt: s.lastMessageAt ? new Date(s.lastMessageAt).toISOString() : undefined,
            messageCount: s.messageCount,
            derivedTitle: s.derivedTitle,
          };
        });
        setSessions(sessionList);
      }
    } catch (err) {
      console.error('Failed to fetch sessions:', err);
    }
  }, [sendRequest]);

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
      if (evtSessionKey && currentSession && evtSessionKey !== currentSession) {
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
        return [...cleared, { id: `run-${runId}`, role: 'assistant' as const, content: text, timestamp: new Date(), isLoading: true }];
      });
    } else if (state === 'final') {
      // 서브에이전트 final은 메인 채팅에 표시 안 함 (sessionKey 우선)
      const evtSessionKey = payload.sessionKey as string | undefined;
      const isSubagent = (evtSessionKey && currentSession && evtSessionKey !== currentSession)
        || (!evtSessionKey && mainRunId.current && !knownRunIds.current.has(runId));
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
          updated[idx] = { ...updated[idx], content: text, isLoading: false };
          return updated;
        }
        return [...updated, { id: `run-${runId}`, role: 'assistant' as const, content: text, timestamp: new Date(), isLoading: false }];
      });
      fetchSessions();
    } else if (state === 'error') {
      currentRunId.current = null;
      setIsSending(false);
      const errorMessage = (payload.errorMessage as string) || 'An error occurred';
      setMessages(prev => {
        const idx = prev.findIndex(m => m.id === `run-${runId}`);
        if (idx >= 0) {
          const updated = [...prev];
          updated[idx] = { ...updated[idx], content: `오류: ${errorMessage}`, isLoading: false };
          return updated;
        }
        return [...prev, { id: `run-${runId}`, role: 'assistant' as const, content: `오류: ${errorMessage}`, timestamp: new Date(), isLoading: false }];
      });
    } else if (state === 'aborted') {
      currentRunId.current = null;
      setIsSending(false);
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

  // Send chat message
  const sendMessage = useCallback(async (content: string, attachments?: File[]) => {
    const sessionKey = currentSession || 'main';
    const idempotencyKey = generateId();

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
    let finalMessage = content || '';
    if (fileTexts.length > 0) {
      finalMessage = (finalMessage ? finalMessage + '\n\n' : '') + fileTexts.join('\n\n');
    }

    // Display user message
    const displayContent = fileLabels.length > 0
      ? `${fileLabels.join(' ')}${content ? '\n' + content : ''}`
      : content;

    const userMsg: Message = {
      id: `msg-${++messageIdCounter.current}`,
      role: 'user',
      content: displayContent,
      timestamp: new Date(),
    };
    setMessages(prev => {
      // 첫 사용자 메시지면 sessionKey의 title로 localStorage에 저장
      const hasUserMsg = prev.some(m => m.role === 'user');
      if (!hasUserMsg && content.trim()) {
        try {
          const titleKey = `session-title:${tokenRef.current}:${sessionKey}`;
          if (!localStorage.getItem(titleKey)) {
            const title = content.trim().slice(0, 40);
            localStorage.setItem(titleKey, title);
          }
        } catch {}
      }
      return [...prev.filter(m => !m.id.startsWith('working-')), userMsg];
    });
    setIsSending(true);
    mainRunId.current = null;
    knownRunIds.current.clear();

    // Send message with attachments parameter (not in message field)
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
        setMessages(prev => [...prev, {
          id: `err-${++messageIdCounter.current}`,
          role: 'system',
          content: `메시지 전송 실패: ${err.message}`,
          timestamp: new Date(),
        }]);
      });
  }, [currentSession, sendRequest]);

  const createSession = useCallback((agentId?: string) => {
    const agent = agentId || 'main';
    const label = generateId().slice(0, 8);
    const newKey = `agent:${agent}:${label}`;
    setCurrentSession(newKey);
    setMessages([]);
  }, []);

  const switchSession = useCallback((sessionKey: string) => {
    setCurrentSession(sessionKey);
    sendRequest('chat.history', { sessionKey, limit: 200 })
      .then((res) => {
        const payload = (res as { payload?: Record<string, unknown> }).payload;
        if (payload?.messages) {
          const historyMessages = (payload.messages as Array<{
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
            const c = m.content.trim();
            // 내부 메시지 숨기기 — role 관계없이 먼저 체크
            if (c.includes('OpenClaw runtime context')) return false;
            if (c.includes('BEGIN_UNTRUSTED_CHILD_RESULT')) return false;
            if (c.includes('END_UNTRUSTED_CHILD_RESULT')) return false;
            if (c.includes('[Internal task completion event]')) return false;
            if (c.includes('runtime-generated, not user-authored')) return false;
            if (c.includes('<<<')) return false;
            if (c.includes('Sender (untrusted metadata)')) return false;
            if (c.includes('subagent task')) return false;
            if (c.includes('session_key: agent:')) return false;
            if (c.includes('Action:') && c.includes('subagent')) return false;
            if (c.includes('Stats: runtime') && c.includes('tokens')) return false;
            // user role은 내부 메시지 아니면 항상 표시
            if (m.role === 'user') return true;
            if (c.includes('---\nname:')) return false;
            if (c.includes('Weather report')) return false;
            // JSON raw 응답
            if (c.startsWith('{') && (c.includes('"ok"') || c.includes('"status"') || c.includes('"error"') || c.includes('"account"') || c.includes('"events"') || c.includes('"files"') || c.includes('"drives"') || c.includes('"messages"') || c.includes('"content"') || c.includes('"results"') || c.includes('"provider"') || c.includes('"score"'))) return false;
            // memory/tool 내부 출력
            if (c.includes('Successfully wrote') && c.includes('bytes to')) return false;
            if (c.includes('Source: memory/')) return false;
            if (c.includes('"citation"') && c.includes('"snippet"')) return false;
            // exec 도구 내부 출력
            if (c.startsWith('(') && c.endsWith(')') && (c.includes('Command exited') || c.includes('no output') || c.includes('Command still running'))) return false;
            if (c.includes('Command still running') && c.includes('pid')) return false;
            // 쉘 명령어 출력 (tc-user, ls 출력, 파일 목록 등)
            if (/^tc-user\d+$/.test(c)) return false;
            if (/^total \d+/m.test(c) && /[d-]rwx/m.test(c)) return false;
            if (/^[d-]rwx/.test(c)) return false;
            // 빈 메시지
            if (c.length < 2) return false;
            return true;
          });
          setMessages(historyMessages);

          // 첫 사용자 메시지를 localStorage에 캐시 (세션 라벨용)
          try {
            const titleKey = `session-title:${tokenRef.current}:${sessionKey}`;
            if (!localStorage.getItem(titleKey)) {
              const firstUser = historyMessages.find(m => m.role === 'user');
              if (firstUser) {
                // [파일: ...] 라벨 + 본문에서 의미 있는 텍스트만 추출
                const cleanText = firstUser.content
                  .replace(/\[파일:\s*[^\]]+\]\n[\s\S]*?(?=\n\[파일:|$)/g, '[파일]')
                  .trim()
                  .slice(0, 40);
                if (cleanText) localStorage.setItem(titleKey, cleanText);
              }
            }
          } catch {}
        }
      })
      .catch(err => console.error('chat.history failed:', err));
  }, [sendRequest]);

  const deleteSession = useCallback(async (sessionKey: string) => {
    try {
      await sendRequest('sessions.delete', { key: sessionKey, deleteTranscript: true });
      // localStorage에서 세션 라벨 캐시 제거
      try { localStorage.removeItem(`session-title:${tokenRef.current}:${sessionKey}`); } catch {}
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
    agents,
    sessions,
    currentSession,
    createSession,
    switchSession,
    loadSessionHistory,
    deleteSession,
    stopChat,
    isLoading,
    apiCallCount,
    sendRequest,
    fetchAgents,
    fetchSessions,
  };
}
