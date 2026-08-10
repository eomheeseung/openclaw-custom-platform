import { useEffect, useState } from 'react';
import { Bookmark, X, Loader2, Trash2 } from 'lucide-react';

export interface MemoryCandidate {
  scope: string;
  subject: string;
  body: string;
  tags: string[];
  expires_at_hint: string | null;
}

interface MemorySuggestModalProps {
  open: boolean;
  loading: boolean;
  candidates: MemoryCandidate[];
  error?: string | null;
  onClose: () => void;
  /* 사용자가 확정 — 선택된 항목만 전달 */
  onConfirm: (selected: MemoryCandidate[]) => Promise<void>;
}

export function MemorySuggestModal({ open, loading, candidates, error, onClose, onConfirm }: MemorySuggestModalProps) {
  /* 편집 가능한 카피 + 선택 상태 */
  const [items, setItems] = useState<(MemoryCandidate & { _checked: boolean })[]>([]);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    setItems(candidates.map(c => ({ ...c, _checked: true })));
    setSaving(false);
  }, [open, candidates]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

  const selectedCount = items.filter(i => i._checked).length;

  const handleConfirm = async () => {
    if (saving) return;
    setSaving(true);
    try {
      const selected = items.filter(i => i._checked).map(({ _checked: _c, ...rest }) => { void _c; return rest; });
      await onConfirm(selected);
    } finally {
      setSaving(false);
    }
  };

  const updateItem = (idx: number, patch: Partial<MemoryCandidate>) => {
    setItems(prev => prev.map((it, i) => i === idx ? { ...it, ...patch } : it));
  };

  const toggleItem = (idx: number) => {
    setItems(prev => prev.map((it, i) => i === idx ? { ...it, _checked: !it._checked } : it));
  };

  const removeItem = (idx: number) => {
    setItems(prev => prev.filter((_, i) => i !== idx));
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center pt-[8vh] px-4 bg-black/30 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="w-full max-w-2xl bg-card rounded-2xl shadow-2xl border border-border-color overflow-hidden flex flex-col max-h-[80vh]"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center gap-3 px-5 py-3.5 border-b border-border-color">
          <Bookmark className="w-4 h-4 text-accent" strokeWidth={2.5} />
          <div className="flex-1">
            <div className="font-bold text-text-primary text-sm">메모리 저장 후보</div>
            <div className="text-[11px] text-text-secondary mt-0.5">대화에서 비서가 추출한 항목들. 체크/수정 후 저장.</div>
          </div>
          <button onClick={onClose} className="text-text-secondary/60 hover:text-text-primary p-1">
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto px-5 py-4">
          {loading ? (
            <div className="flex flex-col items-center justify-center py-16 text-text-secondary">
              <Loader2 className="w-6 h-6 animate-spin text-accent mb-3" strokeWidth={2.5} />
              <div className="text-sm">비서가 대화에서 기억할 만한 항목을 뽑는 중...</div>
              <div className="text-[11px] mt-1 text-text-secondary/60">보통 30~60초 소요</div>
            </div>
          ) : error ? (
            <div className="text-center py-12">
              <div className="text-sm text-rose-600 font-medium mb-1">추출 실패</div>
              <div className="text-xs text-text-secondary">{error}</div>
            </div>
          ) : items.length === 0 ? (
            <div className="text-center py-12 text-sm text-text-secondary">
              기억할 만한 항목을 찾지 못했어요.<br />
              <span className="text-[11px] text-text-secondary/70">대화에 명확한 사실·약속·결정이 있을 때 다시 시도해보세요.</span>
            </div>
          ) : (
            <div className="space-y-3">
              {items.map((it, idx) => (
                <div
                  key={idx}
                  className={`border rounded-xl p-3 transition-all ${
                    it._checked
                      ? 'border-accent/30 bg-accent/[0.03]'
                      : 'border-border-color bg-card/50 opacity-60'
                  }`}
                >
                  <div className="flex items-start gap-3">
                    <input
                      type="checkbox"
                      checked={it._checked}
                      onChange={() => toggleItem(idx)}
                      className="mt-1 w-4 h-4 accent-accent flex-shrink-0"
                    />
                    <div className="flex-1 min-w-0 space-y-2">
                      {/* scope badge + subject */}
                      <div className="flex items-center gap-2">
                        <input
                          value={it.scope}
                          onChange={(e) => updateItem(idx, { scope: e.target.value })}
                          className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-purple-100 text-purple-700 border border-purple-200 outline-none focus:border-purple-400 min-w-0"
                          style={{ width: `${Math.max(it.scope.length + 1, 8)}ch` }}
                        />
                        <input
                          value={it.subject}
                          onChange={(e) => updateItem(idx, { subject: e.target.value })}
                          className="flex-1 text-sm font-semibold text-text-primary bg-transparent border-none outline-none focus:bg-white/50 rounded px-1"
                          placeholder="제목"
                        />
                      </div>
                      {/* body */}
                      <textarea
                        value={it.body}
                        onChange={(e) => updateItem(idx, { body: e.target.value })}
                        rows={2}
                        className="w-full text-xs text-text-secondary bg-white/40 border border-border-color/50 rounded-md px-2 py-1.5 outline-none focus:border-accent/40 resize-none"
                      />
                      {/* tags */}
                      <div className="flex items-center gap-1.5 flex-wrap">
                        {it.tags.map((tag, ti) => (
                          <span key={ti} className="inline-flex items-center gap-1 text-[10px] font-medium px-1.5 py-0.5 rounded-full bg-amber-50 border border-amber-200 text-amber-700">
                            #{tag}
                            <button
                              onClick={() => updateItem(idx, { tags: it.tags.filter((_, i) => i !== ti) })}
                              className="opacity-50 hover:opacity-100"
                            >×</button>
                          </span>
                        ))}
                        <input
                          placeholder="+태그"
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') {
                              const v = (e.target as HTMLInputElement).value.trim();
                              if (v) {
                                updateItem(idx, { tags: [...it.tags, v] });
                                (e.target as HTMLInputElement).value = '';
                              }
                            }
                          }}
                          className="text-[10px] w-16 px-1.5 py-0.5 rounded bg-transparent border border-dashed border-border-color outline-none focus:border-accent/40"
                        />
                        {it.expires_at_hint && (
                          <span className="text-[10px] text-text-secondary/70 ml-auto">~ {it.expires_at_hint}</span>
                        )}
                      </div>
                    </div>
                    <button
                      onClick={() => removeItem(idx)}
                      className="text-text-secondary/40 hover:text-rose-500 transition-colors flex-shrink-0"
                      title="이 항목 제외"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between gap-3 px-5 py-3 border-t border-border-color bg-card">
          <span className="text-[11px] text-text-secondary">
            {loading ? '추출 중...' : `${selectedCount}건 선택됨 / ${items.length}건`}
          </span>
          <div className="flex gap-2">
            <button
              onClick={onClose}
              disabled={saving}
              className="px-3 py-1.5 text-xs font-medium rounded-lg border border-border-color text-text-secondary hover:bg-card disabled:opacity-50"
            >
              취소
            </button>
            <button
              onClick={handleConfirm}
              disabled={loading || saving || selectedCount === 0}
              className="px-4 py-1.5 text-xs font-semibold rounded-lg bg-accent text-white hover:bg-accent-hover disabled:opacity-40 disabled:cursor-not-allowed flex items-center gap-1.5"
            >
              {saving ? <><Loader2 className="w-3.5 h-3.5 animate-spin" /> 저장 중</> : `기억하기 (${selectedCount})`}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
