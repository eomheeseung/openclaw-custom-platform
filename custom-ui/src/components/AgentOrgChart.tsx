import { Network, Bot, Users, ChevronRight, GitBranch } from 'lucide-react';
import type { Agent } from '../types';

interface AgentOrgChartProps {
  agents: Agent[];
  onSelectAgent: (agent: Agent) => void;
}

export function AgentOrgChart({ agents, onSelectAgent }: AgentOrgChartProps) {
  // Find root agents (agents that are not subagents of any other agent)
  const subagentIds = new Set(agents.flatMap(a => a.subagents || []));
  const rootAgents = agents.filter(a => !subagentIds.has(a.id));

  const getSubagents = (agentId: string): Agent[] => {
    const agent = agents.find(a => a.id === agentId);
    if (!agent?.subagents) return [];
    return agent.subagents
      .map(id => agents.find(a => a.id === id))
      .filter((a): a is Agent => a !== undefined);
  };

  const renderAgentCard = (agent: Agent, level: number = 0) => {
    const subagents = getSubagents(agent.id);
    const hasSubagents = subagents.length > 0;

    return (
      <div key={agent.id} className={`${level > 0 ? 'ml-8 mt-4' : ''}`}>
        {/* Connection line */}
        {level > 0 && (
          <div className="absolute -left-6 top-8 w-6 h-px bg-border-color" />
        )}
        
        <div className="relative">
          <button
            onClick={() => onSelectAgent(agent)}
            className="w-full text-left p-4 bg-card border border-border-color rounded-xl hover:border-accent hover:shadow-lg hover:shadow-accent/10 transition-all group"
          >
            <div className="flex items-start gap-4">
              {/* Emoji/Icon */}
              <div className="flex-shrink-0 w-14 h-14 bg-background rounded-xl flex items-center justify-center text-3xl group-hover:scale-110 transition-transform">
                {agent.emoji || '🤖'}
              </div>
              
              {/* Info */}
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <h3 className="text-lg font-semibold text-text-primary truncate">
                    {agent.name}
                  </h3>
                  {hasSubagents && (
                    <span className="px-2 py-0.5 bg-accent bg-opacity-20 text-accent text-xs rounded-full">
      +{subagents.length}
                    </span>
                  )}
                </div>
                
                <p className="text-sm text-text-secondary mt-1 line-clamp-2">
                  {agent.description || '설명 없음'}
                </p>
                
                <div className="flex items-center gap-3 mt-3">
                  <div className="flex items-center gap-1.5 text-xs text-text-secondary">
                    <Bot className="w-3 h-3" />
                    <span>{agent.model || '기본 모델'}</span>
                  </div>
                  
                  {hasSubagents && (
                    <div className="flex items-center gap-1.5 text-xs text-accent">
                      <GitBranch className="w-3 h-3" />
                      <span>서브에이전트 있음</span>
                    </div>
                  )}
                </div>
              </div>
              
              {/* Arrow */}
              <ChevronRight className="w-5 h-5 text-text-secondary group-hover:text-accent transition-colors" />
            </div>
          </button>
          
          {/* Render subagents */}
          {hasSubagents && (
            <div className="relative mt-4 space-y-4">
              {/* Vertical line */}
              <div className="absolute -left-4 top-0 bottom-0 w-px bg-border-color" />
              {subagents.map(subagent => renderAgentCard(subagent, level + 1))}
            </div>
          )}
        </div>
      </div>
    );
  };

  return (
    <div className="h-full overflow-y-auto scrollbar-thin p-6">
      <div className="max-w-4xl mx-auto">
        {/* Header */}
        <div className="mb-8">
          <div className="flex items-center gap-3 mb-2">
            <Network className="w-6 h-6 text-accent" />
            <h2 className="text-2xl font-bold text-text-primary">에이전트 조직도</h2>
          </div>
          <p className="text-text-secondary">
            TideClaw 시스템의 에이전트 계층 구조를 확인하고 관리합니다.
            총 <span className="text-accent font-semibold">{agents.length}</span>개의 에이전트가 등록되어 있습니다.
          </p>
        </div>

        {/* Stats */}
        <div className="grid grid-cols-3 gap-4 mb-8">
          <div className="bg-card border border-border-color rounded-xl p-4">
            <div className="flex items-center gap-2 text-text-secondary mb-2">
              <Bot className="w-4 h-4" />
              <span className="text-sm">총 에이전트</span>
            </div>
            <p className="text-2xl font-bold text-text-primary">{agents.length}</p>
          </div>
          
          <div className="bg-card border border-border-color rounded-xl p-4">
            <div className="flex items-center gap-2 text-text-secondary mb-2">
              <GitBranch className="w-4 h-4" />
              <span className="text-sm">루트 에이전트</span>
            </div>
            <p className="text-2xl font-bold text-text-primary">{rootAgents.length}</p>
          </div>
          
          <div className="bg-card border border-border-color rounded-xl p-4">
            <div className="flex items-center gap-2 text-text-secondary mb-2">
              <Users className="w-4 h-4" />
              <span className="text-sm">서브에이전트</span>
            </div>
            <p className="text-2xl font-bold text-text-primary">
              {agents.length - rootAgents.length}
            </p>
          </div>
        </div>

        {/* Agent Tree */}
        {agents.length === 0 ? (
          <div className="text-center py-16">
            <Bot className="w-16 h-16 mx-auto text-text-secondary opacity-50 mb-4" />
            <p className="text-text-secondary">에이전트를 불러오는 중...</p>
          </div>
        ) : (
          <div className="space-y-6">
            {rootAgents.map(agent => renderAgentCard(agent))}
          </div>
        )}
      </div>
    </div>
  );
}
