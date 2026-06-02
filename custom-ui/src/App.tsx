import { useState, useEffect, useCallback, useRef } from 'react';
import { Network, Bot, Clock, HelpCircle, MessageSquare, LayoutDashboard, Link, Search, Pin, ExternalLink, Settings, Monitor, PanelLeftClose, PanelLeftOpen } from 'lucide-react';
import { useWebSocket } from './hooks/useWebSocket';
import { LoginScreen } from './components/LoginScreen';
import { Sidebar } from './components/Sidebar';
import { MessageList } from './components/MessageList';
import { ChatInput } from './components/ChatInput';
import { AgentManager } from './components/AgentManager';
import { CronManager } from './components/CronManager';
import { ChannelManager } from './components/ChannelManager';
import { Dashboard } from './components/Dashboard';
import { AdminPanel } from './components/AdminPanel';
import { HelpModal } from './components/HelpModal';
import { VNCPanel } from './components/VNCPanel';
import { WorkflowView } from './components/WorkflowView';
import { PendingMailBanner } from './components/PendingMailBanner';
import { IntegrationsPage } from './components/IntegrationsPage';
import { BriefHeader } from './components/BriefHeader';
import { QuickActions } from './components/QuickActions';
import { NotificationToast, type ToastItem } from './components/NotificationToast';
import { CommandPalette } from './components/CommandPalette';
import type { Agent, Session, Message } from './types';

type ViewType = 'dashboard' | 'chat' | 'agents' | 'cron' | 'channels' | 'integrations' | 'workflow';

function getGatewayUrl(token: string): string {
  const match = token.match(/user(\d+)/);
  const userNum = match ? parseInt(match[1], 10) : 1;
  return `ws://${window.location.hostname}:${18000 + userNum}`;
}

/* Live clock — updates every second */
function Clock1Sec() {
  const [now, setNow] = useState(new Date());
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(id);
  }, []);
  return <span>{now.toLocaleString('ko-KR', { hour12: true, hour: '2-digit', minute: '2-digit', second: '2-digit' })}</span>;
}

/* ─── Dock icon definitions ─── */
/* dashboard는 라우팅/컴포넌트는 보존하되 dock에서만 제거 — 자비스 컨셉에선 채팅 메인. */
const dockItems: { key: ViewType; icon: string; label: string }[] = [
  { key: 'chat',         icon: '💬', label: '채팅' },
  { key: 'agents',       icon: '🤖', label: '에이전트' },
  { key: 'cron',         icon: '⏰', label: '예약 작업' },
  { key: 'workflow',     icon: '📋', label: '워크플로' },
  { key: 'channels',     icon: '📡', label: '채널 연동' },
  { key: 'integrations', icon: '🔗', label: '외부 연동' },
];

