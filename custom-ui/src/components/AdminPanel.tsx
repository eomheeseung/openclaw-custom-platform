import { useState, useEffect, useCallback } from 'react';
import { BusinessMaster } from './BusinessMaster';
import { Users, Server, Activity, Settings, RefreshCw, UserPlus, UserMinus, RotateCcw, ChevronDown, ChevronRight, Cpu, HardDrive, Loader2, CheckCircle, XCircle, AlertTriangle, BarChart3, DollarSign, Package, Briefcase } from 'lucide-react';

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
  /** 에이전트별 모델 지정 (없으면 계정 기본값을 따른다) */
  model?: string;
}

type AdminTab = 'users' | 'containers' | 'usage' | 'config' | 'business';

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

const ADMIN_TABS: AdminTab[] = ['users', 'containers', 'usage', 'config', 'business'];

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
  const [moonshotKeys, setMoonshotKeys] = useState<{
    count: number; mode: string;
    keys: Array<{ label: string; masked: string; status: string; httpCode?: number; reason?: string | null }>;
    /* Anthropic 은 잔액 조회 API 가 없어서 금액 대신 상태 + 분당 한도만 온다 */
    anthropic?: {
      masked: string; status: string; httpCode?: number; reason?: string | null;
      orgId?: string | null; workspaceId?: string | null; users?: string[];
      limits?: { requests: string; inputTokens: string | null; outputTokens: string | null } | null;
      /* 최근 24h 컨테이너 로그에서 수집한 Anthropic 실패 이력 */
      errors?: {
        count: number; lastAt: string | null;
        recent: Array<{ time: string | null; user: string; message: string; httpCode: string | null }>;
        summary: Array<{ message: string; count: number }>;
      } | null;
    } | null;
  } | null>(null);
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

  // Feature enrollment
  interface Feature { id: string; name: string; emoji: string; description: string; current_version?: string }
  const [features, setFeatures] = useState<Feature[]>([]);
  const [enrolledMap, setEnrolledMap] = useState<Record<string, string[]>>({});
  const [featureBusy, setFeatureBusy] = useState<string>(''); // "featureId:userNN" 형식
  const [featureConfirm, setFeatureConfirm] = useState<{ action: 'enroll' | 'unenroll'; feature: Feature; userNN: string; name: string | null } | null>(null);

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

  const fetchFeatures = useCallback(async () => {
    try {
      const r = await fetch('/api/admin/features', { credentials: 'include' });
      const d = await r.json();
      if (d.ok) { setFeatures(d.features || []); setEnrolledMap(d.enrolled || {}); }
    } catch { /* ignore */ }
  }, []);

  const executeFeatureAction = async () => {
    if (!featureConfirm) return;
    const { action, feature, userNN } = featureConfirm;
    const key = `${feature.id}:${userNN}`;
    setFeatureBusy(key);
    try {
      const endpoint = action === 'enroll' ? 'enroll' : 'unenroll';
      const r = await fetch(`/api/admin/features/${endpoint}`, {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ featureId: feature.id, userNN }),
      });
      const d = await r.json();
      if (d.ok) {
        showMsg(`${feature.name} · user${userNN} ${action === 'enroll' ? '활성화' : '회수'} 완료`);
        await fetchFeatures();
        if (expandedSlot === userNN) fetchSlotAgents(userNN);
      } else {
        showMsg(`실패: ${d.error || d.log || 'Unknown'}`, true);
      }
    } catch (e) {
      showMsg(`실패: ${(e as Error).message}`, true);
    } finally {
      setFeatureBusy('');
      setFeatureConfirm(null);
    }
  };

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
    await Promise.all([fetchUsers(), fetchContainers(), fetchConfig(), fetchFeatures()]);
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
    { key: 'business', label: '사업 관리', icon: <Briefcase className="w-4 h-4" /> },
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
            <p className="text-2xl font-bold text-text-primary">{containers.filter(c => c.state === 'running').length}<span className="text-sm text-text-secondary font-normal"> / {config?.totalSlots ?? 16}</span></p>
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

      {/* 사업 마스터 Tab — 담당자 배정이 남의 주간보고 내용을 바꾸므로 관리자 전용 */}
      {tab === 'business' && (
        <BusinessMaster userNames={Object.fromEntries(
          slots.filter(s => s.name || s.email).map(s => [s.slot, s.name || (s.email || '').split('@')[0]]),
        )} />
      )}

      {/* Users Tab */}
      {tab === 'users' && (
        <div className="bg-card border border-border-color rounded-xl overflow-hidden">
          <div className="flex items-center justify-between p-4 border-b border-border-color">
            <h3 className="font-semibold text-text-primary flex items-center gap-2"><Users className="w-4 h-4" /> 유저 슬롯 ({config?.totalSlots ?? 16})</h3>
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
                    <div className="px-14 pb-4 space-y-3">
                      <div className="flex items-center gap-2 text-xs text-text-secondary">
                        <Cpu className="w-3 h-3" /> 기본 모델: <span className="text-text-primary">{agentInfo.model}</span>
                      </div>
                      <div className="flex flex-wrap gap-1.5">
                        {agentInfo.agents.filter(a => !a.isDiscord).map(a => (
                          <span key={a.id} className={`px-2 py-0.5 rounded text-xs ${a.default ? 'bg-accent/20 text-accent' : 'bg-background text-text-secondary'}`}>
                            {a.emoji || '🤖'} {a.name}
                            {/* 계정 기본값과 다른 모델을 쓰는 에이전트만 표시 */}
                            {a.model && <span className="ml-1 opacity-70">· {a.model.split('/').pop()}</span>}
                          </span>
                        ))}
                      </div>
                      {agentInfo.discordAccounts.length > 0 && (
                        <div className="text-xs text-text-secondary">
                          Discord: {agentInfo.discordAccounts.join(', ')}
                        </div>
                      )}

                      {/* 기능 배포 관리 */}
                      {features.length > 0 && (
                        <div className="mt-3 border border-border-color rounded-lg bg-card/50 p-3">
                          <div className="flex items-center justify-between mb-2">
                            <div className="flex items-center gap-1.5 text-xs font-bold text-text-secondary uppercase tracking-wide">
                              <Package className="w-3 h-3" /> 기능 배포 관리
                            </div>
                            <span className="text-xs px-2 py-0.5 rounded-full bg-background border border-border-color text-text-secondary">
                              {features.filter(f => (enrolledMap[f.id] || []).includes(s.slot)).length} / {features.length} 활성화
                            </span>
                          </div>
                          <div className="space-y-1.5">
                            {features.map(f => {
                              const enrolled = (enrolledMap[f.id] || []).includes(s.slot);
                              const busy = featureBusy === `${f.id}:${s.slot}`;
                              return (
                                <div key={f.id} className={`flex items-center gap-2.5 p-2 rounded-lg border ${enrolled ? 'border-accent/30 bg-accent/[0.03]' : 'border-border-color bg-background'}`}>
                                  <label className="relative inline-flex items-center cursor-pointer flex-shrink-0">
                                    <input type="checkbox" checked={enrolled} disabled={busy}
                                      onChange={() => setFeatureConfirm({ action: enrolled ? 'unenroll' : 'enroll', feature: f, userNN: s.slot, name: s.name })}
                                      className="sr-only peer" />
                                    <div className="w-9 h-5 bg-gray-300 rounded-full peer peer-checked:bg-accent transition-colors relative">
                                      <div className={`absolute top-0.5 left-0.5 w-4 h-4 bg-white rounded-full transition-transform ${enrolled ? 'translate-x-4' : ''}`} />
                                    </div>
                                  </label>
                                  <div className="w-7 h-7 rounded-lg bg-gradient-to-br from-accent/10 to-purple-500/10 flex items-center justify-center text-sm flex-shrink-0">{f.emoji}</div>
                                  <div className="flex-1 min-w-0">
                                    <div className="text-xs font-semibold text-text-primary flex items-center gap-1.5">
                                      {f.name}
                                      {f.current_version && <span className="text-[10px] px-1.5 py-0.5 rounded bg-emerald-500/15 text-emerald-600 font-semibold">{f.current_version}</span>}
                                    </div>
                                    <div className="text-[11px] text-text-secondary truncate">{f.description}</div>
                                  </div>
                                  <span className={`text-[10px] px-2 py-0.5 rounded-full font-semibold flex-shrink-0 ${busy ? 'bg-amber-500/15 text-amber-600' : enrolled ? 'bg-emerald-500/15 text-emerald-600' : 'bg-gray-500/15 text-text-secondary'}`}>
                                    {busy ? '처리 중...' : enrolled ? '활성' : '미활성'}
                                  </span>
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
            {Array.from({ length: config?.totalSlots ?? 16 }, (_, i) => {
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
                {Array.from({ length: config?.totalSlots ?? 16 }, (_, i) => String(i + 1).padStart(2, '0')).map(nn => {
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

          {/* Anthropic 키 상태 카드
              ⚠ Moonshot 과 달리 잔액 조회 API 가 없다 → 금액 표시 불가, 살아있는지 + 분당 한도만.
                크레딧 소진이 429 가 아니라 400 으로 오므로 credit_exhausted 를 따로 표시. */}
          {moonshotKeys?.anthropic && (() => {
            const a = moonshotKeys.anthropic!;
            const tone =
              a.status === 'live' ? 'text-green-400 border-green-400/30 bg-green-400/5' :
              a.status === 'credit_exhausted' ? 'text-red-400 border-red-400/30 bg-red-400/5' :
              a.status === 'auth_error' ? 'text-red-400 border-red-400/30 bg-red-400/5' :
              a.status === 'rate_limit' ? 'text-yellow-400 border-yellow-400/30 bg-yellow-400/5' :
              'text-text-secondary border-border-color bg-background';
            const label =
              a.status === 'live' ? '✅ 정상' :
              a.status === 'credit_exhausted' ? '💳 크레딧 소진' :
              a.status === 'auth_error' ? '❌ 인증 실패' :
              a.status === 'rate_limit' ? '⚠️ 분당 한도 초과' :
              a.status === 'timeout' ? '⏱ 응답 없음' :
              a.status === 'network_error' ? '🔌 네트워크 오류' :
              a.status;
            return (
              <div className="bg-card border border-border-color rounded-xl p-5">
                <div className="flex items-center justify-between mb-4">
                  <h3 className="font-semibold text-text-primary flex items-center gap-2">
                    <Settings className="w-4 h-4" /> Anthropic (Claude)
                  </h3>
                  <button onClick={fetchMoonshotKeys} disabled={moonshotKeysLoading}
                    className="text-xs px-2 py-1 rounded border border-border-color hover:bg-background transition-colors disabled:opacity-50">
                    {moonshotKeysLoading ? '확인 중...' : '새로고침'}
                  </button>
                </div>
                <div className={`p-4 rounded-lg border ${tone}`}>
                  <div className="flex items-center justify-between mb-2">
                    <span className="text-sm font-semibold text-text-primary uppercase">API KEY</span>
                    <span className="text-xs">{label}</span>
                  </div>
                  <p className="text-xs font-mono text-text-secondary">{a.masked}</p>
                  {a.reason && <p className="text-[10px] mt-1 text-text-secondary/80 break-all">{a.reason}</p>}
                </div>
                <div className="mt-3 space-y-1 text-xs text-text-secondary">
                  {a.orgId && (
                    <p>조직 ID <span className="font-mono text-[10px] text-text-primary">{a.orgId}</span></p>
                  )}
                  {a.workspaceId && (
                    <p>워크스페이스 <span className="font-mono text-[10px] text-text-primary">{a.workspaceId}</span></p>
                  )}
                  {a.limits && (
                    <p>분당 한도 — 요청 {Number(a.limits.requests).toLocaleString()}
                      {a.limits.inputTokens && ` · 입력 ${Number(a.limits.inputTokens).toLocaleString()}`}
                      {a.limits.outputTokens && ` · 출력 ${Number(a.limits.outputTokens).toLocaleString()}`} 토큰</p>
                  )}
                  <p>
                    사용 중 —{' '}
                    {a.users && a.users.length > 0
                      ? <strong className="text-text-primary">{a.users.join(', ')}</strong>
                      : '없음 (primary 로 지정된 사용자 없음)'}
                  </p>
                  <p className="text-text-secondary/70">
                    Anthropic 은 잔액 조회 API 가 없어 금액은 표시할 수 없습니다. 크레딧이 떨어지면 위 상태가 <strong>크레딧 소진</strong>으로 바뀝니다.
                  </p>
                </div>

                {/* 최근 24h 실패 이력 — ping 은 현재 시점만 보므로 간헐적 실패는 여기서만 보인다 */}
                <div className="mt-4 pt-3 border-t border-border-color">
                  <div className="flex items-center justify-between mb-2">
                    <span className="text-xs font-semibold text-text-primary">최근 24시간 API 오류</span>
                    <span className={`text-xs ${a.errors && a.errors.count > 0 ? 'text-red-400' : 'text-green-400'}`}>
                      {a.errors ? `${a.errors.count}건` : '수집 불가'}
                      {a.errors?.lastAt && ` · 마지막 ${a.errors.lastAt.replace('T', ' ')}`}
                    </span>
                  </div>

                  {a.errors && a.errors.count > 0 ? (
                    <>
                      {a.errors.summary.length > 0 && (
                        <div className="mb-2 space-y-1">
                          {a.errors.summary.map((s, i) => (
                            <div key={i} className="flex items-start gap-2 text-[11px]">
                              <span className="text-red-400 font-semibold flex-shrink-0">{s.count}회</span>
                              <span className="text-text-secondary break-all">{s.message}</span>
                            </div>
                          ))}
                        </div>
                      )}
                      <div className="max-h-48 overflow-y-auto rounded border border-border-color bg-background">
                        <table className="w-full text-[10px]">
                          <thead className="sticky top-0 bg-background">
                            <tr className="text-text-secondary">
                              <th className="text-left p-1.5 font-semibold">시각</th>
                              <th className="text-left p-1.5 font-semibold">사용자</th>
                              <th className="text-left p-1.5 font-semibold">코드</th>
                              <th className="text-left p-1.5 font-semibold">메시지</th>
                            </tr>
                          </thead>
                          <tbody>
                            {a.errors.recent.map((e, i) => (
                              <tr key={i} className="border-t border-border-color/50">
                                <td className="p-1.5 font-mono text-text-secondary whitespace-nowrap">
                                  {e.time ? e.time.replace('T', ' ') : '-'}
                                </td>
                                <td className="p-1.5 text-text-primary whitespace-nowrap">{e.user}</td>
                                <td className="p-1.5 font-mono text-text-secondary">{e.httpCode || '-'}</td>
                                <td className="p-1.5 text-text-secondary break-all">{e.message}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                      <p className="text-[10px] text-text-secondary/70 mt-1">
                        최대 15건까지 표시 · 사용자별 컨테이너 로그에서 수집
                      </p>
                    </>
                  ) : (
                    <p className="text-[11px] text-text-secondary/70">
                      {a.errors ? '오류 없음 — 정상 동작 중입니다.' : '로그를 읽지 못했습니다.'}
                    </p>
                  )}
                </div>
              </div>
            );
          })()}

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

      {/* 기능 활성화/회수 확인 다이얼로그 */}
      {featureConfirm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={() => !featureBusy && setFeatureConfirm(null)}>
          <div className="bg-card border border-border-color rounded-2xl w-full max-w-md p-5 shadow-2xl" onClick={(e) => e.stopPropagation()}>
            <div className={`text-sm font-bold mb-2 ${featureConfirm.action === 'enroll' ? 'text-accent' : 'text-red-500'}`}>
              {featureConfirm.feature.emoji} {featureConfirm.feature.name} {featureConfirm.action === 'enroll' ? '활성화' : '회수'}
            </div>
            <div className="text-sm text-text-primary mb-3">
              <b>user{featureConfirm.userNN} ({featureConfirm.name || '?'})</b> 에게 {featureConfirm.feature.name} 기능을 {featureConfirm.action === 'enroll' ? '활성화' : '회수'}합니다.
            </div>
            {featureConfirm.action === 'enroll' ? (
              <div className="bg-background border border-border-color rounded-lg p-3 text-xs text-text-secondary mb-3">
                <div className="font-semibold text-text-primary mb-1">배포 내용:</div>
                <ul className="list-disc pl-4 space-y-0.5">
                  <li>사이드바에 {featureConfirm.feature.emoji} {featureConfirm.feature.name} 에이전트 추가</li>
                  <li>비서 위임 대상에 등록</li>
                  <li>중앙 SOUL 배포 ({featureConfirm.feature.current_version || 'latest'})</li>
                  <li>외부 연동에서 관련 데이터 등록 가능</li>
                </ul>
                <div className="mt-2 text-[10px]">⏱ 다운타임 없음 (openclaw 런타임 자동 반영)</div>
              </div>
            ) : (
              <div className="bg-red-500/10 border border-red-500/30 rounded-lg p-3 text-xs text-text-primary mb-3">
                <div className="font-semibold text-red-500 mb-1">회수 영향:</div>
                <ul className="list-disc pl-4 space-y-0.5">
                  <li>사이드바에서 즉시 사라짐</li>
                  <li>비서 위임 대상 제거</li>
                  <li>등록 데이터는 <code>business-report.archived-*</code> 로 이동 (복원 가능)</li>
                </ul>
              </div>
            )}
            <div className="flex justify-end gap-2">
              <button className="px-3 py-1.5 text-xs border border-border-color rounded-lg text-text-primary hover:bg-background" disabled={!!featureBusy} onClick={() => setFeatureConfirm(null)}>취소</button>
              <button
                className={`px-4 py-1.5 text-xs text-white font-semibold rounded-lg disabled:opacity-50 ${featureConfirm.action === 'enroll' ? 'bg-accent hover:bg-accent-hover' : 'bg-red-500 hover:bg-red-600'}`}
                onClick={executeFeatureAction}
                disabled={!!featureBusy}
              >
                {featureBusy ? '처리 중...' : (featureConfirm.action === 'enroll' ? '활성화' : '회수')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
