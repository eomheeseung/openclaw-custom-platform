import { useMemo } from 'react';
import { Sparkles, Calendar, Mail, ListTodo, AtSign, Plus } from 'lucide-react';
import type { Agent } from '../types';

interface QuickActionsProps {
  agents: Agent[];
  currentAgentId?: string;
  onQuickPrompt: (text: string) => void;       // 즉시 보내기
  onPrefillMention: (text: string) => void;    // 입력란 prefill (사용자가 이어 작성)
  onCreateAgent?: () => void;
  onAfterPick?: () => void;                    // 칩 클릭 후 자동 닫힘 콜백
  variant?: 'inline' | 'card';                 // inline=ChatInput 위 펼침, card=빈 화면 시작 가이드
}

interface Chip {
  label: string;
  icon: React.ComponentType<{ className?: string; strokeWidth?: number }>;
  prompt: string;
  send: boolean; // true=즉시 보내기, false=입력란 prefill
  tone?: 'accent' | 'mention' | 'soft';
}

/* 기본 자비스 명령 칩 — 즉시 보내기 */
const DEFAULT_CHIPS: Chip[] = [
  { label: '오늘 뭐해?', icon: Sparkles, prompt: '오늘 일정·미팅·미답 메일·마감 task 정리해줘. 짧고 우선순위 순으로.', send: true, tone: 'accent' },
  { label: '다음 미팅', icon: Calendar, prompt: '다음 미팅이 언제 몇 시고 누구랑인지, 준비할 자료/회의록 있으면 같이 알려줘.', send: true, tone: 'soft' },
  { label: '미답 메일 요약', icon: Mail, prompt: '미답 메일 중요한 것부터 3건만 요약하고 답장 초안도 같이 만들어줘.', send: true, tone: 'soft' },
  { label: '내 task', icon: ListTodo, prompt: '내가 담당하고 working 상태인 두레이 task 마감 임박 순으로 정리.', send: true, tone: 'soft' },
];

