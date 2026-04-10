import { useState } from 'react';
import { Plus, ChevronRight, Trash2 } from 'lucide-react';
import type { Agent, Session } from '../types';

interface SidebarProps {
  agents: Agent[];
  sessions: Session[];
  currentSession: string | null;
  onSelectAgent: (agent: Agent) => void;
  onSelectSession: (session: Session) => void;
  onCreateSession: () => void;
  onDeleteSession?: (sessionKey: string) => void;
  currentAgentId?: string;
}

export function Sidebar({
  agents,
  sessions,
  currentSession,
  onSelectAgent,
  onSelectSession,
  onCreateSession,
  onDeleteSession,
  currentAgentId,
}: SidebarProps) {
  const [expandedAgents, setExpandedAgents] = useState<Set<string>>(new Set());

  const toggleAgentExpand = (agentId: string) => {
    setExpandedAgents(prev => {
      const next = new Set(prev);
      if (next.has(agentId)) next.delete(agentId); else next.add(agentId);
      return next;
    });
  };

  const getAgentForSession = (session: Session) => {
    if (session.agentId) return agents.find(a => a.id === session.agentId);
    const match = session.sessionKey.match(/^agent:([^:]+):/);
    if (match) return agents.find(a => a.id === match[1]);
    return null;
  };

  const formatDate = (dateStr?: string) => {
    if (!dateStr) return '';
    const date = new Date(dateStr);
    const now = new Date();
    const diff = now.getTime() - date.getTime();
    const mins = Math.floor(diff / 60000);
    if (mins < 1) return '지금';
    if (mins < 60) return `${mins}분`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return `${hours}시간`;
    const days = Math.floor(hours / 24);
    if (days === 1) return '어제';
    if (days < 7) return `${days}일 전`;
    return date.toLocaleDateString('ko-KR', { month: 'numeric', day: 'numeric' });
  };

  const filteredSessions = sessions.filter(s => {
    if (s.sessionKey.includes('subagent')) return false;
    // 멘션 호출용 임시 세션 (agent:xxx:mention-yyy) 은 사이드바에서 숨김
    if (/:mention-/.test(s.sessionKey)) return false;
    const label = s.label || '';
    if (label.includes('HEARTBEAT') || label.includes('heartbeat')) return false;
    return true;
  });

  // 날짜별 그룹화
  const getDateGroup = (dateStr?: string): string => {
    if (!dateStr) return '이전';
    const d = new Date(dateStr);
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const yesterday = new Date(today.getTime() - 86400000);
    const sessionDay = new Date(d.getFullYear(), d.getMonth(), d.getDate());

    if (sessionDay.getTime() === today.getTime()) return '오늘';
    if (sessionDay.getTime() === yesterday.getTime()) return '어제';

    const diffDays = Math.floor((today.getTime() - sessionDay.getTime()) / 86400000);
    if (diffDays < 7) return '이번 주';
    if (diffDays < 30) return `${d.getMonth() + 1}월`;
    return `${d.getFullYear()}.${d.getMonth() + 1}`;
  };

  // 그룹별로 묶기 (순서 유지)
  const groupedSessions: Array<{ group: string; items: typeof filteredSessions }> = [];
  for (const s of filteredSessions.slice(0, 50)) {
    const group = getDateGroup(s.lastMessageAt || s.createdAt);
    let bucket = groupedSessions.find(g => g.group === group);
    if (!bucket) {
      bucket = { group, items: [] };
      groupedSessions.push(bucket);
    }
    bucket.items.push(s);
  }

  const visibleAgents = agents.filter(a => !a.id.endsWith('-discord'));

  return (
    <div className="flex flex-col h-full">

      {/* ─── AGENT LIST (top section, scrollable) ─── */}
      <div className="flex-1 min-h-0 flex flex-col" style={{ flexBasis: '45%' }}>
        <div className="px-4 pt-4 pb-2 flex items-center justify-between flex-shrink-0">
          <span className="text-[11px] font-semibold uppercase tracking-widest text-text-secondary">에이전트</span>
          <button
            onClick={onCreateSession}
            className="w-6 h-6 rounded-md border border-dashed border-border-color flex items-center justify-center text-text-secondary/50 hover:border-accent hover:text-accent hover:bg-accent/5 transition-all"
            title="새 세션"
          >
            <Plus className="w-3 h-3" />
          </button>
        </div>
        <div className="flex-1 overflow-y-auto scrollbar-thin px-2 pb-2 space-y-0.5">
          {visibleAgents.length === 0 ? (
            <p className="text-text-secondary text-xs text-center py-4">불러오는 중...</p>
          ) : (
            visibleAgents.map(agent => (
              <div key={agent.id}>
                <button
                  onClick={() => onSelectAgent(agent)}
                  className={`w-full flex items-center gap-2.5 px-2.5 py-2 rounded-xl transition-all relative ${
                    currentAgentId === agent.id
                      ? 'bg-accent/8'
                      : 'hover:bg-accent/4'
                  }`}
                >
                  {/* Active bar */}
                  {currentAgentId === agent.id && (
                    <span className="absolute left-0 top-2 bottom-2 w-[2px] bg-accent rounded-r-full" />
                  )}

                  {/* Avatar */}
                  <div className="w-9 h-9 rounded-xl bg-card border border-border-color flex items-center justify-center text-lg flex-shrink-0 relative">
                    {agent.emoji || '🤖'}
                    {/* Status dot */}
                    <span className="absolute -bottom-0.5 -right-0.5 w-2.5 h-2.5 rounded-full border-2 border-card bg-green-500" />
                  </div>

                  {/* Info */}
                  <div className="flex-1 min-w-0 text-left">
                    <p className={`text-sm font-semibold truncate ${currentAgentId === agent.id ? 'text-accent' : 'text-text-primary'}`}>
                      {agent.name}
                    </p>
                    <p className="text-[11px] text-text-secondary truncate">
                      {agent.description || agent.model || ''}
                    </p>
                  </div>

                  {/* Expand button for subagents */}
                  {agent.subagents && agent.subagents.length > 0 && (
                    <button
                      onClick={(e) => { e.stopPropagation(); toggleAgentExpand(agent.id); }}
                      className="p-0.5 hover:bg-border-color rounded"
                    >
                      <ChevronRight className={`w-3.5 h-3.5 text-text-secondary transition-transform ${expandedAgents.has(agent.id) ? 'rotate-90' : ''}`} />
                    </button>
                  )}
                </button>

                {/* Subagents */}
                {expandedAgents.has(agent.id) && agent.subagents && (
                  <div className="ml-6 mt-0.5 space-y-0.5 border-l-2 border-border-color pl-2">
                    {agent.subagents.map(subagentId => {
                      const sub = agents.find(a => a.id === subagentId);
                      if (!sub) return null;
                      return (
                        <button key={sub.id} onClick={() => onSelectAgent(sub)}
                          className="w-full text-left px-2 py-1.5 rounded-lg hover:bg-accent/4 transition-colors flex items-center gap-2">
                          <span className="text-sm">{sub.emoji || '🔧'}</span>
                          <span className="text-xs text-text-secondary">{sub.name}</span>
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
            ))
          )}
        </div>
      </div>

      {/* ─── RECENT SESSIONS (bottom section, scrollable) ─── */}
      <div className="flex-1 min-h-0 flex flex-col border-t border-border-color" style={{ flexBasis: '55%' }}>
        <div className="px-4 pt-3 pb-2 flex-shrink-0">
          <span className="text-[11px] font-semibold uppercase tracking-widest text-text-secondary">최근 대화</span>
        </div>
        <div className="flex-1 overflow-y-auto scrollbar-thin px-2 pb-2">
          {filteredSessions.length === 0 ? (
            <p className="text-text-secondary text-xs text-center py-4">대화가 없습니다</p>
          ) : (
            groupedSessions.map(({ group, items }) => (
              <div key={group} className="mb-2">
                <div className="px-2.5 py-1.5 mt-1 mb-0.5 border-b border-border-color/40">
                  <span className="text-[10px] font-semibold text-text-secondary/70 uppercase tracking-wider">{group}</span>
                </div>
                <div className="space-y-0.5 mt-1">
                {items.map(session => {
              const agent = getAgentForSession(session);
              const isActive = currentSession === session.sessionKey;
              const key = session.sessionKey;
              const label = session.label || '';
              const derivedTitle = session.derivedTitle || '';

              // 노이즈 라벨 한 번 더 가드 (서버에서 정리되지 않은 경우)
              const trimmed = label.trim();
              const isNoise = !trimmed
                || trimmed.includes('untrusted')
                || trimmed.includes('Sender')
                || trimmed.includes('metadata')
                || trimmed.startsWith('[파일:')
                || /^[a-zA-Z0-9_-]{6,16}(\s*\(.*\))?$/i.test(trimmed);
              const isFileLabel = trimmed.startsWith('[파일:');
              const isSenderLabel = trimmed.startsWith('Sender') || trimmed.includes('untrusted');

              // 우선순위: 노이즈 아닌 label > derivedTitle > 날짜 fallback
              let displayName = '';
              if (!isNoise) {
                displayName = label;
              } else if (derivedTitle && !derivedTitle.includes('untrusted')) {
                displayName = derivedTitle;
              } else {
                const dateStr = session.lastMessageAt || session.createdAt;
                const d = dateStr ? new Date(dateStr) : new Date();
                const dateLabel = `${d.getMonth() + 1}월 ${d.getDate()}일 ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
                displayName = `${dateLabel} 대화`;
              }

              let badge = null;
              if (key.startsWith('cron:') || key.includes(':cron:')) {
                displayName = label.replace(/^\[cron:[^\]]*\]\s*/, '').replace(/^\[.*?\]\s*/g, '').trim() || '예약 작업';
                badge = <span className="text-[9px] px-1 py-0.5 rounded bg-amber-500/15 text-amber-600 font-medium">예약</span>;
              } else if (key.startsWith('discord:')) {
                displayName = '채팅';
                badge = <span className="text-[9px] px-1 py-0.5 rounded bg-indigo-500/15 text-indigo-600 font-medium">디스코드</span>;
              } else if (isFileLabel) {
                badge = <span className="text-[9px] px-1 py-0.5 rounded bg-sky-500/15 text-sky-600 font-medium">파일</span>;
              } else if (isSenderLabel) {
                badge = <span className="text-[9px] px-1 py-0.5 rounded bg-sky-500/15 text-sky-600 font-medium">채팅</span>;
              }

              return (
                <div
                  key={session.sessionKey}
                  className={`group flex items-center gap-2 px-2.5 py-2 rounded-lg cursor-pointer transition-all ${
                    isActive ? 'bg-accent/8 text-text-primary' : 'hover:bg-accent/4 text-text-secondary'
                  }`}
                  onClick={() => onSelectSession(session)}
                >
                  {/* Dot */}
                  <span className={`w-1 h-1 rounded-full flex-shrink-0 ${isActive ? 'bg-accent shadow-[0_0_4px_rgba(26,122,102,0.4)]' : 'bg-border-color'}`} />

                  {/* Text */}
                  <div className="flex-1 min-w-0">
                    <p className="text-xs truncate flex items-center gap-1">
                      {badge}
                      <span className={isActive ? 'text-text-primary font-medium' : ''}>{displayName}</span>
                    </p>
                  </div>

                  {/* Time + Delete */}
                  <div className="flex items-center gap-1 flex-shrink-0">
                    <span className="text-[10px] text-text-secondary/50 font-mono">{formatDate(session.lastMessageAt)}</span>
                    {onDeleteSession && (
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          if (confirm(`"${label || session.sessionKey}" 세션을 삭제하시겠습니까?`)) {
                            onDeleteSession(session.sessionKey);
                          }
                        }}
                        className="opacity-0 group-hover:opacity-100 p-0.5 text-text-secondary hover:text-red-500 transition-all rounded"
                        title="삭제"
                      >
                        <Trash2 className="w-3 h-3" />
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
                </div>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
