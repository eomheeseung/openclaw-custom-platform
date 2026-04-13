import { useState, useEffect, useCallback } from 'react';
import { Network, Bot, Clock, HelpCircle, MessageSquare, LayoutDashboard, Link, Search, Pin, ExternalLink, Settings, Monitor } from 'lucide-react';
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
import { IntegrationsPage } from './components/IntegrationsPage';
import type { Agent, Session } from './types';

type ViewType = 'dashboard' | 'chat' | 'agents' | 'cron' | 'channels' | 'integrations';

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
const dockItems: { key: ViewType; icon: string; label: string }[] = [
  { key: 'chat',         icon: '💬', label: '채팅' },
  { key: 'dashboard',    icon: '📊', label: '대시보드' },
  { key: 'agents',       icon: '🤖', label: '에이전트' },
  { key: 'cron',         icon: '⏰', label: '예약 작업' },
  { key: 'channels',     icon: '📡', label: '채널 연동' },
  { key: 'integrations', icon: '🔗', label: '외부 연동' },
];

function App() {
  const [token, setToken] = useState<string>('');
  const [currentView, setCurrentView] = useState<ViewType>('dashboard');
  const [selectedAgent, setSelectedAgent] = useState<Agent | null>(null);
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
    currentSession, createSession, switchSession, loadSessionHistory,
    deleteSession, stopChat, isLoading, apiCallCount, sendRequest, fetchAgents,
  } = useWebSocket({ url: token ? getGatewayUrl(token) : '', token });

  const handleSelectAgent = useCallback((agent: Agent) => {
    setSelectedAgent(agent); setCurrentView('chat'); createSession(agent.id);
  }, [createSession]);

  const resolveAgentFromSessionKey = useCallback((sessionKey: string | undefined): Agent | null => {
    if (!sessionKey) return null;
    const m = sessionKey.match(/^agent:([^:]+):/);
    if (!m) return null;
    return agents.find(a => a.id === m[1]) || null;
  }, [agents]);

  const handleSelectSession = useCallback((session: Session) => {
    const byId = session.agentId ? agents.find(a => a.id === session.agentId) : null;
    const byKey = byId || resolveAgentFromSessionKey(session.sessionKey);
    setSelectedAgent(byKey);
    switchSession(session.sessionKey); setCurrentView('chat');
  }, [agents, switchSession, resolveAgentFromSessionKey]);

  const handleCreateSession = useCallback(() => { createSession(selectedAgent?.id); }, [createSession, selectedAgent]);

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
          {dockItems.map((item) => (
            <button
              key={item.key}
              onClick={() => setCurrentView(item.key)}
              className={`w-11 h-11 rounded-xl flex items-center justify-center text-lg transition-all relative group
                ${currentView === item.key
                  ? 'bg-accent/10 text-accent'
                  : 'text-text-secondary hover:bg-accent/5 hover:text-accent'
                }`}
              title={item.label}
            >
              {/* Active indicator */}
              {currentView === item.key && (
                <span className="absolute left-0 top-1/2 -translate-y-1/2 w-[3px] h-5 bg-accent rounded-r-full" />
              )}
              <span>{item.icon}</span>
            </button>
          ))}

          {/* Spacer + bottom icons */}
          <div className="flex-1" />
          <div className="w-7 h-px bg-border-color my-2" />
          <button
            onClick={() => setShowVNC(true)}
            className="w-11 h-11 rounded-xl flex items-center justify-center text-text-secondary hover:text-accent hover:bg-accent/5 transition-all"
            title="원격 데스크톱 (VNC)"
          >
            <Monitor className="w-5 h-5" />
          </button>
          <button
            onClick={() => setShowHelp(true)}
            className="w-11 h-11 rounded-xl flex items-center justify-center text-text-secondary hover:text-accent hover:bg-accent/5 transition-all"
            title="도움말"
          >
            <HelpCircle className="w-5 h-5" />
          </button>
          <button
            className="w-11 h-11 rounded-xl flex items-center justify-center text-text-secondary hover:text-accent hover:bg-accent/5 transition-all"
            title="설정"
          >
            <Settings className="w-5 h-5" />
          </button>
        </nav>

        {/* ─── SIDEBAR (agent list + sessions) ─── */}
        <aside className="w-64 flex-shrink-0 flex flex-col bg-card/30 border-r border-border-color overflow-hidden">
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
        </aside>

        {/* ─── MAIN CONTENT ─── */}
        <div className="flex-1 flex flex-col min-w-0 overflow-hidden">

          {/* Chat header — only in chat view */}
          {currentView === 'chat' && currentAgentData && (
            <div className="px-6 py-3 flex items-center justify-between border-b border-border-color bg-card/60 flex-shrink-0">
              <div className="flex items-center gap-3">
                <span className="text-lg">{currentAgentData.emoji || '🤖'}</span>
                <span className="font-bold text-text-primary text-lg">{currentAgentData.name}</span>
                <span className="text-xs font-mono px-2 py-0.5 rounded bg-accent/10 text-accent border border-accent/15">
                  {currentAgentData.model || 'AI'}
                </span>
              </div>
              <div className="flex gap-1.5">
                <button className="w-8 h-8 rounded-lg border border-border-color bg-card flex items-center justify-center text-text-secondary hover:text-accent hover:border-accent/20 transition-all" title="검색">
                  <Search className="w-4 h-4" />
                </button>
                <button className="w-8 h-8 rounded-lg border border-border-color bg-card flex items-center justify-center text-text-secondary hover:text-accent hover:border-accent/20 transition-all" title="고정">
                  <Pin className="w-4 h-4" />
                </button>
                <button className="w-8 h-8 rounded-lg border border-border-color bg-card flex items-center justify-center text-text-secondary hover:text-accent hover:border-accent/20 transition-all" title="내보내기">
                  <ExternalLink className="w-4 h-4" />
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
              <MessageList messages={messages} agents={agents} />
              <ChatInput onSendMessage={sendMessage} onStop={stopChat} disabled={!connectionStatus.connected} isLoading={isLoading} agentName={currentAgentData?.name} model={currentAgentData?.model} agents={agents} currentAgentId={currentAgentData?.id} />
            </>
          ) : currentView === 'agents' ? (
            <AgentManager sendRequest={sendRequest} onAgentsChanged={fetchAgents} token={token} />
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
