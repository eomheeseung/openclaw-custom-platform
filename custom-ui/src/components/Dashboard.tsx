import { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { Bot, CheckCircle, Activity, Clock, Zap, AlertCircle, HelpCircle } from 'lucide-react';
import type { Agent, Session, Message, ConnectionStatus, ProtocolFrame } from '../types';

interface DashboardProps {
  sendRequest: (method: string, params?: Record<string, unknown>) => Promise<ProtocolFrame>;
  agents: Agent[];
  sessions: Session[];
  messages: Message[];
  connectionStatus: ConnectionStatus;
  apiCallCount: number;
  onNavigateToChat?: (sessionKey: string) => void;
}

interface CronRun {
  id: string; jobId: string; jobName?: string;
  status: 'ok' | 'error' | 'skipped';
  startedAtMs: number; finishedAtMs?: number; error?: string;
}

interface ActivityEntry {
  id: string; timestamp: Date; emoji: string; agent: string; action: string;
  status: 'success' | 'in-progress' | 'error'; sessionKey?: string;
}

// --- Tooltip ---
function InfoTooltip({ text }: { text: string }) {
  const [show, setShow] = useState(false);
  return (
    <span className="relative inline-flex ml-1.5"
      onMouseEnter={() => setShow(true)} onMouseLeave={() => setShow(false)}>
      <HelpCircle className="w-3.5 h-3.5 text-text-secondary hover:text-text-primary cursor-help transition-colors" />
      {show && (
        <span className="fixed z-[9999] px-3.5 py-2.5 text-xs text-text-primary bg-white/95 border border-gray-600 rounded-lg shadow-2xl whitespace-pre-line w-64 leading-relaxed backdrop-blur-sm" style={{ top: 'var(--tt-y, 0)', left: 'var(--tt-x, 0)' }} ref={el => {
          if (el) {
            const rect = el.previousElementSibling?.getBoundingClientRect();
            if (rect) {
              el.style.top = `${rect.bottom + 8}px`;
              el.style.left = `${Math.max(8, Math.min(rect.left - 100, window.innerWidth - 270))}px`;
            }
          }
        }}>
          {text}
        </span>
      )}
    </span>
  );
}

function relativeTime(date: Date | string | undefined): string {
  if (!date) return '';
  const d = typeof date === 'string' ? new Date(date) : date;
  const diff = Date.now() - d.getTime();
  if (diff < 60000) return '방금';
  if (diff < 3600000) return `${Math.floor(diff / 60000)}분 전`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}시간 전`;
  return `${Math.floor(diff / 86400000)}일 전`;
}

function isToday(ms: number): boolean {
  const d = new Date(ms); const now = new Date();
  return d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
}

// Agent colors for variety
const AGENT_COLORS = ['#22d3ee', '#a78bfa', '#f472b6', '#34d399', '#fbbf24', '#fb923c', '#60a5fa', '#e879f9'];
function getAgentColor(index: number) { return AGENT_COLORS[index % AGENT_COLORS.length]; }

// --- Top Agent Status Bar ---
function AgentStatusBar({ agents, sessions }: { agents: Agent[]; sessions: Session[] }) {
  return (
    <div className="flex items-center gap-5 px-5 py-3 overflow-x-auto">
      {agents.filter(a => !a.id.endsWith('-discord')).map((agent, i) => {
        const state = getAgentState(agent.id, sessions);
        const color = getAgentColor(i);
        const stateLabel = state === 'active' ? '실행 중' : state === 'completed' ? '완료' : state === 'queued' ? '대기' : '유휴';
        const stateColor = state === 'active' ? '#22c55e' : state === 'completed' ? '#1a7a66' : state === 'queued' ? '#f97316' : '#9a958c';
        return (
          <div key={agent.id} className="flex items-center gap-2.5 flex-shrink-0">
            <span className="text-lg">{agent.emoji || '🤖'}</span>
            <div>
              <div className="flex items-center gap-2">
                <span className="text-sm font-semibold text-text-primary">{agent.name}</span>
                <span className="text-xs font-bold px-1.5 py-0.5 rounded" style={{ color: stateColor, background: `${stateColor}20` }}>{stateLabel}</span>
              </div>
              <div className="w-20 h-2 bg-[#e8e6e1] rounded-full overflow-hidden mt-0.5">
                <div className="h-full rounded-full transition-all duration-1000" style={{
                  width: state === 'idle' ? '0%' : '100%',
                  backgroundColor: stateColor,
                  boxShadow: state === 'active' ? `0 0 8px ${stateColor}` : 'none'
                }} />
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

// --- Agent status helper ---
type AgentState = 'active' | 'completed' | 'queued' | 'idle';
function getAgentState(agentId: string, sessions: Session[]): AgentState {
  const agentSessions = sessions.filter(s => s.agentId === agentId);
  if (agentSessions.length === 0) return 'idle';
  // 세션이 있지만 lastMessageAt이 없으면 queued (스폰됐지만 아직 활동 없음)
  const withActivity = agentSessions.filter(s => s.lastMessageAt);
  if (withActivity.length === 0) return 'queued';
  const latest = Math.max(...withActivity.map(s => new Date(s.lastMessageAt!).getTime()));
  const diff = Date.now() - latest;
  if (diff < 60000) return 'active';      // 1분 이내 = 실행 중
  if (diff < 600000) return 'completed';   // 10분 이내 = 완료
  return 'idle';
}

// --- Center Network Graph ---
function NetworkGraph({ agents, sessions }: { agents: Agent[]; sessions: Session[] }) {
  const agentStates = useMemo(() => {
    const map = new Map<string, AgentState>();
    for (const a of agents) map.set(a.id, getAgentState(a.id, sessions));
    return map;
  }, [agents, sessions]);

  // -discord 에이전트 제외
  const visibleAgents = agents.filter(a => !a.id.endsWith('-discord'));
  if (visibleAgents.length === 0) return null;

  const rootAgent = visibleAgents.find(a => a.default);
  const childAgents = visibleAgents.filter(a => !a.default);

  const W = 700; const H = 560;
  const CX = W / 2; const CY = H / 2; const R = 200;

  // 하위 에이전트를 원형으로 배치, 루트는 중앙
  const nodes = childAgents.map((a, i) => {
    const angle = (i / childAgents.length) * Math.PI * 2 - Math.PI / 2;
    const state = agentStates.get(a.id) || 'idle';
    return {
      id: a.id, x: CX + Math.cos(angle) * R, y: CY + Math.sin(angle) * R,
      emoji: a.emoji || '\u{1F916}', name: a.name, active: state === 'active', state,
      color: getAgentColor(i),
    };
  });

  const rootState = rootAgent ? (agentStates.get(rootAgent.id) || 'idle') : 'idle';
  const rootActive = rootState === 'active';

  return (
    <div className="relative w-full h-full flex items-center justify-center">
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-full" style={{ maxHeight: '100%' }}>
        <defs>
          <filter id="neon-glow" x="-100%" y="-100%" width="300%" height="300%">
            <feGaussianBlur stdDeviation="8" result="blur" />
            <feMerge><feMergeNode in="blur" /><feMergeNode in="blur" /><feMergeNode in="SourceGraphic" /></feMerge>
          </filter>
          <filter id="soft-glow" x="-50%" y="-50%" width="200%" height="200%">
            <feGaussianBlur stdDeviation="3" result="blur" />
            <feMerge><feMergeNode in="blur" /><feMergeNode in="SourceGraphic" /></feMerge>
          </filter>
          <radialGradient id="center-aura">
            <stop offset="0%" stopColor="#1a7a66" stopOpacity="0.12" />
            <stop offset="60%" stopColor="#3b82f6" stopOpacity="0.05" />
            <stop offset="100%" stopColor="transparent" stopOpacity="0" />
          </radialGradient>
        </defs>

        {/* Background grid */}
        {Array.from({ length: 24 }).map((_, i) =>
          Array.from({ length: 19 }).map((_, j) =>
            <circle key={`g-${i}-${j}`} cx={i * 30 + 5} cy={j * 30 + 5} r="0.6" fill="#e0ddd6" />
          )
        )}

        {/* Center aura */}
        <circle cx={CX} cy={CY} r={R + 60} fill="url(#center-aura)" />

        {/* Orbit ring */}
        <circle cx={CX} cy={CY} r={R} fill="none" stroke="#e0ddd6" strokeWidth="1.5" />
        <circle cx={CX} cy={CY} r={R} fill="none" stroke="#1a7a66" strokeWidth="0.5" opacity="0.15" strokeDasharray="6 12" />

        {/* Lines from center to nodes */}
        {nodes.map(n => {
          const alive = n.state !== 'idle';
          return (
            <line key={`rad-${n.id}`} x1={CX} y1={CY} x2={n.x} y2={n.y}
              stroke={n.active ? n.color : alive ? '#1a7a66' : '#e0ddd6'}
              strokeWidth={n.active ? 1.5 : alive ? 0.8 : 0.5}
              opacity={n.active ? 0.4 : alive ? 0.25 : 0.15} />
          );
        })}

        {/* Active data flow animation */}
        {nodes.filter(n => n.active).map(n => (
          <circle key={`flow-${n.id}`} r="3" fill="#1a7a66" opacity="0.9" filter="url(#soft-glow)">
            <animateMotion dur="2.5s" repeatCount="indefinite"
              path={`M${CX},${CY} L${n.x},${n.y}`} />
          </circle>
        ))}

        {/* Center node — 비서(팀장) */}
        <circle cx={CX} cy={CY} r="46" fill="#f0eeea" stroke={rootActive ? '#22d3ee' : '#22d3ee'} strokeWidth="2" filter="url(#neon-glow)" />
        {rootActive && (
          <circle cx={CX} cy={CY} r="46" fill="none" stroke="#1a7a66" strokeWidth="1.5" opacity="0.4">
            <animate attributeName="r" values="46;54;46" dur="1.5s" repeatCount="indefinite" />
            <animate attributeName="opacity" values="0.4;0.1;0.4" dur="1.5s" repeatCount="indefinite" />
          </circle>
        )}
        <text x={CX} y={CY - 2} textAnchor="middle" fontSize="30">{rootAgent?.emoji || '\u{1F916}'}</text>
        <text x={CX} y={CY + 66} textAnchor="middle" fontSize="14" fill="#1a7a66" fontWeight="700">{rootAgent?.name || 'TEAM LEAD'}</text>

        {/* Agent nodes */}
        {nodes.map(n => {
          const isActive = n.state === 'active';
          const isCompleted = n.state === 'completed';
          const isQueued = n.state === 'queued';
          const isIdle = n.state === 'idle';
          const strokeColor = isActive ? n.color : isCompleted ? '#1a7a66' : isQueued ? '#f97316' : '#ccc8c0';
          const strokeW = isActive ? 2.5 : isCompleted ? 2 : isQueued ? 2 : 1.5;
          const nodeFilter = isActive ? 'url(#neon-glow)' : isCompleted ? 'url(#soft-glow)' : isQueued ? 'url(#soft-glow)' : undefined;

          return (
            <g key={n.id}>
              {isActive && (
                <>
                  <circle cx={n.x} cy={n.y} r="44" fill="none" stroke={n.color} strokeWidth="1.5" opacity="0.4">
                    <animate attributeName="r" values="40;50;40" dur="1.5s" repeatCount="indefinite" />
                    <animate attributeName="opacity" values="0.5;0.1;0.5" dur="1.5s" repeatCount="indefinite" />
                  </circle>
                  <circle r="2" fill={n.color} opacity="0.8">
                    <animateMotion dur="2s" repeatCount="indefinite" path={`M${n.x},${n.y - 42} A42,42 0 1,1 ${n.x - 0.01},${n.y - 42}`} />
                  </circle>
                </>
              )}
              {isCompleted && (
                <circle cx={n.x} cy={n.y} r="42" fill="none" stroke="#1a7a66" strokeWidth="1" opacity="0.3">
                  <animate attributeName="opacity" values="0.3;0.15;0.3" dur="3s" repeatCount="indefinite" />
                </circle>
              )}
              {isQueued && (
                <circle cx={n.x} cy={n.y} r="42" fill="none" stroke="#c94a35" strokeWidth="1" opacity="0.4">
                  <animate attributeName="opacity" values="0.4;0.15;0.4" dur="2s" repeatCount="indefinite" />
                </circle>
              )}
              <circle cx={n.x} cy={n.y} r="36" fill={isActive ? '#e8f5f0' : isCompleted ? '#eef0ff' : isQueued ? '#fef5ee' : '#ffffff'}
                stroke={strokeColor} strokeWidth={strokeW} filter={nodeFilter} />
              <text x={n.x} y={n.y + 8} textAnchor="middle" fontSize="26" opacity={isIdle ? 0.5 : 1}>{n.emoji}</text>
              <text x={n.x} y={n.y + 56} textAnchor="middle" fontSize="13" fill={isIdle ? '#9a958c' : '#e2e8f0'} fontWeight="600">{n.name}</text>
              {isActive && (
                <circle cx={n.x - 26} cy={n.y - 26} r="6" fill="#22c55e">
                  <animate attributeName="opacity" values="1;0.3;1" dur="1s" repeatCount="indefinite" />
                </circle>
              )}
              {isCompleted && (
                <g>
                  <circle cx={n.x - 26} cy={n.y - 26} r="8" fill="#1a7a66" />
                  <text x={n.x - 26} y={n.y - 22} textAnchor="middle" fontSize="10" fill="white">✓</text>
                </g>
              )}
              {isQueued && (
                <g>
                  <circle cx={n.x - 26} cy={n.y - 26} r="8" fill="#c94a35" />
                  <text x={n.x - 26} y={n.y - 22} textAnchor="middle" fontSize="9" fill="white">⏳</text>
                </g>
              )}
            </g>
          );
        })}
      </svg>
    </div>
  );
}

// --- Left: Active Workflows ---
function ActiveWorkflows({ sessions, agents, onClickSession }: { sessions: Session[]; agents: Agent[]; onClickSession?: (key: string) => void }) {
  const agentMap = useMemo(() => new Map(agents.map(a => [a.id, a])), [agents]);

  const recentSessions = useMemo(() => {
    return [...sessions]
      .filter(s => s.lastMessageAt && !s.sessionKey.includes('subagent') && !(s.label || '').includes('HEARTBEAT'))
      .sort((a, b) => new Date(b.lastMessageAt!).getTime() - new Date(a.lastMessageAt!).getTime())
      .slice(0, 8);
  }, [sessions]);

  return (
    <div className="flex flex-col h-full">
      <h3 className="text-sm font-bold text-accent uppercase tracking-widest mb-4 flex items-center gap-2">
        <Zap className="w-4 h-4" /> Active Workflows
        <span className="text-xs font-normal text-text-secondary ml-1">{recentSessions.length}</span>
        <InfoTooltip text={"현재 진행 중인 에이전트 세션입니다.\n\n• 초록색 = 1분 이내 활동 (실행 중)\n• 회색 = 대기 중\n\n채팅 탭에서 에이전트에게 작업을 지시하면 여기에 표시됩니다."} />
      </h3>
      <div className="flex-1 overflow-y-auto scrollbar-thin space-y-2.5 pr-1">
        {recentSessions.length === 0 ? (
          <div className="text-center py-12">
            <Bot className="w-10 h-10 mx-auto text-text-secondary mb-2" />
            <p className="text-sm text-text-secondary">활성 작업 없음</p>
          </div>
        ) : recentSessions.map((s, i) => {
          const agent = s.agentId ? agentMap.get(s.agentId) : null;
          const timeDiff = s.lastMessageAt ? Date.now() - new Date(s.lastMessageAt).getTime() : Infinity;
          const state: AgentState = timeDiff < 60000 ? 'active' : timeDiff < 600000 ? 'completed' : 'idle';
          const color = getAgentColor(agents.findIndex(a => a.id === s.agentId));
          const borderColor = state === 'active' ? color : state === 'completed' ? '#1a7a66' : '#ccc8c0';
          const bgClass = state === 'active' ? 'bg-white/[0.03]' : state === 'completed' ? 'bg-blue-500/[0.02]' : 'bg-transparent';

          return (
            <div key={s.sessionKey} onClick={() => onClickSession?.(s.sessionKey)} className={`p-3 rounded-xl border-l-[3px] transition-all cursor-pointer hover:bg-accent/5 ${bgClass}`} style={{ borderLeftColor: borderColor }}>
              <div className="flex items-center gap-2 mb-1.5">
                <span className="text-lg">{agent?.emoji || '🤖'}</span>
                <span className="text-sm font-bold text-text-primary">{agent?.name || '알 수 없음'}</span>
                <span className={`ml-auto text-xs px-2 py-0.5 rounded-full font-medium ${
                  state === 'active' ? 'text-accent bg-emerald-500/10' :
                  state === 'completed' ? 'text-accent bg-blue-500/10' :
                  'text-text-secondary bg-[#e8e6e1]'
                }`}>
                  {state === 'active' ? '실행 중' : state === 'completed' ? '✓ 완료' : '대기'}
                </span>
              </div>
              <p className="text-sm text-text-primary truncate mb-2">{(() => {
                const key = s.sessionKey;
                const raw = s.derivedTitle || s.label || '';
                // 세션 타입별 라벨 변환
                if (key.startsWith('cron:') || key.includes(':cron:')) {
                  const cleaned = raw.replace(/^\[cron:[^\]]*\]\s*/, '').replace(/^\[.*?\]\s*/g, '').trim();
                  return `[예약] ${cleaned || '예약 작업'}`;
                }
                if (key.startsWith('discord:')) return '[디스코드] 채팅';
                if (raw.startsWith('Sender (untrusted')) return '[채팅] 대화';
                if (raw.includes('HEARTBEAT')) return '[시스템] 하트비트';
                const cleaned = raw.replace(/^\[.*?\]\s*/g, '').replace(/^[a-f0-9]{6,}\s*\(\d{4}-\d{2}-\d{2}\)\s*/i, '').trim();
                const display = cleaned || raw;
                return display.length > 30 ? display.slice(0, 30) + '...' : display || '작업 중...';
              })()}</p>
              <div className="flex items-center justify-between">
                <span className="text-xs text-text-secondary">{relativeTime(s.lastMessageAt)}</span>
                {state === 'active' && (
                  <div className="w-24 h-1.5 bg-[#e8e6e1] rounded-full overflow-hidden">
                    <div className="h-full rounded-full" style={{ width: '65%', backgroundColor: color, boxShadow: `0 0 6px ${color}` }}>
                      <div className="h-full bg-white/20 animate-pulse rounded-full" />
                    </div>
                  </div>
                )}
                {state === 'completed' && (
                  <span className="text-xs text-blue-400">
                    {timeDiff < 60000 ? '방금' : `${Math.floor(timeDiff / 60000)}분 전 완료`}
                  </span>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// --- Right: Activity Log ---
function ActivityLog({ feed, cronRuns, onClickEntry, onClear }: { feed: ActivityEntry[]; cronRuns: CronRun[]; onClickEntry?: (sessionKey: string) => void; onClear?: () => void }) {
  const allItems = useMemo(() => {
    const cronEntries: ActivityEntry[] = cronRuns.slice(0, 5).map(r => ({
      id: `cron-${r.id}`, timestamp: new Date(r.startedAtMs), emoji: '⏰',
      agent: r.jobName || '예약 작업',
      action: r.status === 'ok' ? '작업 완료' : '오류 발생',
      status: r.status === 'ok' ? 'success' as const : 'error' as const,
    }));
    return [...feed, ...cronEntries].sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime()).slice(0, 30);
  }, [feed, cronRuns]);

  const statusStyles = {
    'success': { dot: 'bg-emerald-400', text: 'text-accent', border: 'border-l-emerald-400' },
    'in-progress': { dot: 'bg-amber-400', text: 'text-amber-300', border: 'border-l-amber-400' },
    'error': { dot: 'bg-red-400', text: 'text-red-300', border: 'border-l-red-400' },
  };

  return (
    <div className="flex flex-col h-full">
      <h3 className="text-sm font-bold text-amber-400 uppercase tracking-widest mb-4 flex items-center gap-2">
        <Activity className="w-4 h-4" /> Activity Log
        <span className="text-xs font-normal text-text-secondary ml-1">{allItems.length}</span>
        <InfoTooltip text={"에이전트의 실시간 활동 기록입니다.\n\n• 초록 = 작업 완료\n• 노랑 = 진행 중\n• 빨강 = 오류 발생\n\n예약 작업(Cron)과 채팅 응답이 자동으로 기록됩니다."} />
        {allItems.length > 0 && onClear && (
          <button
            onClick={() => { if (confirm('액티비티 로그를 모두 삭제하시겠습니까?')) onClear(); }}
            className="ml-auto text-xs text-text-secondary hover:text-red-400 transition-colors"
            title="로그 정리"
          >
            정리
          </button>
        )}
      </h3>
      <div className="flex-1 overflow-y-auto scrollbar-thin space-y-1 pr-1">
        {allItems.length === 0 ? (
          <div className="text-center py-12">
            <Activity className="w-10 h-10 mx-auto text-text-secondary mb-2" />
            <p className="text-sm text-text-secondary">활동 없음</p>
          </div>
        ) : allItems.map((entry, i) => {
          const style = statusStyles[entry.status];
          return (
            <div key={entry.id} className={`flex items-start gap-3 py-2 px-2.5 rounded-lg border-l-2 ${style.border} ${i === 0 ? 'animate-fade-slide-in bg-white/[0.02]' : ''} ${entry.sessionKey ? 'cursor-pointer hover:bg-white/[0.04]' : ''}`} onClick={() => entry.sessionKey && onClickEntry?.(entry.sessionKey)}>
              <span className="text-xs text-text-secondary w-14 flex-shrink-0 font-mono pt-0.5">
                {isNaN(entry.timestamp.getTime()) ? '' : entry.timestamp.toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' })}
              </span>
              <span className="text-base flex-shrink-0">{entry.emoji}</span>
              <div className="min-w-0 flex-1">
                <span className={`text-sm font-semibold ${style.text}`}>{entry.agent}</span>
                <p className="text-sm text-text-secondary truncate">{entry.action}</p>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// --- Bottom Stats Bar ---
function BottomStats({ agents, sessions, todayCompleted, apiCallCount, connected }: {
  agents: Agent[]; sessions: Session[]; todayCompleted: number; apiCallCount: number; connected: boolean;
}) {
  const [time, setTime] = useState(new Date());
  useEffect(() => { const t = setInterval(() => setTime(new Date()), 1000); return () => clearInterval(t); }, []);

  return (
    <div className="flex items-center justify-between px-5 py-2.5 border-t border-gray-800/50 bg-gray-900/30">
      <div className="flex items-center gap-6">
        <div className="flex items-center gap-2">
          <Bot className="w-4 h-4 text-blue-400" />
          <span className="text-sm text-text-primary font-medium">{agents.filter(a => !a.id.endsWith('-discord')).length} 에이전트</span>
        </div>
        <div className="flex items-center gap-2">
          <CheckCircle className="w-4 h-4 text-accent" />
          <span className="text-sm text-text-primary font-medium">{todayCompleted} 완료</span>
        </div>
        <div className="flex items-center gap-2">
          <Zap className="w-4 h-4 text-amber-400" />
          <span className="text-sm text-text-primary font-medium">{apiCallCount} API</span>
          <InfoTooltip text="이 세션에서 발생한 총 API 호출 수입니다." />
        </div>
      </div>
      <div className="flex items-center gap-3">
        <span className={`w-2.5 h-2.5 rounded-full ${connected ? 'bg-emerald-400 animate-pulse' : 'bg-red-400'}`} />
        <span className="text-sm text-text-secondary font-mono">
          {time.toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
        </span>
      </div>
    </div>
  );
}

// --- Main Dashboard ---
export function Dashboard({ sendRequest, agents, sessions: propSessions, messages, connectionStatus, apiCallCount, onNavigateToChat }: DashboardProps) {
  const [cronRuns, setCronRuns] = useState<CronRun[]>([]);
  const [activityFeed, setActivityFeed] = useState<ActivityEntry[]>(() => {
    try {
      const saved = localStorage.getItem('tideclaw-activity-log');
      if (saved) {
        const parsed = JSON.parse(saved) as ActivityEntry[];
        // timestamp를 Date로 복원 + 오래된 in-progress를 자동 완료 처리
        return parsed.map(e => {
          const entry = { ...e, timestamp: new Date(e.timestamp) };
          // 5분 이상 지난 in-progress는 완료로 전환
          if (entry.status === 'in-progress' && Date.now() - entry.timestamp.getTime() > 300000) {
            entry.status = 'success';
            if (entry.emoji === '🔄') entry.emoji = '✅';
          }
          return entry;
        });
      }
    } catch { /* ignore */ }
    return [];
  });
  const [liveSessions, setLiveSessions] = useState<Session[]>([]);
  const prevMessageCount = useRef(0);

  // activityFeed 변경 시 localStorage에 저장
  useEffect(() => {
    try {
      localStorage.setItem('tideclaw-activity-log', JSON.stringify(activityFeed));
    } catch { /* ignore */ }
  }, [activityFeed]);

  // Use live-polled sessions (more up-to-date than props)
  const sessions = liveSessions.length > 0 ? liveSessions : propSessions;

  const fetchSessions = useCallback(async () => {
    try {
      const res = await sendRequest('sessions.list', { limit: 50, activeMinutes: 1440, includeLastMessage: true, includeDerivedTitles: true });
      const payload = (res as { payload?: Record<string, unknown> }).payload;
      if (payload?.sessions) {
        const list = (payload.sessions as Array<{ key: string; agentId?: string; label?: string; lastMessageAt?: number; updatedAt?: number; messageCount?: number; derivedTitle?: string }>).map(s => {
          // agentId가 없으면 key에서 추출: "agent:developer:main" → "developer"
          const extractedAgentId = s.agentId || (s.key.startsWith('agent:') ? s.key.split(':')[1] : undefined);
          // lastMessageAt 없으면 updatedAt 사용
          const ts = s.lastMessageAt || s.updatedAt;
          return {
          sessionKey: s.key, agentId: extractedAgentId, label: s.derivedTitle || s.label || s.key,
          lastMessageAt: ts ? new Date(ts).toISOString() : undefined,
          messageCount: s.messageCount, derivedTitle: s.derivedTitle,
        }; });
        setLiveSessions(list);
      }
    } catch { /* ignore */ }
  }, [sendRequest]);

  const fetchCronRuns = useCallback(async () => {
    try {
      const res = await sendRequest('cron.runs', { scope: 'all', limit: 10, sortDir: 'desc' });
      const payload = (res as { payload?: Record<string, unknown> }).payload;
      setCronRuns((payload?.entries || []) as CronRun[]);
    } catch { /* ignore */ }
  }, [sendRequest]);

  // Poll sessions every 10s, cron every 30s
  useEffect(() => {
    fetchSessions(); fetchCronRuns();
    const t1 = setInterval(fetchSessions, 10000);
    const t2 = setInterval(fetchCronRuns, 30000);
    return () => { clearInterval(t1); clearInterval(t2); };
  }, [fetchSessions, fetchCronRuns]);

  useEffect(() => {
    if (messages.length <= prevMessageCount.current) { prevMessageCount.current = messages.length; return; }
    const newMsgs = messages.slice(prevMessageCount.current);
    prevMessageCount.current = messages.length;
    // 에이전트 이름/이모지 매핑 헬퍼
    const agentMap = new Map(agents.map(a => [a.id, a]));
    const findAgentInText = (text: string) => {
      for (const a of agents) {
        const name = a.name || a.id;
        if (text.includes(name) || text.includes(a.id)) return a;
      }
      return null;
    };
    // 현재 세션의 에이전트 — 여러 방법으로 찾기
    const currentSessionKey = propSessions[0]?.sessionKey;
    const currentAgent = sessions.find(s => s.sessionKey === currentSessionKey)?.agentId;
    const defaultAgent = agents.find(a => a.default);
    const mainAgent = currentAgent ? agentMap.get(currentAgent) : defaultAgent || null;

    const entries: ActivityEntry[] = [];
    const seenIds = new Set<string>();
    for (const msg of newMsgs) {
      if (seenIds.has(msg.id)) continue;
      seenIds.add(msg.id);

      // spawn JSON, NO_REPLY, HEARTBEAT 무시
      if (msg.content.includes('"status": "accepted"') || msg.content.includes('"modelApplied"')) continue;
      if (msg.content.trim() === 'NO_REPLY' || msg.content.trim() === 'HEARTBEAT_OK') continue;
      if (msg.content.includes('HEARTBEAT') || msg.content.includes('heartbeat') || msg.content.includes('Read HEARTBEAT.md')) continue;

      if (msg.role === 'assistant' && !msg.isLoading) {
        if (msg.content.trim().length > 5) {
          // 세션의 실제 agentId 기반으로 표시 (메시지 내용 기반 X)
          const agentEmoji = mainAgent?.emoji || '🤖';
          const agentName = mainAgent?.name || '에이전트';
          // 디스코드 멘션 ID를 이름으로 변환
          let actionText = msg.content.length > 50 ? msg.content.slice(0, 50) + '...' : msg.content;
          actionText = actionText.replace(/<@(\d+)>/g, (_, id) => {
            const found = agents.find(a => a.name === id || a.id === id);
            return found ? `@${found.name}` : `@${id.slice(-4)}`;
          });
          entries.push({ id: `m-${msg.id}`, timestamp: msg.timestamp, emoji: agentEmoji, agent: agentName, action: actionText, status: 'success', sessionKey: currentSessionKey });
        }
      } else if (msg.role === 'assistant' && msg.isLoading) {
        const agentEmoji = mainAgent?.emoji || '🤖';
        const agentName = mainAgent?.name || '에이전트';
        entries.push({ id: `m-${msg.id}`, timestamp: msg.timestamp, emoji: agentEmoji, agent: agentName, action: '응답 생성 중...', status: 'in-progress', sessionKey: currentSessionKey });
      } else if (msg.role === 'system') {
        if (msg.content.includes('subagent') || msg.content.includes('서브에이전트') || msg.content.includes('completion')) {
          const isComplete = msg.content.includes('completed') || msg.content.includes('완료') || msg.content.includes('결과');
          // agentId를 세션키에서 추출 (agent:finance:subagent:xxx → finance, 또는 agent:xxx: 패턴)
          const agentMatch = msg.content.match(/agent:([^:\s"]+)(?::subagent|:)/);
          const detectedId = agentMatch ? agentMatch[1] : null;
          // agentMap에서 찾기, 없으면 에이전트 이름/id로 텍스트 검색
          let detected = detectedId ? agentMap.get(detectedId) : null;
          if (!detected) {
            for (const a of agents) {
              if (msg.content.includes(a.name) || msg.content.includes(a.id)) { detected = a; break; }
            }
          }
          const agentEmoji = detected?.emoji || (isComplete ? '✅' : '🔄');
          const agentName = detected?.name || '서브에이전트';
          const actionText = isComplete ? `${agentName} 작업 완료` : `${agentName} 호출`;
          // 세션키 추출 시도: agent:xxx:subagent:yyy 패턴
          const sessionKeyMatch = msg.content.match(/(agent:[^\s"]+)/);
          const subSessionKey = sessionKeyMatch ? sessionKeyMatch[1] : currentSessionKey;
          entries.push({ id: `m-${msg.id}`, timestamp: msg.timestamp, emoji: agentEmoji, agent: agentName, action: actionText, status: isComplete ? 'success' : 'in-progress', sessionKey: subSessionKey });
        }
      }
    }
    if (entries.length) {
      setActivityFeed(prev => {
        const updated = [...prev];

        // 에이전트 완료 응답이 있으면 → 이전 시스템 "호출" in-progress를 완료로 변경
        const hasCompletedAgent = entries.some(e => e.status === 'success' && e.agent === '에이전트');
        if (hasCompletedAgent) {
          for (let i = 0; i < updated.length; i++) {
            if (updated[i].agent === '시스템' && updated[i].status === 'in-progress') {
              updated[i] = { ...updated[i], status: 'success', emoji: '✅' };
            }
          }
          // "응답 생성 중" in-progress도 완료 처리
          for (let i = 0; i < updated.length; i++) {
            if (updated[i].agent === '에이전트' && updated[i].status === 'in-progress') {
              updated[i] = { ...updated[i], status: 'success' };
            }
          }
        }

        for (const entry of entries) {
          const existIdx = updated.findIndex(e => e.id === entry.id);
          if (existIdx >= 0) {
            updated[existIdx] = entry;
          } else {
            updated.unshift(entry);
          }
        }
        return updated.slice(0, 50);
      });
    }
  }, [messages]);

  const todayCompleted = useMemo(() => cronRuns.filter(r => r.status === 'ok' && isToday(r.startedAtMs)).length, [cronRuns]);

  return (
    <div className="h-full flex flex-col overflow-hidden" style={{ background: 'linear-gradient(180deg, #f7f6f3 0%, #f0eeea 50%, #f7f6f3 100%)' }}>
      {/* Top bar */}
      <div className="border-b border-gray-800/50">
        <div className="flex items-center justify-between px-5 py-2">
          <div className="flex items-center gap-3">
            <span className="text-sm font-black text-accent tracking-widest">TIDECLAW</span>
            <InfoTooltip text="에이전트별 활동률을 보여줍니다.\n최근 1시간 내 활성 세션 비율로 계산됩니다." />
            <span className="text-xs font-bold text-accent bg-emerald-500/10 px-2 py-0.5 rounded">LIVE</span>
            <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
          </div>
          <span className="text-sm text-text-secondary font-mono">
            {new Date().toLocaleDateString('ko-KR')} {new Date().toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' })}
          </span>
        </div>
        <AgentStatusBar agents={agents} sessions={sessions} />
      </div>

      {/* Main 3-column */}
      <div className="flex-1 flex overflow-hidden">
        {/* Left panel */}
        <div className="w-72 xl:w-80 border-r border-gray-800/30 p-4 flex-shrink-0 overflow-hidden">
          <ActiveWorkflows sessions={sessions} agents={agents} onClickSession={onNavigateToChat} />
        </div>

        {/* Center graph */}
        <div className="flex-1 p-3 overflow-hidden relative">
          <div className="absolute top-4 left-4 z-10 flex items-center gap-1">
            <span className="text-xs font-bold text-accent uppercase tracking-widest">Network</span>
            <InfoTooltip text={"에이전트 간 연결 관계를 보여줍니다.\n\n• 초록 테두리 = 현재 활성\n• 파란 라인 = 서브에이전트 연결\n• 움직이는 점 = 데이터 전송 중\n• ⏳ = 대기 중 (queued)\n\n채팅에서 에이전트에게 작업을 시키면 노드가 활성화됩니다."} />
          </div>
          <NetworkGraph agents={agents} sessions={sessions} />
        </div>

        {/* Right panel */}
        <div className="w-80 xl:w-96 border-l border-gray-800/30 p-4 flex-shrink-0 overflow-hidden">
          <ActivityLog feed={activityFeed} cronRuns={cronRuns} onClickEntry={onNavigateToChat} onClear={() => { setActivityFeed([]); localStorage.removeItem('tideclaw-activity-log'); }} />
        </div>
      </div>

    </div>
  );
}