function App() {
  const [token, setToken] = useState<string>('');
  // 1회 마이그레이션: 네임스페이스 없는 옛 키 제거 (이전엔 모든 유저가 공유)
  useEffect(() => {
    try {
      const migrated = localStorage.getItem('tideclaw-ns-migrated-v1');
      if (!migrated) {
        ['tideclaw-current-view', 'tideclaw-workflow-pins', 'tideclaw-workflow-catalog-collapsed', 'tideclaw-activity-log']
          .forEach(k => localStorage.removeItem(k));
        localStorage.setItem('tideclaw-ns-migrated-v1', '1');
      }
    } catch { /* ignore */ }
  }, []);

  const viewStorageKey = (() => {
    const m = (typeof window !== 'undefined' ? new URLSearchParams(window.location.search).get('token') || '' : '').match(/user(\d+)/i);
    const slot = m ? m[1].padStart(2, '0') : 'default';
    return `tideclaw-current-view-${slot}`;
  })();
  const VALID_VIEWS_LIST: ViewType[] = ['dashboard', 'chat', 'agents', 'cron', 'channels', 'integrations', 'workflow'];
  const parseUrlPath = useCallback(() => {
    if (typeof window === 'undefined') return { view: null as ViewType | null, agentId: null as string | null, sessionTail: null as string | null };
    const seg = window.location.pathname.split('/').filter(Boolean);
    if (seg.length === 0 || (seg[0] && seg[0] === 'admin')) return { view: null, agentId: null, sessionTail: null };
    const v = VALID_VIEWS_LIST.includes(seg[0] as ViewType) ? (seg[0] as ViewType) : null;
    if (!v) return { view: null, agentId: null, sessionTail: null };
    return {
      view: v,
      agentId: v === 'chat' && seg[1] ? seg[1] : null,
      sessionTail: v === 'chat' && seg[2] ? seg.slice(2).join('/') : null,
    };
  }, []);

  const [currentView, _setCurrentView] = useState<ViewType>(() => {
    const parsed = (typeof window !== 'undefined') ? (() => {
      const seg = window.location.pathname.split('/').filter(Boolean);
      const valid = ['dashboard', 'chat', 'agents', 'cron', 'channels', 'integrations', 'workflow'];
      if (seg[0] && valid.includes(seg[0])) return seg[0] as ViewType;
      return null;
    })() : null;
    if (parsed) return parsed;
    try {
      const saved = localStorage.getItem(viewStorageKey);
      const valid: ViewType[] = ['dashboard', 'chat', 'agents', 'cron', 'channels', 'integrations', 'workflow'];
      if (saved && valid.includes(saved as ViewType)) {
        /* 옛 사용자가 dashboard 마지막 활성 뷰였으면 chat으로 redirect (dock에서 제거됨) */
        return saved === 'dashboard' ? 'chat' : (saved as ViewType);
      }
    } catch { /* ignore */ }
    return 'chat';
  });
  const setCurrentView = useCallback((v: ViewType) => {
    _setCurrentView(v);
    try { localStorage.setItem(viewStorageKey, v); } catch { /* ignore */ }
    if (typeof window !== 'undefined') {
      const cur = window.location.pathname;
      if (cur.startsWith('/admin')) return;
      const target = `/${v}`;
      if (cur !== target && !cur.startsWith(`${target}/`)) {
        window.history.pushState({}, '', target + window.location.search);
      }
    }
  }, [viewStorageKey]);
  const slotForKey = (() => {
    const m = (typeof window !== 'undefined' ? new URLSearchParams(window.location.search).get('token') || '' : '').match(/user(\d+)/i);
    return m ? m[1].padStart(2, '0') : 'default';
  })();
  const [selectedAgent, _setSelectedAgent] = useState<Agent | null>(null);
  const setSelectedAgent = useCallback((a: Agent | null) => {
    _setSelectedAgent(a);
    try { localStorage.setItem(`tideclaw-selected-agent-${slotForKey}`, a?.id || ''); } catch { /* ignore */ }
  }, [slotForKey]);
  const sessionRestoredRef = useRef(false);
  const [showHelp, setShowHelp] = useState(false);
  const [showVNC, setShowVNC] = useState(false);

  const isTideFloDomain = window.location.hostname === 'claw.tideflo.work';

  useEffect(() => {
    const p = new URLSearchParams(window.location.search);
    const urlToken = p.get('token');

    if (isTideFloDomain) {
      const cookieMatch = document.cookie.match(/gateway_token=([^;]+)/);
      const cookieToken = cookieMatch ? decodeURIComponent(cookieMatch[1]) : '';
      const validToken = cookieToken || urlToken || '';

      if (validToken) {
        const finalToken = cookieToken && urlToken && cookieToken !== urlToken ? cookieToken : validToken;
        setToken(finalToken);
        if (!cookieToken && finalToken) {
          document.cookie = `gateway_token=${encodeURIComponent(finalToken)}; Path=/; Max-Age=86400`;
        }
        const u = new URL(window.location.href);
        u.searchParams.set('token', finalToken);
        window.history.replaceState({}, '', u);
      }
    } else {
      if (urlToken) setToken(urlToken);
    }
  }, [isTideFloDomain]);

  const handleLogin = useCallback((t: string) => {
    setToken(t);
    const u = new URL(window.location.href); u.searchParams.set('token', t);
    window.history.replaceState({}, '', u);
  }, []);

  const handleLogout = useCallback(async () => {
    try { await fetch('/auth/logout', { method: 'POST' }); } catch { /* ignore */ }
    ['session', 'user_email', 'user_name', 'user_nn', 'gateway_token', 'oauth_state'].forEach(name => {
      document.cookie = `${name}=; Path=/; Max-Age=0`;
    });
    setToken('');
    window.location.href = '/';
  }, []);

  const {
    connectionStatus, messages, sendMessage, agents, sessions,
    currentSession, createSession, switchSession, clearSession, loadSessionHistory,
    deleteSession, stopChat, isLoading, apiCallCount, sendRequest, fetchAgents,
  } = useWebSocket({ url: token ? getGatewayUrl(token) : '', token });

  /* ───── Jarvis additions: QuickActions prefill + push toasts ───── */
  const [injectMessage, setInjectMessage] = useState<{ value: string; nonce: number } | null>(null);
  const injectPrefill = useCallback((text: string) => {
    setInjectMessage({ value: text, nonce: Date.now() + Math.floor(Math.random() * 1000) });
  }, []);

  /* 퀵 액션 패널 토글 (대화 중일 때만 의미. 빈 화면은 카드형으로 항상 노출) */
  const [quickActionsOpen, setQuickActionsOpen] = useState(false);

  /* 통합 검색 팔레트 (Cmd+K / Ctrl+K) */
  const [paletteOpen, setPaletteOpen] = useState(false);

  /* 사이드바 collapse 토글 — 고정 폭(256px) 열고 닫기. localStorage 저장. Cmd+B 단축키. */
  const [sidebarOpen, setSidebarOpen] = useState<boolean>(() => {
    try {
      const v = localStorage.getItem('tideclaw-sidebar-open');
      if (v === '0') return false;
    } catch { /* ignore */ }
    return true;
  });
  const toggleSidebar = useCallback(() => {
    setSidebarOpen(v => {
      const next = !v;
      try { localStorage.setItem('tideclaw-sidebar-open', next ? '1' : '0'); } catch { /* ignore */ }
      return next;
    });
  }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && (e.key === 'b' || e.key === 'B')) {
        e.preventDefault();
        toggleSidebar();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [toggleSidebar]);

  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const pushToast = useCallback((t: Omit<ToastItem, 'id' | 'ts'>) => {
    setToasts(prev => [
      ...prev,
      { ...t, id: `toast-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, ts: Date.now() },
    ]);
  }, []);
  const dismissToast = useCallback((id: string) => {
    setToasts(prev => prev.filter(t => t.id !== id));
  }, []);

  /* Cmd+K / Ctrl+K 글로벌 단축키 — 통합 검색 팔레트 */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && (e.key === 'k' || e.key === 'K')) {
        e.preventDefault();
        setPaletteOpen(v => !v);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  /* 멘션된 응답 도착 → 토스트.
     history reload(새로고침/세션 전환)로 옛 mention이 신규처럼 보이는 걸 방지 — 마운트 시간 기준 옛 메시지 + 세션 전환 시 ref reset. */
  const lastSeenMentionRespRef = useRef<string>('');
  const mountedAtRef = useRef<number>(Date.now());
  /* 세션 전환 시 ref 리셋 — 새 세션의 옛 mention 무시 */
  useEffect(() => {
    lastSeenMentionRespRef.current = '';
    mountedAtRef.current = Date.now();
  }, [currentSession]);

  useEffect(() => {
    if (messages.length === 0) return;
    const recentMentions = (messages as Message[])
      .filter(m => m.role === 'assistant' && !m.isLoading && m.mentionAgentId && m.content.trim().length > 0);
    const last = recentMentions[recentMentions.length - 1];
    if (!last) return;
    if (last.id === lastSeenMentionRespRef.current) return;

    /* 첫 트리거(history reload) — ref만 갱신하고 토스트 skip */
    if (lastSeenMentionRespRef.current === '') {
      lastSeenMentionRespRef.current = last.id;
      return;
    }

    /* 마운트 시점보다 3초 이상 전 메시지는 옛것으로 간주 — 토스트 skip */
    const ts = last.timestamp instanceof Date ? last.timestamp.getTime() : 0;
    if (ts && ts < mountedAtRef.current - 3000) {
      lastSeenMentionRespRef.current = last.id;
      return;
    }

    lastSeenMentionRespRef.current = last.id;
    const ag = agents.find(a => a.id === last.mentionAgentId);
    if (!ag) return;
    pushToast({
      kind: 'delegation',
      title: `${ag.emoji || '🤖'} ${ag.name} 응답 도착`,
      body: last.content.slice(0, 140).replace(/\n+/g, ' '),
    });
  }, [messages, agents, pushToast]);
  /* ──────────────────────────────────────────────────────────────── */

  // 에이전트 로드되면 저장된 selectedAgent.id 복원
  useEffect(() => {
    if (selectedAgent || agents.length === 0) return;
    try {
      const savedId = localStorage.getItem(`tideclaw-selected-agent-${slotForKey}`);
      if (savedId) {
        const found = agents.find(a => a.id === savedId);
        if (found) _setSelectedAgent(found);
      }
    } catch { /* ignore */ }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agents]);

  const handleSelectAgent = useCallback((agent: Agent) => {
    // ChatGPT 방식: 에이전트 클릭 시 즉시 세션 만들지 않음 → 빈 시작 화면
    setSelectedAgent(agent);
    setCurrentView('chat');
    clearSession();
    if (typeof window !== 'undefined' && !window.location.pathname.startsWith('/admin')) {
      const target = `/chat/${agent.id}`;
      if (window.location.pathname !== target) {
        window.history.pushState({}, '', target + window.location.search);
      }
    }
  }, [clearSession]);

  const resolveAgentFromSessionKey = useCallback((sessionKey: string | undefined): Agent | null => {
    if (!sessionKey) return null;
    const m = sessionKey.match(/^agent:([^:]+):/);
    if (!m) return null;
    return agents.find(a => a.id === m[1]) || null;
  }, [agents]);

  const sessionKeyToUrl = useCallback((sk: string): { agentId: string; tail: string } | null => {
    const m = sk.match(/^agent:([^:]+):(.+)$/);
    if (!m) return null;
    return { agentId: m[1], tail: m[2] };
  }, []);

  const handleSelectSession = useCallback((session: Session) => {
    const byId = session.agentId ? agents.find(a => a.id === session.agentId) : null;
    const byKey = byId || resolveAgentFromSessionKey(session.sessionKey);
    setSelectedAgent(byKey);
    switchSession(session.sessionKey); setCurrentView('chat');
    if (typeof window !== 'undefined' && !window.location.pathname.startsWith('/admin')) {
      const u = sessionKeyToUrl(session.sessionKey);
      if (u) {
        const target = `/chat/${u.agentId}/${u.tail}`;
        if (window.location.pathname !== target) {
          window.history.pushState({}, '', target + window.location.search);
        }
      }
    }
  }, [agents, switchSession, resolveAgentFromSessionKey, sessionKeyToUrl]);

  // popstate (브라우저 뒤로/앞으로) → view/세션 복원
  useEffect(() => {
    const onPop = () => {
      const p = parseUrlPath();
      if (p.view) _setCurrentView(p.view);
      if (p.view === 'chat' && p.agentId && p.sessionTail === 'main') {
        // main URL은 빈 화면 처리
        if (currentSession) clearSession();
      } else if (p.view === 'chat' && p.agentId && p.sessionTail) {
        const sk = `agent:${p.agentId}:${p.sessionTail}`;
        if (sk !== currentSession) switchSession(sk);
      } else if (p.view === 'chat' && p.agentId && !p.sessionTail) {
        if (currentSession) clearSession();
      }
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, [parseUrlPath, currentSession, switchSession, clearSession]);

  // 첫 로드 시 URL의 sessionKey가 있으면 그 세션 활성화 (sessions 로드된 후)
  // URL이 /chat/<agentId> (sessionTail 없음)이면 빈 시작 화면으로 진입
  useEffect(() => {
    if (sessionRestoredRef.current || sessions.length === 0) return;
    const p = parseUrlPath();
    if (p.view === 'chat' && p.agentId && p.sessionTail === 'main') {
      // ChatGPT 방식: URL이 main 가리키면 빈 시작 화면으로 redirect
      const ag = agents.find(a => a.id === p.agentId);
      if (ag && (!selectedAgent || selectedAgent.id !== ag.id)) setSelectedAgent(ag);
      if (currentSession) clearSession();
      if (typeof window !== 'undefined') {
        window.history.replaceState({}, '', `/chat/${p.agentId}` + window.location.search);
      }
      sessionRestoredRef.current = true;
    } else if (p.view === 'chat' && p.agentId && p.sessionTail) {
      const sk = `agent:${p.agentId}:${p.sessionTail}`;
      if (sessions.find(s => s.sessionKey === sk) && sk !== currentSession) {
        switchSession(sk);
        sessionRestoredRef.current = true;
      }
    } else if (p.view === 'chat' && p.agentId && !p.sessionTail) {
      // /chat/<agentId> 빈 화면 진입: selectedAgent set + currentSession 비움
      const ag = agents.find(a => a.id === p.agentId);
      if (ag && (!selectedAgent || selectedAgent.id !== ag.id)) {
        setSelectedAgent(ag);
      }
      if (currentSession) clearSession();
      sessionRestoredRef.current = true;
    }
  }, [sessions, currentSession, switchSession, parseUrlPath]);

  const handleCreateSession = useCallback(() => { createSession(selectedAgent?.id); }, [createSession, selectedAgent]);

  // ChatGPT 방식: main 세션은 사용자에게 진입점이 아님 — localStorage 저장/복원/URL push 모두 제외
  const isMainKey = (k: string | null) => !!k && /^agent:[^:]+:main$/.test(k);

  // 세션 ID 저장 + URL 동기화 (chat view일 때)
  useEffect(() => {
    try {
      if (currentSession && !isMainKey(currentSession)) {
        localStorage.setItem(`tideclaw-current-session-${slotForKey}`, currentSession);
      }
    } catch { /* ignore */ }
    if (currentSession && !isMainKey(currentSession) && currentView === 'chat' && typeof window !== 'undefined' && !window.location.pathname.startsWith('/admin')) {
      const u = sessionKeyToUrl(currentSession);
      if (u) {
        const target = `/chat/${u.agentId}/${u.tail}`;
        const cur = window.location.pathname;
        if (cur !== target) {
          const urlState = parseUrlPath();
          if (!sessionRestoredRef.current && urlState.view === 'chat' && urlState.agentId && urlState.sessionTail && urlState.sessionTail !== 'main') {
            return;
          }
          window.history.replaceState({}, '', target + window.location.search);
        }
      }
    }
  }, [currentSession, slotForKey, currentView, sessionKeyToUrl, parseUrlPath]);

  // 세션 복원 (sessions 로드되면 1회) — main session은 복원 대상에서 제외
  useEffect(() => {
    if (sessionRestoredRef.current || sessions.length === 0 || currentSession) return;
    try {
      const savedSk = localStorage.getItem(`tideclaw-current-session-${slotForKey}`);
      if (savedSk && !isMainKey(savedSk) && sessions.find(s => s.sessionKey === savedSk)) {
        switchSession(savedSk);
        sessionRestoredRef.current = true;
      }
    } catch { /* ignore */ }
  }, [sessions, currentSession, slotForKey, switchSession]);

  if (!token) return <LoginScreen onLogin={handleLogin} />;

  const currentAgentData = selectedAgent || (currentSession ? (
    agents.find(a => sessions.find(s => s.sessionKey === currentSession)?.agentId === a.id)
    || resolveAgentFromSessionKey(currentSession)
  ) : null);

  const viewLabel = dockItems.find(d => d.key === currentView)?.label || '';

  return (
    <div className="h-screen flex flex-col bg-background" onDragOver={(e) => e.preventDefault()} onDrop={(e) => e.preventDefault()}>

      {/* ═══ TOP BAR ═══ */}
      <header className="h-14 flex items-center justify-between px-4 bg-card border-b border-border-color flex-shrink-0">
        {/* Left: Logo */}
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 rounded-lg bg-accent flex items-center justify-center">
            <svg viewBox="0 0 32 32" fill="none" className="w-5 h-5">
              <path d="M9 16C9 12 12 9 16 9C20 9 23 12 23 16" stroke="white" strokeWidth="2.2" strokeLinecap="round"/>
              <path d="M11.5 18L16 12.5L20.5 18" stroke="white" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"/>
              <circle cx="16" cy="22" r="1.8" fill="white"/>
            </svg>
          </div>
          <span className="text-lg font-bold text-text-primary tracking-tight">
            <span className="text-accent">Tide</span>Claw
          </span>
        </div>

        {/* Center: Breadcrumb */}
        <div className="flex items-center gap-2 text-sm text-text-secondary">
          <span>워크스페이스</span>
          <span className="opacity-30">/</span>
          <span className="text-accent font-semibold">{currentAgentData?.name || viewLabel}</span>
        </div>

        {/* Right: Status + User */}
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-2 text-xs">
            <span className={`w-2 h-2 rounded-full ${connectionStatus.connected ? 'bg-green-500' : 'bg-red-400'}`} />
            <span className={connectionStatus.connected ? 'text-green-600' : 'text-red-500'}>
              {connectionStatus.connected ? '정상 연결' : '연결 끊김'}
            </span>
          </div>
          <button onClick={handleLogout} className="text-xs text-text-secondary hover:text-red-500 transition-colors px-2 py-1 rounded-lg hover:bg-red-500/5">
            로그아웃
          </button>
        </div>
      </header>

      {/* ═══ MAIN GRID: Dock + Sidebar + Content ═══ */}
      <div className="flex-1 flex overflow-hidden">

        {/* ─── LEFT DOCK (icon strip) ─── */}
        <nav className="w-16 flex flex-col items-center py-3 gap-1 bg-card/50 border-r border-border-color flex-shrink-0">
          {/* 사이드바 토글 — dock 맨 위 (Ctrl+B) */}
          <button
            onClick={toggleSidebar}
            className="w-11 h-11 mb-1 rounded-xl flex items-center justify-center text-text-secondary hover:bg-accent/10 hover:text-accent transition-all relative group border-b border-border-color/40"
            title={`사이드바 ${sidebarOpen ? '닫기' : '열기'} (Ctrl+B)`}
          >
            {sidebarOpen
              ? <PanelLeftClose className="w-5 h-5" strokeWidth={2} />
              : <PanelLeftOpen className="w-5 h-5" strokeWidth={2} />}
            <span className="absolute left-full ml-2 px-2 py-1 bg-card border border-border-color text-text-primary text-xs font-medium rounded-lg whitespace-nowrap opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none z-50 shadow-sm">
              {sidebarOpen ? '사이드바 닫기' : '사이드바 열기'} · Ctrl+B
            </span>
          </button>
          {dockItems.map((item) => (
            <button
              key={item.key}
              onClick={() => setCurrentView(item.key)}
              className={`w-11 h-11 rounded-xl flex items-center justify-center text-lg transition-all relative group
                ${currentView === item.key
                  ? 'bg-accent/10 text-accent'
                  : 'text-text-secondary hover:bg-accent/5 hover:text-accent'
                }`}
            >
              {/* Active indicator */}
              {currentView === item.key && (
                <span className="absolute left-0 top-1/2 -translate-y-1/2 w-[3px] h-5 bg-accent rounded-r-full" />
              )}
              <span>{item.icon}</span>
              {/* Tooltip */}
              <span className="absolute left-full ml-2 px-2 py-1 bg-card border border-border-color text-text-primary text-xs font-medium rounded-lg whitespace-nowrap opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none z-50 shadow-sm">
                {item.label}
              </span>
            </button>
          ))}

          {/* Spacer + bottom icons */}
          <div className="flex-1" />
          <div className="w-7 h-px bg-border-color my-2" />
          <button
            onClick={() => setShowVNC(true)}
            className="w-11 h-11 rounded-xl flex items-center justify-center text-text-secondary hover:text-accent hover:bg-accent/5 transition-all relative group"
          >
            <Monitor className="w-5 h-5" />
            <span className="absolute left-full ml-2 px-2 py-1 bg-card border border-border-color text-text-primary text-xs font-medium rounded-lg whitespace-nowrap opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none z-50 shadow-sm">
              원격 데스크톱
            </span>
          </button>
          <button
            onClick={() => setShowHelp(true)}
            className="w-11 h-11 rounded-xl flex items-center justify-center text-text-secondary hover:text-accent hover:bg-accent/5 transition-all relative group"
          >
            <HelpCircle className="w-5 h-5" />
            <span className="absolute left-full ml-2 px-2 py-1 bg-card border border-border-color text-text-primary text-xs font-medium rounded-lg whitespace-nowrap opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none z-50 shadow-sm">
              도움말
            </span>
          </button>
          <button
            className="w-11 h-11 rounded-xl flex items-center justify-center text-text-secondary hover:text-accent hover:bg-accent/5 transition-all relative group"
          >
            <Settings className="w-5 h-5" />
            <span className="absolute left-full ml-2 px-2 py-1 bg-card border border-border-color text-text-primary text-xs font-medium rounded-lg whitespace-nowrap opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none z-50 shadow-sm">
              설정
            </span>
          </button>
        </nav>

        {/* ─── SIDEBAR (agent list + sessions) — 토글 열고 닫기 (256px / 0) ─── */}
        <aside
          className={`flex-shrink-0 flex flex-col bg-card/30 border-r border-border-color overflow-hidden transition-[width] duration-200 ${
            sidebarOpen ? 'w-64 border-r' : 'w-0 border-r-0'
          }`}
        >
          {sidebarOpen && (
            <Sidebar
              agents={agents}
              sessions={sessions}
              currentSession={currentSession}
              onSelectAgent={handleSelectAgent}
              onSelectSession={handleSelectSession}
              onCreateSession={handleCreateSession}
              onDeleteSession={deleteSession}
              currentAgentId={currentAgentData?.id}
            />
          )}
        </aside>

        {/* ─── MAIN CONTENT ─── */}
        <div className="flex-1 flex flex-col min-w-0 overflow-hidden">

          {/* 메일 발송 대기 배너 — 모든 뷰에 노출 */}
          <PendingMailBanner token={token} />

          {/* Chat header — agent 정보 + 오늘 컨텍스트(Brief) 한 줄 통합 */}
          {currentView === 'chat' && currentAgentData && (
            <div className="px-6 py-2.5 flex items-center gap-4 border-b border-border-color bg-card/60 flex-shrink-0 min-w-0">
              {/* 왼쪽: agent 정보 */}
              <div className="flex items-center gap-2.5 flex-shrink-0">
                <span className="text-lg">{currentAgentData.emoji || '🤖'}</span>
                <span className="font-bold text-text-primary text-base">{currentAgentData.name}</span>
                <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-accent/10 text-accent border border-accent/15">
                  {currentAgentData.model || 'AI'}
                </span>
              </div>

              {/* 가운데: Brief 정보 (embedded — 자체 padding/border 없음) */}
              <div className="flex-1 min-w-0 overflow-hidden">
                <BriefHeader
                  embedded
                  agents={agents}
                  messages={messages as Message[]}
                  sendRequest={sendRequest}
                  slot={slotForKey}
                  onCreateAgent={() => setCurrentView('agents')}
                  onQuickPrompt={(text) => { if (currentSession) sendMessage(text); else injectPrefill(text); }}
                />
              </div>

              {/* 오른쪽: 액션 버튼들 */}
              <div className="flex gap-1 flex-shrink-0">
                <button
                  onClick={() => setPaletteOpen(true)}
                  className="h-7 px-2 rounded-lg border border-border-color bg-card flex items-center gap-1 text-text-secondary hover:text-accent hover:border-accent/20 transition-all"
                  title="통합 검색 (에이전트 · 세션 · 메시지 · 페이지)"
                >
                  <Search className="w-3.5 h-3.5" />
                  <kbd className="text-[9px] font-mono opacity-60">⌘K</kbd>
                </button>
                <button className="w-7 h-7 rounded-lg border border-border-color bg-card flex items-center justify-center text-text-secondary hover:text-accent hover:border-accent/20 transition-all" title="고정 (예정)">
                  <Pin className="w-3.5 h-3.5" />
                </button>
                <button className="w-7 h-7 rounded-lg border border-border-color bg-card flex items-center justify-center text-text-secondary hover:text-accent hover:border-accent/20 transition-all" title="내보내기 (예정)">
                  <ExternalLink className="w-3.5 h-3.5" />
                </button>
              </div>
            </div>
          )}

          {/* View content */}
          {currentView === 'dashboard' ? (
            <Dashboard
              sendRequest={sendRequest} agents={agents} sessions={sessions}
              messages={messages} connectionStatus={connectionStatus} apiCallCount={apiCallCount}
              onNavigateToChat={(sk) => { switchSession(sk); setCurrentView('chat'); }}
            />
          ) : currentView === 'chat' ? (
            <>
              {currentSession ? (
                <MessageList messages={messages} agents={agents} />
              ) : (
                <div className="flex-1 flex flex-col items-center justify-center text-center px-6 py-12 text-text-secondary overflow-y-auto">
                  <div className="text-5xl mb-4">{currentAgentData?.emoji || '💬'}</div>
                  <h2 className="text-xl font-semibold text-text-primary mb-2">{currentAgentData?.name || '에이전트'}</h2>
                  <p className="text-sm">메시지를 입력하면 새 대화가 시작됩니다.</p>
                  {/* 빈 화면 시작 가이드: 퀵 액션 카드형 */}
                  <QuickActions
                    variant="card"
                    agents={agents}
                    currentAgentId={currentAgentData?.id}
                    onQuickPrompt={injectPrefill}
                    onPrefillMention={injectPrefill}
                    onCreateAgent={() => setCurrentView('agents')}
                  />
                </div>
              )}
              {/* ⚡ 토글로 inline 칩 펼침 — 빈 채팅이든 대화 중이든 동일 */}
              {quickActionsOpen && (
                <QuickActions
                  variant="inline"
                  agents={agents}
                  currentAgentId={currentAgentData?.id}
                  onQuickPrompt={(text) => {
                    if (currentSession) sendMessage(text);
                    else injectPrefill(text);
                    setQuickActionsOpen(false);
                  }}
                  onPrefillMention={injectPrefill}
                  onCreateAgent={() => setCurrentView('agents')}
                  onAfterPick={() => setQuickActionsOpen(false)}
                />
              )}
              <ChatInput
                onSendMessage={sendMessage}
                onStop={stopChat}
                disabled={!connectionStatus.connected}
                isLoading={isLoading}
                agentName={currentAgentData?.name}
                model={currentAgentData?.model}
                agents={agents}
                currentAgentId={currentAgentData?.id}
                injectMessage={injectMessage}
                quickActionsOpen={quickActionsOpen}
                onToggleQuickActions={() => setQuickActionsOpen(v => !v)}
              />
            </>
          ) : currentView === 'agents' ? (
            <AgentManager sendRequest={sendRequest} onAgentsChanged={fetchAgents} token={token} />
          ) : currentView === 'workflow' ? (
            <WorkflowView
              token={token}
              onSendMessage={(text) => {
                setCurrentView('chat');
                const sec = agents.find(a => a.id === 'secretary') || agents[0];
                if (sec && !selectedAgent) { setSelectedAgent(sec); createSession(sec.id); }
                setTimeout(() => sendMessage(text), 200);
              }}
              onOpenVNC={() => setShowVNC(true)}
            />
          ) : currentView === 'cron' ? (
            <CronManager sendRequest={sendRequest} agents={agents} />
          ) : currentView === 'channels' ? (
            <ChannelManager sendRequest={sendRequest} agents={agents} token={token} />
          ) : currentView === 'integrations' ? (
            <IntegrationsPage />
          ) : null}
        </div>
      </div>

      {/* ═══ BOTTOM STATUS BAR ═══ */}
      <footer className="h-8 flex items-center justify-between px-4 bg-card border-t border-border-color text-xs text-text-secondary flex-shrink-0">
        <div className="flex items-center gap-4">
          <span>⚡ {apiCallCount} API</span>
        </div>
        <div className="flex items-center gap-2">
          <span className={`w-1.5 h-1.5 rounded-full ${connectionStatus.connected ? 'bg-green-500' : 'bg-red-400'}`} />
          <Clock1Sec />
        </div>
      </footer>

      {showHelp && <HelpModal onClose={() => setShowHelp(false)} />}
      {showVNC && <VNCPanel token={token} onClose={() => setShowVNC(false)} />}

      {/* 통합 검색 팔레트 — Cmd+K */}
      <CommandPalette
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        agents={agents}
        sessions={sessions}
        messages={messages as Message[]}
        onSelectAgent={(a) => { handleSelectAgent(a); }}
        onSelectSession={(sk) => { switchSession(sk); setCurrentView('chat'); }}
        onNavigate={(v) => setCurrentView(v)}
      />

      {/* 자비스 푸시 토스트 — 우상단 고정 */}
      <NotificationToast toasts={toasts} onDismiss={dismissToast} />
    </div>
  );
}

// Admin page wrapper — standalone at /admin
function AdminApp() {
  const [authenticated, setAuthenticated] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const cookieMatch = document.cookie.match(/gateway_token=([^;]+)/);
    if (cookieMatch) {
      setAuthenticated(true);
      setLoading(false);
    } else {
      fetch('/auth/me', { credentials: 'include' })
        .then(r => r.json())
        .then(d => { if (d.ok) setAuthenticated(true); })
        .catch(() => {})
        .finally(() => setLoading(false));
    }
  }, []);

  if (loading) return <div className="min-h-screen bg-background flex items-center justify-center text-text-secondary">로딩 중...</div>;

  if (!authenticated) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center p-4">
        <div className="w-full max-w-md text-center">
          <div className="w-20 h-20 bg-accent rounded-2xl flex items-center justify-center mx-auto mb-4 shadow-lg shadow-accent/20">
            <span className="text-4xl">🛡️</span>
          </div>
          <h1 className="text-3xl font-bold text-text-primary mb-2">TideClaw Admin</h1>
          <p className="text-text-secondary mb-6">관리자 페이지에 접속하려면 로그인이 필요합니다</p>
          <button
            onClick={() => { window.location.href = '/oauth/google'; }}
            className="w-full max-w-sm mx-auto flex items-center justify-center gap-3 py-3 bg-white hover:bg-gray-50 text-gray-800 rounded-xl font-medium transition-colors border border-gray-300"
          >
            <svg className="w-5 h-5" viewBox="0 0 24 24">
              <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 01-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z"/>
              <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/>
              <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"/>
              <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/>
            </svg>
            Google 계정으로 로그인
          </button>
          <p className="text-xs text-text-secondary mt-4">@tideflo.com 이메일만 접속 가능합니다</p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background">
      <div className="bg-card border-b border-border-color px-6 py-3 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <span className="text-2xl">🛡️</span>
          <h1 className="text-lg font-bold text-text-primary">TideClaw Admin</h1>
        </div>
        <div className="flex items-center gap-3">
          <a href="/" className="text-sm text-text-secondary hover:text-accent transition-colors">워크스페이스로 이동</a>
          <button onClick={async () => { try { await fetch('/auth/logout', { method: 'POST' }); } catch {} ['session','user_email','user_name','user_nn','gateway_token','oauth_state'].forEach(n => { document.cookie = `${n}=; Path=/; Max-Age=0`; }); window.location.href = '/admin'; }}
            className="px-3 py-1.5 text-sm text-text-secondary hover:text-red-400 transition-colors">로그아웃</button>
        </div>
      </div>
      <AdminPanel />
    </div>
  );
}

// Route: /admin → AdminApp, else → App
function Root() {
  if (window.location.pathname.startsWith('/admin')) return <AdminApp />;
  return <App />;
}

export default Root;
