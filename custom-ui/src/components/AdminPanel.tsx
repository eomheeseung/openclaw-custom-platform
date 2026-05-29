import { useState, useEffect, useCallback } from 'react';
import { Users, Server, Activity, Settings, RefreshCw, UserPlus, UserMinus, RotateCcw, ChevronDown, ChevronRight, Cpu, HardDrive, Loader2, CheckCircle, XCircle, AlertTriangle, BarChart3, DollarSign } from 'lucide-react';

interface UserSlot {
  slot: string;
  email: string | null;
  name: string | null;
  activeSessions: number;
  lastLogin: number | null;
  lastActivity: number | null;
  loginCount: number;
}

interface ContainerInfo {
  slot: string;
  name: string;
  status: string;
  state: string;
}

interface ContainerStats {
  slot: string;
  cpu: string;
  mem: string;
  memPerc: string;
}

interface SlotAgent {
  id: string;
  name: string;
  emoji: string;
  default: boolean;
  isDiscord: boolean;
}

type AdminTab = 'users' | 'containers' | 'usage' | 'config';

interface UsageDay {
  date?: string;
  weekStart?: string;
  totalTokens: number;
  costUsd: number;
  costKrw: number;
  messageCount: number;
  models?: Record<string, { input: number; output: number; cacheRead: number; cacheWrite: number; totalTokens: number; messageCount: number; costUsd: number }>;
}
interface UsageUser {
  days: UsageDay[];
  total: { totalTokens: number; costUsd: number; costKrw: number; messageCount: number };
  models: Record<string, { input: number; output: number; cacheRead: number; cacheWrite: number; totalTokens: number; messageCount: number; costUsd: number }>;
}
interface UsageResponse {
  ok: boolean;
  from: string;
  to: string;
  groupBy: string;
  users: Record<string, UsageUser>;
  slotEmails: Record<string, string>;
  slotNames: Record<string, string>;
  grandTotal: { totalTokens: number; costUsd: number; costKrw: number; messageCount: number };
  fx: { usdToKrw: number; updatedAt: string; source?: string } | null;
}