export function QuickActions({
  agents,
  currentAgentId,
  onQuickPrompt,
  onPrefillMention,
  onCreateAgent,
  onAfterPick,
  variant = 'inline',
}: QuickActionsProps) {
  /* 멘션 가능한 에이전트 (현재 에이전트 제외 + discord 변형 제외) */
  const mentionable = useMemo(() => {
    return agents.filter(a => a.id !== currentAgentId && !a.id.endsWith('-discord'));
  }, [agents, currentAgentId]);

  const handleChip = (chip: Chip) => {
    if (chip.send) onQuickPrompt(chip.prompt);
    else onPrefillMention(chip.prompt);
    onAfterPick?.();
  };

  const handleMention = (name: string) => {
    onPrefillMention(`@${name} `);
    onAfterPick?.();
  };

  /* card variant: 빈 화면 시작 가이드 (큼직하게 가운데) */
  if (variant === 'card') {
    return (
      <div className="mx-auto w-full max-w-2xl px-6 mt-6 space-y-4">
        <div className="text-center text-xs font-semibold text-text-secondary/70 uppercase tracking-wider">
          빠른 명령
        </div>
        <div className="grid grid-cols-2 gap-2">
          {DEFAULT_CHIPS.map(chip => {
            const Icon = chip.icon;
            return (
              <button
                key={chip.label}
                onClick={() => handleChip(chip)}
                className="flex items-center gap-2.5 px-4 py-3 rounded-xl border border-border-color bg-card hover:border-accent/40 hover:bg-accent/[0.04] transition-all text-left group"
              >
                <Icon className="w-4 h-4 text-accent flex-shrink-0" strokeWidth={2.5} />
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-semibold text-text-primary">{chip.label}</div>
                  <div className="text-[11px] text-text-secondary line-clamp-1">{chip.prompt}</div>
                </div>
              </button>
            );
          })}
        </div>

        {mentionable.length > 0 && (
          <>
            <div className="text-center text-xs font-semibold text-purple-600/70 uppercase tracking-wider flex items-center justify-center gap-1.5 pt-2">
              <AtSign className="w-3 h-3" strokeWidth={3} />
              서브에이전트로 위임
            </div>
            <div className="flex flex-wrap justify-center gap-1.5">
              {mentionable.slice(0, 8).map(a => (
                <button
                  key={a.id}
                  onClick={() => handleMention(a.name)}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-purple-50/70 border border-purple-200 text-purple-700 hover:bg-purple-100 transition-all font-medium text-xs"
                  title={`@${a.name}으로 위임`}
                >
                  <span>{a.emoji || '🤖'}</span>
                  <span>{a.name}</span>
                </button>
              ))}
              {onCreateAgent && (
                <button
                  onClick={onCreateAgent}
                  className="inline-flex items-center gap-1 px-3 py-1.5 rounded-full bg-gradient-to-r from-purple-500/[0.08] to-accent/[0.08] border border-dashed border-purple-300 text-purple-700 hover:from-purple-500/15 hover:to-accent/15 transition-all font-medium text-xs"
                >
                  <Plus className="w-3 h-3" strokeWidth={3} />
                  <span>새 role</span>
                </button>
              )}
            </div>
          </>
        )}
      </div>
    );
  }

  /* inline variant: ChatInput 위 펼쳐지는 1줄 (토글로 노출) */
  return (
    <div className="px-6 pt-2 pb-1 flex items-center gap-1.5 flex-wrap text-xs flex-shrink-0 animate-in slide-in-from-bottom-2 duration-200">
      {DEFAULT_CHIPS.map(chip => {
        const Icon = chip.icon;
        const toneCls =
          chip.tone === 'accent'
            ? 'bg-accent/[0.08] border-accent/25 text-accent hover:bg-accent/[0.14]'
            : chip.tone === 'mention'
              ? 'bg-purple-50 border-purple-200 text-purple-700 hover:bg-purple-100'
              : 'bg-card border-border-color text-text-secondary hover:border-accent/30 hover:text-accent';
        return (
          <button
            key={chip.label}
            onClick={() => handleChip(chip)}
            className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full border font-medium transition-all ${toneCls}`}
            title={chip.prompt}
          >
            <Icon className="w-3.5 h-3.5" strokeWidth={2.5} />
            <span>{chip.label}</span>
          </button>
        );
      })}

      {mentionable.length > 0 && (
        <>
          <span className="mx-1 text-text-secondary/30 text-[10px]">|</span>
          <span className="inline-flex items-center gap-1 text-[10px] font-semibold text-purple-600/70 uppercase tracking-wider">
            <AtSign className="w-3 h-3" strokeWidth={3} />
            위임
          </span>
          {mentionable.slice(0, 6).map(a => (
            <button
              key={a.id}
              onClick={() => handleMention(a.name)}
              className="inline-flex items-center gap-1 px-2 py-1 rounded-full bg-purple-50/60 border border-purple-200 text-purple-700 hover:bg-purple-100 transition-all font-medium"
              title={`@${a.name}으로 위임`}
            >
              <span>{a.emoji || '🤖'}</span>
              <span>{a.name}</span>
            </button>
          ))}
          {mentionable.length > 6 && (
            <span className="text-text-secondary/50 text-[10px] px-1">+{mentionable.length - 6}</span>
          )}
        </>
      )}

      {onCreateAgent && (
        <button
          onClick={onCreateAgent}
          className="ml-auto inline-flex items-center gap-1 px-2.5 py-1 rounded-full bg-gradient-to-r from-purple-500/[0.08] to-accent/[0.08] border border-dashed border-purple-300 text-purple-700 hover:from-purple-500/15 hover:to-accent/15 transition-all font-medium"
          title="새 role의 에이전트 만들기"
        >
          <Plus className="w-3 h-3" strokeWidth={3} />
          <span>새 role 만들기</span>
        </button>
      )}
    </div>
  );
}
