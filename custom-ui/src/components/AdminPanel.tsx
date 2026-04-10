import { useState, useEffect, useCallback } from 'react';
import { Users, Server, Activity, Settings, RefreshCw, UserPlus, UserMinus, RotateCcw, ChevronDown, ChevronRight, Cpu, HardDrive, Loader2, CheckCircle, XCircle, AlertTriangle } from 'lucide-react';

interface UserSlot {
  slot: string;
  email: string | null;
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

type AdminTab = 'users' | 'containers' | 'config';

function timeAgo(ts: number | null): string {
  if (!ts) return '-';
  const diff = Date.now() - ts;
  if (diff < 60000) return '방금 전';
  if (diff < 3600000) return `${Math.floor(diff / 60000)}분 전`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}시간 전`;
  return `${Math.floor(diff / 86400000)}일 전`;
}

export function AdminPanel() {
  const [tab, setTab] = useState<AdminTab>('users');
  const [slots, setSlots] = useState<UserSlot[]>([]);
  const [containers, setContainers] = useState<ContainerInfo[]>([]);
  const [stats, setStats] = useState<ContainerStats[]>([]);
  const [config, setConfig] = useState<{ apiKeys: Record<string, boolean>; totalSlots: number; usersAssigned: number; activeSessions: number } | null>(null);
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

  const fetchConfig = useCallback(async () => {
    try {
      const r = await fetch('/api/admin/config', { credentials: 'include' });
      const d = await r.json();
      if (d.ok) setConfig(d);
    } catch { /* ignore */ }
  }, []);

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
    if (tab === 'containers') { fetchContainers(); fetchStats(); }
  }, [tab]);

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
                      <span className="flex-1 text-sm text-text-primary">{s.email}</span>
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

      {/* Config Tab */}
      {tab === 'config' && config && (
        <div className="space-y-4">
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