function timeAgo(ts: number | null): string {
  if (!ts) return '-';
  const diff = Date.now() - ts;
  if (diff < 60000) return '방금 전';
  if (diff < 3600000) return `${Math.floor(diff / 60000)}분 전`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}시간 전`;
  return `${Math.floor(diff / 86400000)}일 전`;
}

const ADMIN_TABS: AdminTab[] = ['users', 'containers', 'usage', 'config'];

function pathToAdminTab(): AdminTab {
  const m = window.location.pathname.match(/^\/admin\/([a-z]+)/);
  if (m && (ADMIN_TABS as string[]).includes(m[1])) return m[1] as AdminTab;
  return 'users';
}

export function AdminPanel() {
  const [tab, _setTab] = useState<AdminTab>(() => pathToAdminTab());

  const setTab = useCallback((t: AdminTab) => {
    _setTab(t);
    const target = `/admin/${t}`;
    if (window.location.pathname !== target) {
      window.history.pushState({}, '', target);
    }
  }, []);

  useEffect(() => {
    const onPop = () => _setTab(pathToAdminTab());
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  const [slots, setSlots] = useState<UserSlot[]>([]);
  const [containers, setContainers] = useState<ContainerInfo[]>([]);
  const [stats, setStats] = useState<ContainerStats[]>([]);
  const [config, setConfig] = useState<{ apiKeys: Record<string, boolean>; totalSlots: number; usersAssigned: number; activeSessions: number } | null>(null);
  const [moonshotKeys, setMoonshotKeys] = useState<{ count: number; mode: string; keys: Array<{ label: string; masked: string; status: string; httpCode?: number; reason?: string | null }> } | null>(null);
  const [moonshotKeysLoading, setMoonshotKeysLoading] = useState(false);
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');

  // User assign form
  const [assignSlot, setAssignSlot] = useState('');
  const [assignEmail, setAssignEmail] = useState('');
  const [showAssign, setShowAssign] = useState(false);

  // Expanded slot details
  const [expandedSlot, setExpandedSlot] = useState<string | null>(null);
  const [slotAgents, setSlotAgents] = useState<Record<string, { agents: SlotAgent[]; model: string; discordAccounts: string[] }>>({});

  // Usage tracking
  const [usage, setUsage] = useState<UsageResponse | null>(null);
  const [usagePeriod, setUsagePeriod] = useState<'week' | 'month' | 'all'>('month');
  const [usageGroupBy, setUsageGroupBy] = useState<'day' | 'week'>('day');
  const [refreshingUsage, setRefreshingUsage] = useState(false);
  const [expandedUsageUser, setExpandedUsageUser] = useState<string | null>(null);

  const showMsg = (msg: string, isError = false) => {
    if (isError) { setError(msg); setTimeout(() => setError(''), 5000); }
    else { setMessage(msg); setTimeout(() => setMessage(''), 5000); }
  };

  const fetchUsers = useCallback(async () => {
    try {
      const r = await fetch('/api/admin/users', { credentials: 'include' });
      const d = await r.json();
      if (d.ok) setSlots(d.slots);
    } catch { /* ignore */ }
  }, []);

  const fetchContainers = useCallback(async () => {
    try {
      const r = await fetch('/api/admin/containers', { credentials: 'include' });
      const d = await r.json();
      if (d.ok) setContainers(d.containers);
    } catch { /* ignore */ }
  }, []);

  const fetchStats = useCallback(async () => {
    try {
      const r = await fetch('/api/admin/containers/stats', { credentials: 'include' });
      const d = await r.json();
      if (d.ok) setStats(d.stats);
    } catch { /* ignore */ }
  }, []);

  const fetchMoonshotKeys = useCallback(async () => {
    setMoonshotKeysLoading(true);
    try {
      const r = await fetch('/api/admin/keys', { credentials: 'include' });
      const d = await r.json();
      if (d.ok) setMoonshotKeys(d);
    } catch { /* ignore */ }
    finally { setMoonshotKeysLoading(false); }
  }, []);

  const fetchConfig = useCallback(async () => {
    try {
      const r = await fetch('/api/admin/config', { credentials: 'include' });
      const d = await r.json();
      if (d.ok) setConfig(d);
    } catch { /* ignore */ }
  }, []);

  const fetchUsage = useCallback(async (period: 'week' | 'month' | 'all', groupBy: 'day' | 'week') => {
    try {
      const today = new Date();
      const kst = new Date(today.getTime() + 9 * 60 * 60 * 1000);
      const toStr = kst.toISOString().slice(0, 10);
      let fromStr = '2026-01-01';
      if (period === 'week') fromStr = new Date(kst.getTime() - 7 * 86400000).toISOString().slice(0, 10);
      else if (period === 'month') fromStr = new Date(kst.getTime() - 30 * 86400000).toISOString().slice(0, 10);

      const params = new URLSearchParams({ from: fromStr, to: toStr, groupBy });
      const r = await fetch(`/api/admin/usage?${params}`, { credentials: 'include' });
      const d = await r.json();
      if (d.ok) setUsage(d);
    } catch { /* ignore */ }
  }, []);

  const refreshUsageNow = async () => {
    setRefreshingUsage(true);
    try {
      await fetch('/api/admin/usage/refresh', { method: 'POST', credentials: 'include' });
      await fetchUsage(usagePeriod, usageGroupBy);
      showMsg('사용량 데이터를 새로 집계했습니다');
    } catch {
      showMsg('재집계 실패', true);
    } finally {
      setRefreshingUsage(false);
    }
  };

  const fetchSlotAgents = async (slot: string) => {
    try {
      const r = await fetch(`/api/admin/agents/${slot}`, { credentials: 'include' });
      const d = await r.json();
      if (d.ok) setSlotAgents(prev => ({ ...prev, [slot]: { agents: d.agents, model: d.model, discordAccounts: d.discordAccounts } }));
    } catch { /* ignore */ }
  };

  const refreshAll = async () => {
    setLoading(true);
    await Promise.all([fetchUsers(), fetchContainers(), fetchConfig()]);
    setLoading(false);
  };

  useEffect(() => { refreshAll(); }, []);

  useEffect(() => {
    if (tab === 'usage') fetchUsage(usagePeriod, usageGroupBy);
  }, [tab, usagePeriod, usageGroupBy, fetchUsage]);

  useEffect(() => {
    if (tab === 'containers') { fetchContainers(); fetchStats(); }
  }, [tab]);

  useEffect(() => {
    if (tab === 'config') fetchMoonshotKeys();
  }, [tab, fetchMoonshotKeys]);

  const handleAssign = async () => {
    if (!assignEmail.trim() || !assignSlot) { showMsg('이메일과 슬롯을 입력하세요', true); return; }
    try {
      const r = await fetch('/api/admin/users/assign', {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: assignEmail.trim(), slot: assignSlot }),
      });
      const d = await r.json();
      if (d.ok) { showMsg(`${assignEmail} → user${assignSlot} 할당 완료`); setShowAssign(false); setAssignEmail(''); setAssignSlot(''); fetchUsers(); }
      else showMsg(d.error || '할당 실패', true);
    } catch (e) { showMsg('할당 실패', true); }
  };

  const handleRemove = async (email: string) => {
    if (!confirm(`${email} 유저를 슬롯에서 제거하시겠습니까?`)) return;
    try {
      const r = await fetch('/api/admin/users/remove', {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email }),
      });
      const d = await r.json();
      if (d.ok) { showMsg(`${email} 제거 완료`); fetchUsers(); }
      else showMsg(d.error || '제거 실패', true);
    } catch { showMsg('제거 실패', true); }
  };

  const handleRestart = async (slot: string) => {
    if (!confirm(`user${slot} 컨테이너를 재시작하시겠습니까?`)) return;
    showMsg(`user${slot} 재시작 중...`);
    try {
      const r = await fetch('/api/admin/containers/restart', {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ slot }),
      });
      const d = await r.json();
      if (d.ok) { showMsg(`user${slot} 재시작 완료`); setTimeout(fetchContainers, 3000); }
      else showMsg(d.error || '재시작 실패', true);
    } catch { showMsg('재시작 실패', true); }
  };

  const toggleExpand = (slot: string) => {
    if (expandedSlot === slot) { setExpandedSlot(null); return; }
    setExpandedSlot(slot);
    if (!slotAgents[slot]) fetchSlotAgents(slot);
  };

  const getContainerState = (slot: string) => containers.find(c => c.slot === slot);
  const getContainerStats = (slot: string) => stats.find(s => s.slot === slot);

  const tabs: { key: AdminTab; label: string; icon: React.ReactNode }[] = [
    { key: 'users', label: '유저 관리', icon: <Users className="w-4 h-4" /> },
    { key: 'containers', label: '컨테이너', icon: <Server className="w-4 h-4" /> },
    { key: 'usage', label: 'API 사용량', icon: <BarChart3 className="w-4 h-4" /> },
    { key: 'config', label: '시스템', icon: <Settings className="w-4 h-4" /> },
  ];

  return (
    <div className="flex-1 overflow-y-auto p-6">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h2 className="text-xl font-bold text-text-primary">관리자</h2>
          <p className="text-sm text-text-secondary">시스템 관리 및 유저 슬롯 관리</p>
        </div>
        <button onClick={refreshAll} disabled={loading} className="px-3 py-2 text-sm bg-card border border-border-color rounded-lg text-text-secondary hover:text-text-primary transition-colors flex items-center gap-2">
          {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />}
          새로고침
        </button>
      </div>

      {/* System overview cards */}
      {config && (
        <div className="grid grid-cols-4 gap-3 mb-6">
          <div className="bg-card border border-border-color rounded-xl p-4">
            <p className="text-xs text-text-secondary mb-1">할당된 유저</p>
            <p className="text-2xl font-bold text-text-primary">{config.usersAssigned}<span className="text-sm text-text-secondary font-normal"> / {config.totalSlots}</span></p>
          </div>
          <div className="bg-card border border-border-color rounded-xl p-4">
            <p className="text-xs text-text-secondary mb-1">활성 세션</p>
            <p className="text-2xl font-bold text-text-primary">{config.activeSessions}</p>
          </div>
          <div className="bg-card border border-border-color rounded-xl p-4">
            <p className="text-xs text-text-secondary mb-1">실행 컨테이너</p>
            <p className="text-2xl font-bold text-text-primary">{containers.filter(c => c.state === 'running').length}<span className="text-sm text-text-secondary font-normal"> / 15</span></p>
          </div>
          <div className="bg-card border border-border-color rounded-xl p-4">
            <p className="text-xs text-text-secondary mb-1">API 키</p>
            <div className="flex gap-2 mt-1">
              {Object.entries(config.apiKeys).map(([k, v]) => (
                <span key={k} className={`text-xs px-2 py-0.5 rounded ${v ? 'bg-green-500/10 text-green-400' : 'bg-red-500/10 text-red-400'}`}>
                  {k}
                </span>
              ))}
            </div>
          </div>
        </div>
      )}

      {message && <div className="mb-4 p-3 bg-green-500/10 border border-green-500/30 rounded-lg text-green-400 text-sm">{message}</div>}
      {error && <div className="mb-4 p-3 bg-red-500/10 border border-red-500/30 rounded-lg text-red-400 text-sm">{error}</div>}

      {/* Tabs */}
      <div className="flex gap-1 mb-4 bg-card border border-border-color rounded-xl p-1">
        {tabs.map(t => (
          <button key={t.key} onClick={() => setTab(t.key)}
            className={`flex-1 flex items-center justify-center gap-2 px-4 py-2 rounded-lg text-sm transition-colors ${tab === t.key ? 'bg-accent text-white' : 'text-text-secondary hover:text-text-primary'}`}>
            {t.icon} {t.label}
          </button>
        ))}
      </div>

      {/* Users Tab */}
      {tab === 'users' && (
        <div className="bg-card border border-border-color rounded-xl overflow-hidden">
          <div className="flex items-center justify-between p-4 border-b border-border-color">
            <h3 className="font-semibold text-text-primary flex items-center gap-2"><Users className="w-4 h-4" /> 유저 슬롯 (15)</h3>
            <button onClick={() => setShowAssign(!showAssign)} className="px-3 py-1.5 text-xs bg-accent hover:bg-accent-hover text-white rounded-lg flex items-center gap-1">
              <UserPlus className="w-3 h-3" /> 유저 할당
            </button>
          </div>

          {showAssign && (
            <div className="p-4 border-b border-border-color bg-background/50 flex items-end gap-3">
              <div className="flex-1">
                <label className="text-xs text-text-secondary mb-1 block">이메일</label>
                <input value={assignEmail} onChange={e => setAssignEmail(e.target.value)} placeholder="user@tideflo.com"
                  className="w-full px-3 py-2 bg-background border border-border-color rounded-lg text-text-primary text-sm focus:outline-none focus:border-accent" />
              </div>
              <div className="w-24">
                <label className="text-xs text-text-secondary mb-1 block">슬롯</label>
                <select value={assignSlot} onChange={e => setAssignSlot(e.target.value)}
                  className="w-full px-3 py-2 bg-background border border-border-color rounded-lg text-text-primary text-sm focus:outline-none focus:border-accent">
                  <option value="">선택</option>
                  {slots.filter(s => !s.email).map(s => <option key={s.slot} value={s.slot}>{s.slot}</option>)}
                </select>
              </div>
              <button onClick={handleAssign} className="px-4 py-2 bg-accent hover:bg-accent-hover text-white rounded-lg text-sm">할당</button>
              <button onClick={() => setShowAssign(false)} className="px-4 py-2 text-text-secondary hover:text-text-primary text-sm">취소</button>
            </div>
          )}

          <div className="divide-y divide-border-color">
            {slots.map(s => {
              const container = getContainerState(s.slot);
              const isRunning = container?.state === 'running';
              const expanded = expandedSlot === s.slot;
              const agentInfo = slotAgents[s.slot];

              return (
                <div key={s.slot}>
                  <div className="flex items-center px-4 py-3 hover:bg-background/30 transition-colors cursor-pointer" onClick={() => s.email && toggleExpand(s.slot)}>
                    {/* Slot number */}
                    <span className="w-10 text-sm font-mono text-text-secondary">{s.slot}</span>

                    {/* Status dot */}
                    <span className={`w-2 h-2 rounded-full mr-3 ${isRunning ? 'bg-green-400' : 'bg-gray-500'}`} />

                    {/* Email or empty */}
                    {s.email ? (
                      <span className="flex-1 text-sm">
                        <span className="text-text-primary">{s.email}</span>
                        {s.name && <span className="ml-2 text-text-secondary">({s.name})</span>}
                      </span>
                    ) : (
                      <span className="flex-1 text-sm text-text-secondary italic">빈 슬롯</span>
                    )}

                    {/* Activity */}
                    {s.email && (
                      <div className="flex items-center gap-4 mr-4">
                        <span className="text-xs text-text-secondary" title="활성 세션">{s.activeSessions > 0 ? `${s.activeSessions} 세션` : ''}</span>
                        <span className="text-xs text-text-secondary" title="마지막 로그인">{timeAgo(s.lastLogin)}</span>
                      </div>
                    )}

                    {/* Actions */}
                    {s.email && (
                      <div className="flex items-center gap-1">
                        <button onClick={(e) => { e.stopPropagation(); handleRemove(s.email!); }}
                          className="p-1.5 text-text-secondary hover:text-red-400 rounded transition-colors" title="유저 제거">
                          <UserMinus className="w-4 h-4" />
                        </button>
                        <button onClick={(e) => { e.stopPropagation(); handleRestart(s.slot); }}
                          className="p-1.5 text-text-secondary hover:text-accent rounded transition-colors" title="컨테이너 재시작">
                          <RotateCcw className="w-4 h-4" />
                        </button>
                        {s.email && (expanded ? <ChevronDown className="w-4 h-4 text-text-secondary" /> : <ChevronRight className="w-4 h-4 text-text-secondary" />)}
                      </div>
                    )}
                  </div>

                  {/* Expanded details */}
                  {expanded && agentInfo && (
                    <div className="px-14 pb-3 space-y-2">
                      <div className="flex items-center gap-2 text-xs text-text-secondary">
                        <Cpu className="w-3 h-3" /> 모델: <span className="text-text-primary">{agentInfo.model}</span>
                      </div>
                      <div className="flex flex-wrap gap-1.5">
                        {agentInfo.agents.filter(a => !a.isDiscord).map(a => (
                          <span key={a.id} className={`px-2 py-0.5 rounded text-xs ${a.default ? 'bg-accent/20 text-accent' : 'bg-background text-text-secondary'}`}>
                            {a.emoji || '🤖'} {a.name}
                          </span>
                        ))}
                      </div>
                      {agentInfo.discordAccounts.length > 0 && (
                        <div className="text-xs text-text-secondary">
                          Discord: {agentInfo.discordAccounts.join(', ')}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Containers Tab */}
      {tab === 'containers' && (
        <div className="space-y-4">
          <div className="flex justify-end">
            <button onClick={() => { fetchContainers(); fetchStats(); }} className="px-3 py-1.5 text-xs bg-card border border-border-color rounded-lg text-text-secondary hover:text-text-primary flex items-center gap-1">
              <RefreshCw className="w-3 h-3" /> 리소스 새로고침
            </button>
          </div>
          <div className="grid grid-cols-2 gap-3">
            {Array.from({ length: 15 }, (_, i) => {
              const slot = String(i + 1).padStart(2, '0');
              const container = getContainerState(slot);
              const stat = getContainerStats(slot);
              const userSlot = slots.find(s => s.slot === slot);
              const isRunning = container?.state === 'running';

              return (
                <div key={slot} className={`bg-card border rounded-xl p-4 ${isRunning ? 'border-border-color' : 'border-red-500/30'}`}>
                  <div className="flex items-center justify-between mb-3">
                    <div className="flex items-center gap-2">
                      <span className={`w-2 h-2 rounded-full ${isRunning ? 'bg-green-400' : 'bg-red-400'}`} />
                      <span className="text-sm font-medium text-text-primary">user{slot}</span>
                      {userSlot?.email && <span className="text-xs text-text-secondary truncate max-w-[150px]">{userSlot.email}</span>}
                    </div>
                    <button onClick={() => handleRestart(slot)}
                      className="p-1.5 text-text-secondary hover:text-accent rounded transition-colors" title="재시작">
                      <RotateCcw className="w-4 h-4" />
                    </button>
                  </div>
                  <div className="text-xs text-text-secondary mb-2">{container?.status || 'Unknown'}</div>
                  {stat && (
                    <div className="grid grid-cols-2 gap-2">
                      <div className="bg-background rounded-lg p-2">
                        <div className="flex items-center gap-1 text-xs text-text-secondary mb-0.5"><Cpu className="w-3 h-3" /> CPU</div>
                        <div className="text-sm font-medium text-text-primary">{stat.cpu}</div>
                      </div>
                      <div className="bg-background rounded-lg p-2">
                        <div className="flex items-center gap-1 text-xs text-text-secondary mb-0.5"><HardDrive className="w-3 h-3" /> Memory</div>
                        <div className="text-sm font-medium text-text-primary">{stat.memPerc}</div>
                        <div className="text-xs text-text-secondary">{stat.mem}</div>
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Usage Tab */}
      {tab === 'usage' && (
        <div className="space-y-4">
          {/* 컨트롤 바 */}
          <div className="bg-card border border-border-color rounded-xl p-4 flex items-center gap-3 flex-wrap">
            <div className="flex items-center gap-2">
              <span className="text-xs text-text-secondary">기간:</span>
              {(['week', 'month', 'all'] as const).map(p => (
                <button key={p} onClick={() => setUsagePeriod(p)}
                  className={`px-3 py-1.5 text-xs rounded-lg transition-colors ${usagePeriod === p ? 'bg-accent text-white' : 'bg-background border border-border-color text-text-secondary hover:text-text-primary'}`}>
                  {p === 'week' ? '최근 7일' : p === 'month' ? '최근 30일' : '전체'}
                </button>
              ))}
            </div>
            <div className="flex items-center gap-2">
              <span className="text-xs text-text-secondary">그룹:</span>
              {(['day', 'week'] as const).map(g => (
                <button key={g} onClick={() => setUsageGroupBy(g)}
                  className={`px-3 py-1.5 text-xs rounded-lg transition-colors ${usageGroupBy === g ? 'bg-accent text-white' : 'bg-background border border-border-color text-text-secondary hover:text-text-primary'}`}>
                  {g === 'day' ? '일별' : '주별'}
                </button>
              ))}
            </div>
            <button onClick={refreshUsageNow} disabled={refreshingUsage}
              className="ml-auto px-3 py-1.5 text-xs bg-background border border-border-color rounded-lg text-text-secondary hover:text-text-primary transition-colors flex items-center gap-2">
              {refreshingUsage ? <Loader2 className="w-3 h-3 animate-spin" /> : <RefreshCw className="w-3 h-3" />}
              지금 재집계
            </button>
          </div>

          {/* 합계 카드 */}
          {usage && (
            <div className="grid grid-cols-4 gap-3">
              <div className="bg-card border border-border-color rounded-xl p-4">
                <p className="text-xs text-text-secondary mb-1">총 비용 (KRW)</p>
                <p className="text-2xl font-bold text-text-primary">₩{usage.grandTotal.costKrw.toLocaleString()}</p>
                <p className="text-xs text-text-secondary mt-1">${usage.grandTotal.costUsd.toFixed(4)}</p>
              </div>
              <div className="bg-card border border-border-color rounded-xl p-4">
                <p className="text-xs text-text-secondary mb-1">총 토큰</p>
                <p className="text-2xl font-bold text-text-primary">{(usage.grandTotal.totalTokens / 1000).toFixed(1)}K</p>
                <p className="text-xs text-text-secondary mt-1">{usage.grandTotal.totalTokens.toLocaleString()} tokens</p>
              </div>
              <div className="bg-card border border-border-color rounded-xl p-4">
                <p className="text-xs text-text-secondary mb-1">총 메시지</p>
                <p className="text-2xl font-bold text-text-primary">{usage.grandTotal.messageCount.toLocaleString()}</p>
              </div>
              <div className="bg-card border border-border-color rounded-xl p-4">
                <p className="text-xs text-text-secondary mb-1">환율</p>
                <p className="text-2xl font-bold text-text-primary">{usage.fx?.usdToKrw.toLocaleString() || '-'}</p>
                <p className="text-xs text-text-secondary mt-1">{usage.fx?.updatedAt} 기준</p>
              </div>
            </div>
          )}

          {/* 사용자별 표 — A안: 활동성 중심 */}
          {usage && (() => {
            // 전체 합 대비 점유율(%)용
            const totalKrwAll = usage.grandTotal.costKrw || 0;
            // 막대 길이는 시각적 비교를 위해 1위 대비
            const maxKrwAcrossUsers = Math.max(
              ...Object.values(usage.users).map(u => u?.total.costKrw || 0),
              1
            );

            return (
              <div className="bg-card border border-border-color rounded-xl overflow-hidden">
                <div className="grid grid-cols-12 gap-2 px-4 py-3 bg-background text-xs text-text-secondary font-medium">
                  <div className="col-span-1">슬롯</div>
                  <div className="col-span-3">이메일 (이름)</div>
                  <div className="col-span-1 text-right" title="이 기간 중 실제로 사용한 날 수">활동일수</div>
                  <div className="col-span-2 text-right" title="활동일 평균 비용 (사용한 날만 계산)">일평균</div>
                  <div className="col-span-2 text-right">누적 비용</div>
                  <div className="col-span-3" title="전체 비용 중 이 사용자가 차지하는 점유율 (모든 사용자 합 = 100%)">점유율</div>
                </div>
                {Array.from({ length: 15 }, (_, i) => String(i + 1).padStart(2, '0')).map(nn => {
                  const u = usage.users[nn];
                  const email = usage.slotEmails[nn] || '-';
                  const name = usage.slotNames?.[nn];
                  const tot = u?.total || { totalTokens: 0, costUsd: 0, costKrw: 0, messageCount: 0 };
                  const activeDays = u?.days.filter(d => d.costKrw > 0).length || 0;
                  const avgPerDay = activeDays > 0 ? Math.round(tot.costKrw / activeDays) : 0;
                  const sharePct = totalKrwAll > 0 ? (tot.costKrw / totalKrwAll) * 100 : 0;
                  const barWidthPct = maxKrwAcrossUsers > 0 ? (tot.costKrw / maxKrwAcrossUsers) * 100 : 0;
                  const isExpanded = expandedUsageUser === nn;
                  const hasData = tot.totalTokens > 0;
                  return (
                    <div key={nn} className="border-t border-border-color">
                      <button onClick={() => setExpandedUsageUser(isExpanded ? null : nn)}
                        className={`w-full grid grid-cols-12 gap-2 px-4 py-3 text-sm items-center transition-colors ${hasData ? 'hover:bg-background cursor-pointer' : 'opacity-50 cursor-default'}`}
                        disabled={!hasData}>
                        <div className="col-span-1 flex items-center gap-1">
                          {hasData && (isExpanded ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />)}
                          <span className="text-text-primary font-mono">{nn}</span>
                        </div>
                        <div className="col-span-3 text-text-secondary truncate text-left">
                          <span className="text-text-primary">{email}</span>
                          {name && <span className="ml-2 text-text-secondary">({name})</span>}
                        </div>
                        <div className="col-span-1 text-right text-text-primary">
                          {hasData ? `${activeDays}일` : '-'}
                        </div>
                        <div className="col-span-2 text-right text-text-secondary">
                          {hasData ? `₩${avgPerDay.toLocaleString()}` : '-'}
                        </div>
                        <div className="col-span-2 text-right text-text-primary font-medium">
                          {hasData ? `₩${tot.costKrw.toLocaleString()}` : '-'}
                        </div>
                        <div className="col-span-3">
                          {hasData ? (
                            <div className="flex items-center gap-2">
                              <div className="flex-1 h-2 bg-background rounded overflow-hidden">
                                <div className="h-full bg-accent" style={{ width: `${barWidthPct}%` }} />
                              </div>
                              <span className="text-xs text-text-secondary w-10 text-right">{sharePct.toFixed(1)}%</span>
                            </div>
                          ) : null}
                        </div>
                      </button>

                      {isExpanded && u && (
                        <div className="bg-background px-4 py-4 space-y-4">
                          {/* 요약 카드 */}
                          <div className="grid grid-cols-4 gap-2">
                            <div className="bg-card border border-border-color rounded-lg p-3">
                              <p className="text-xs text-text-secondary">총 메시지</p>
                              <p className="text-lg font-bold text-text-primary">{tot.messageCount.toLocaleString()}<span className="text-xs font-normal text-text-secondary">건</span></p>
                            </div>
                            <div className="bg-card border border-border-color rounded-lg p-3">
                              <p className="text-xs text-text-secondary">총 토큰</p>
                              <p className="text-lg font-bold text-text-primary">{tot.totalTokens.toLocaleString()}</p>
                            </div>
                            <div className="bg-card border border-border-color rounded-lg p-3">
                              <p className="text-xs text-text-secondary">메시지당 평균</p>
                              <p className="text-lg font-bold text-text-primary">
                                {tot.messageCount > 0 ? `₩${Math.round(tot.costKrw / tot.messageCount).toLocaleString()}` : '-'}
                              </p>
                            </div>
                            <div className="bg-card border border-border-color rounded-lg p-3">
                              <p className="text-xs text-text-secondary">총 비용</p>
                              <p className="text-lg font-bold text-text-primary">₩{tot.costKrw.toLocaleString()}</p>
                              <p className="text-xs text-text-secondary">${tot.costUsd.toFixed(4)}</p>
                            </div>
                          </div>

                          {/* 모델별 사용 — 명확한 헤더 */}
                          {Object.keys(u.models).length > 0 && (
                            <div>
                              <p className="text-xs text-text-secondary mb-2 font-medium">모델별 사용</p>
                              <div className="bg-card border border-border-color rounded-lg overflow-hidden">
                                <div className="grid grid-cols-12 gap-2 px-3 py-2 bg-background text-[11px] text-text-secondary font-medium">
                                  <div className="col-span-3">모델</div>
                                  <div className="col-span-2 text-right" title="새로 처리한 입력 토큰 (캐시 미스)">입력 토큰</div>
                                  <div className="col-span-2 text-right" title="모델이 생성한 출력 토큰">출력 토큰</div>
                                  <div className="col-span-2 text-right" title="캐시에서 재사용된 입력 토큰 (할인됨)">캐시 토큰</div>
                                  <div className="col-span-1 text-right">메시지</div>
                                  <div className="col-span-2 text-right">비용</div>
                                </div>
                                {Object.entries(u.models).map(([m, md]) => (
                                  <div key={m} className="grid grid-cols-12 gap-2 text-xs px-3 py-2 border-t border-border-color">
                                    <div className="col-span-3 text-text-primary font-mono">{m}</div>
                                    <div className="col-span-2 text-right text-text-secondary">{md.input.toLocaleString()}</div>
                                    <div className="col-span-2 text-right text-text-secondary">{md.output.toLocaleString()}</div>
                                    <div className="col-span-2 text-right text-text-secondary">{md.cacheRead.toLocaleString()}</div>
                                    <div className="col-span-1 text-right text-text-secondary">{md.messageCount.toLocaleString()}</div>
                                    <div className="col-span-2 text-right text-text-primary">₩{Math.round(md.costUsd * (usage.fx?.usdToKrw || 1380)).toLocaleString()}</div>
                                  </div>
                                ))}
                              </div>
                            </div>
                          )}

                          {/* 일별/주별 추이 — 명확한 헤더 */}
                          {u.days.length > 0 && (
                            <div>
                              <p className="text-xs text-text-secondary mb-2 font-medium">{usageGroupBy === 'day' ? '일별' : '주별'} 추이</p>
                              <div className="bg-card border border-border-color rounded-lg overflow-hidden">
                                <div className="flex items-center gap-2 px-3 py-2 bg-background text-[11px] text-text-secondary font-medium">
                                  <div className="w-24">{usageGroupBy === 'day' ? '날짜' : '주 시작일'}</div>
                                  <div className="flex-1">사용량 비율</div>
                                  <div className="w-24 text-right">비용</div>
                                  <div className="w-20 text-right">토큰</div>
                                  <div className="w-12 text-right">메시지</div>
                                </div>
                                {u.days.slice().reverse().map((d, idx) => {
                                  const maxKrw = Math.max(...u.days.map(x => x.costKrw), 1);
                                  const widthPct = (d.costKrw / maxKrw) * 100;
                                  return (
                                    <div key={idx} className="flex items-center gap-2 text-xs px-3 py-2 border-t border-border-color">
                                      <div className="w-24 text-text-secondary font-mono">{d.date || d.weekStart}</div>
                                      <div className="flex-1 h-5 bg-background rounded overflow-hidden relative">
                                        <div className="h-full bg-accent/30" style={{ width: `${widthPct}%` }} />
                                      </div>
                                      <div className="w-24 text-right text-text-primary">₩{d.costKrw.toLocaleString()}</div>
                                      <div className="w-20 text-right text-text-secondary">{(d.totalTokens / 1000).toFixed(1)}K</div>
                                      <div className="w-12 text-right text-text-secondary">{d.messageCount}</div>
                                    </div>
                                  );
                                })}
                              </div>
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            );
          })()}

          {!usage && (
            <div className="bg-card border border-border-color rounded-xl p-8 text-center text-text-secondary text-sm flex items-center justify-center gap-2">
              <Loader2 className="w-4 h-4 animate-spin" />
              로딩 중...
            </div>
          )}
        </div>
      )}

      {/* Config Tab */}
      {tab === 'config' && config && (
        <div className="space-y-4">
          {/* Moonshot 멀티키 상태 카드 */}
          <div className="bg-card border border-border-color rounded-xl p-5">
            <div className="flex items-center justify-between mb-4">
              <h3 className="font-semibold text-text-primary flex items-center gap-2">
                <Settings className="w-4 h-4" /> Moonshot 멀티키 ({moonshotKeys?.mode === 'round-robin' ? 'Round-Robin' : 'Single'})
              </h3>
              <button onClick={fetchMoonshotKeys} disabled={moonshotKeysLoading}
                className="text-xs px-2 py-1 rounded border border-border-color hover:bg-background transition-colors disabled:opacity-50">
                {moonshotKeysLoading ? '확인 중...' : '새로고침'}
              </button>
            </div>
            {moonshotKeys ? (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                {moonshotKeys.keys.map((k) => {
                  const statusColor =
                    k.status === 'live' ? 'text-green-400 border-green-400/30 bg-green-400/5' :
                    k.status === 'auth_error' ? 'text-red-400 border-red-400/30 bg-red-400/5' :
                    k.status === 'suspended_or_rate_limit' ? 'text-yellow-400 border-yellow-400/30 bg-yellow-400/5' :
                    'text-text-secondary border-border-color bg-background';
                  const statusLabel =
                    k.status === 'live' ? '✅ 정상' :
                    k.status === 'auth_error' ? '❌ 인증 실패' :
                    k.status === 'suspended_or_rate_limit' ? '⚠️ 한도/잔액 부족' :
                    k.status === 'timeout' ? '⏱ 응답 없음' :
                    k.status === 'network_error' ? '🔌 네트워크 오류' :
                    k.status;
                  return (
                    <div key={k.label} className={`p-4 rounded-lg border ${statusColor}`}>
                      <div className="flex items-center justify-between mb-2">
                        <span className="text-sm font-semibold text-text-primary uppercase">{k.label}</span>
                        <span className="text-xs">{statusLabel}</span>
                      </div>
                      <p className="text-xs font-mono text-text-secondary">{k.masked}</p>
                      {k.reason && <p className="text-[10px] mt-1 text-text-secondary/80 break-all">{k.reason}</p>}
                    </div>
                  );
                })}
              </div>
            ) : (
              <p className="text-sm text-text-secondary">{moonshotKeysLoading ? '확인 중...' : '데이터 없음'}</p>
            )}
            {moonshotKeys && moonshotKeys.count > 1 && (
              <p className="text-xs text-text-secondary mt-3">
                OpenClaw가 <strong>{moonshotKeys.count}개 키</strong>를 round-robin으로 사용 중. 사용자 요청마다 번갈아 호출.
              </p>
            )}
          </div>

          <div className="bg-card border border-border-color rounded-xl p-5">
            <h3 className="font-semibold text-text-primary mb-4 flex items-center gap-2"><Settings className="w-4 h-4" /> API 키 상태</h3>
            <div className="space-y-2">
              {Object.entries(config.apiKeys).map(([key, active]) => (
                <div key={key} className="flex items-center gap-3 p-3 bg-background rounded-lg">
                  {active ? <CheckCircle className="w-4 h-4 text-green-400" /> : <XCircle className="w-4 h-4 text-red-400" />}
                  <span className="text-sm text-text-primary font-medium uppercase">{key}</span>
                  <span className={`text-xs ${active ? 'text-green-400' : 'text-red-400'}`}>{active ? '활성' : '미설정'}</span>
                </div>
              ))}
            </div>
          </div>

          <div className="bg-card border border-border-color rounded-xl p-5">
            <h3 className="font-semibold text-text-primary mb-4 flex items-center gap-2"><Activity className="w-4 h-4" /> 시스템 요약</h3>
            <div className="grid grid-cols-3 gap-4">
              <div className="text-center">
                <p className="text-3xl font-bold text-text-primary">{config.usersAssigned}</p>
                <p className="text-xs text-text-secondary mt-1">할당된 유저</p>
              </div>
              <div className="text-center">
                <p className="text-3xl font-bold text-text-primary">{15 - config.usersAssigned}</p>
                <p className="text-xs text-text-secondary mt-1">빈 슬롯</p>
              </div>
              <div className="text-center">
                <p className="text-3xl font-bold text-text-primary">{config.activeSessions}</p>
                <p className="text-xs text-text-secondary mt-1">활성 세션</p>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
