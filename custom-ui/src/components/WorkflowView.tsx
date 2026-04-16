import { useState, useEffect, useCallback } from 'react';
import { Briefcase, Plus, Inbox, ChevronRight, ChevronLeft, LayoutGrid } from 'lucide-react';
import { BidWorkflowSection } from './BidWorkflowSection';

interface WorkflowViewProps {
  token: string;
  onSendMessage: (text: string) => void;
  onOpenVNC: () => void;
}

function userKey(token: string, base: string): string {
  const m = token.match(/user(\d+)/i);
  const slot = m ? m[1].padStart(2, '0') : 'unknown';
  return `${base}-${slot}`;
}

interface CatalogItem {
  id: string;
  name: string;
  emoji: string;
  description: string;
  available: boolean;
}

const CATALOG: CatalogItem[] = [
  { id: 'bid', name: '제안서 / 입찰', emoji: '📋', description: '오늘 배정된 입찰공고 요약·상세·메일 발송', available: true },
  { id: 'mail', name: '메일 자동화', emoji: '📧', description: '주간보고·답장 초안 (준비 중)', available: false },
  { id: 'schedule', name: '일정 관리', emoji: '📅', description: '회의·알림 (준비 중)', available: false },
  { id: 'data', name: '데이터 분석', emoji: '📊', description: 'Drive·RAG (준비 중)', available: false },
];

const PINS_BASE = 'tideclaw-workflow-pins';
const CATALOG_COLLAPSED_BASE = 'tideclaw-workflow-catalog-collapsed';

function loadPins(token: string): string[] {
  try {
    const raw = localStorage.getItem(userKey(token, PINS_BASE));
    if (!raw) return ['bid'];
    const arr = JSON.parse(raw);
    if (Array.isArray(arr)) return arr.filter(s => typeof s === 'string');
  } catch { /* ignore */ }
  return ['bid'];
}

function savePins(token: string, pins: string[]) {
  try { localStorage.setItem(userKey(token, PINS_BASE), JSON.stringify(pins)); } catch { /* ignore */ }
}

export function WorkflowView({ token, onSendMessage, onOpenVNC }: WorkflowViewProps) {
  const [pins, setPins] = useState<string[]>(() => loadPins(token));
  const [catalogCollapsed, setCatalogCollapsed] = useState<boolean>(() => {
    try { return localStorage.getItem(userKey(token, CATALOG_COLLAPSED_BASE)) === '1'; } catch { return false; }
  });

  useEffect(() => { savePins(token, pins); }, [token, pins]);
  useEffect(() => {
    try { localStorage.setItem(userKey(token, CATALOG_COLLAPSED_BASE), catalogCollapsed ? '1' : '0'); } catch { /* ignore */ }
  }, [token, catalogCollapsed]);

  const togglePin = useCallback((id: string) => {
    setPins(prev => prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]);
  }, []);

  const renderBlock = (id: string) => {
    if (id === 'bid') return (
      <BidWorkflowSection
        key="bid"
        token={token}
        onSendMessage={onSendMessage}
        onOpenVNC={onOpenVNC}
        onUnpin={() => togglePin('bid')}
      />
    );
    return null;
  };

  return (
    <div className="flex-1 flex overflow-hidden bg-background">
      {/* 메인: 핀된 워크플로 블럭 */}
      <div className="flex-1 overflow-y-auto p-6">
        <div className="max-w-5xl mx-auto space-y-4">
          <header className="flex items-center gap-3 mb-2">
            <Briefcase className="w-7 h-7 text-accent" />
            <div>
              <h1 className="text-xl font-bold text-text-primary">워크플로</h1>
              <p className="text-sm text-text-secondary">오른쪽에서 워크플로를 선택해 추가하거나 제거하세요</p>
            </div>
          </header>

          {pins.length === 0 ? (
            <div className="bg-card border border-dashed border-border-color rounded-2xl p-12 flex flex-col items-center justify-center text-center text-text-secondary">
              <Inbox className="w-12 h-12 mb-3 opacity-40" />
              <div className="text-sm">핀된 워크플로가 없어요</div>
              <div className="text-xs mt-1 opacity-70">오른쪽 카탈로그에서 추가해보세요</div>
            </div>
          ) : (
            pins.map(id => renderBlock(id)).filter(Boolean)
          )}
        </div>
      </div>

      {/* 우측 카탈로그 (접힘 가능) */}
      {catalogCollapsed ? (
        <aside className="w-12 flex-shrink-0 border-l border-border-color bg-card/30 flex flex-col items-center pt-4">
          <button
            onClick={() => setCatalogCollapsed(false)}
            className="w-9 h-9 rounded-lg flex items-center justify-center text-text-secondary hover:bg-accent/10 hover:text-accent transition-colors"
            title="카탈로그 펼치기"
          >
            <ChevronLeft className="w-5 h-5" />
          </button>
          <div className="mt-2 text-text-secondary" title="카탈로그">
            <LayoutGrid className="w-5 h-5" />
          </div>
        </aside>
      ) : (
        <aside className="w-72 flex-shrink-0 border-l border-border-color bg-card/30 overflow-y-auto p-4">
          <div className="flex items-center justify-between mb-3 px-1">
            <h3 className="text-xs font-bold text-text-secondary uppercase tracking-widest">카탈로그</h3>
            <button
              onClick={() => setCatalogCollapsed(true)}
              className="p-1 text-text-secondary hover:text-accent transition-colors"
              title="카탈로그 접기"
            >
              <ChevronRight className="w-4 h-4" />
            </button>
          </div>
          <div className="space-y-2">
            {CATALOG.map(item => {
              const pinned = pins.includes(item.id);
              return (
                <button
                  key={item.id}
                  onClick={() => item.available && togglePin(item.id)}
                  disabled={!item.available}
                  className={`w-full text-left p-3 rounded-lg border transition-colors ${
                    pinned
                      ? 'bg-accent/10 border-accent/40 hover:bg-accent/20'
                      : item.available
                        ? 'bg-background border-border-color hover:border-accent/40 hover:bg-accent/5'
                        : 'bg-background/50 border-border-color/50 opacity-50 cursor-not-allowed'
                  }`}
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="flex items-center gap-2 min-w-0">
                      <span className="text-xl flex-shrink-0">{item.emoji}</span>
                      <div className="min-w-0">
                        <div className="text-sm font-medium text-text-primary truncate">{item.name}</div>
                        <div className="text-xs text-text-secondary line-clamp-2 mt-0.5">{item.description}</div>
                      </div>
                    </div>
                    {item.available && (
                      pinned
                        ? <span className="text-xs text-accent font-medium flex-shrink-0">핀됨</span>
                        : <Plus className="w-4 h-4 text-text-secondary flex-shrink-0" />
                    )}
                  </div>
                </button>
              );
            })}
          </div>
          <p className="text-xs text-text-secondary/70 mt-4 px-1 leading-relaxed">
            핀한 워크플로는 새로고침해도 유지돼요. 카드 우측 상단 ✕로 제거 가능.
          </p>
        </aside>
      )}
    </div>
  );
}
