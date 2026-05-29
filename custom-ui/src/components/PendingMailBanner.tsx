import { useState, useEffect, useCallback, useRef } from 'react';
import { Mail, Send, X, Loader2, ChevronDown, ChevronUp, Clock, AlertTriangle, Edit3, CheckCircle2 } from 'lucide-react';

interface Props {
  token: string;
}

interface PendingItem {
  mailId: string;
  confirmToken: string;
  from: string;
  preview: {
    to: string;
    cc: string | null;
    subject: string;
    body: string;
    bodyPreview: string;
    bodyLength: number;
  };
  createdAt: number;
  expiresAt: number;
}

interface DraftFields {
  from: string;
  to: string;
  cc: string;
  subject: string;
  body: string;
}

interface Recipient {
  email: string;
  name: string | null;
  source: 'recent' | 'employee';
  lastUsed: number | null;
}

const POLL_MS = 5000;

function formatRemaining(expiresAt: number, now: number): string {
  const sec = Math.max(0, Math.floor((expiresAt - now) / 1000));
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

function splitChips(value: string): string[] {
  if (!value) return [];
  return value.split(',').map(s => s.trim()).filter(Boolean);
}
function joinChips(chips: string[]): string {
  return chips.join(', ');
}
function chipDisplay(chip: string, recipients: Recipient[]): string {
  const found = recipients.find(r => r.email === chip || r.name === chip);
  if (found) return found.name ? `${found.name} <${found.email}>` : found.email;
  return chip;
}

function ChipsInput({
  value, onChange, recipients, placeholder, listId,
}: {
  value: string;
  onChange: (next: string) => void;
  recipients: Recipient[];
  placeholder?: string;
  listId: string;
}) {
  const [draft, setDraft] = useState('');
  const chips = splitChips(value);

  const commit = (raw: string) => {
    const v = raw.trim().replace(/,$/, '').trim();
    if (!v) return;
    if (chips.includes(v)) { setDraft(''); return; }
    onChange(joinChips([...chips, v]));
    setDraft('');
  };
  const removeChip = (idx: number) => {
    const next = chips.filter((_, i) => i !== idx);
    onChange(joinChips(next));
  };

  return (
    <div className="flex flex-wrap items-center gap-1 px-1.5 py-1 bg-background border border-border-color rounded focus-within:border-accent min-h-[28px]">
      {chips.map((c, i) => (
        <span key={`${c}-${i}`} className="inline-flex items-center gap-1 px-1.5 py-0.5 bg-accent/10 border border-accent/30 rounded text-[11px] text-text-primary max-w-[260px]">
          <span className="truncate">{chipDisplay(c, recipients)}</span>
          <button
            type="button"
            onClick={() => removeChip(i)}
            className="text-text-secondary hover:text-red-400 flex-shrink-0"
            title="제거"
          >
            <X className="w-3 h-3" />
          </button>
        </span>
      ))}
      <input
        value={draft}
        onChange={(e) => {
          const v = e.target.value;
          // datalist에서 클릭으로 골랐을 때 즉시 chip화
          if (v.endsWith(',')) {
            commit(v.slice(0, -1));
          } else if (recipients.some(r => r.email === v)) {
            commit(v);
          } else {
            setDraft(v);
          }
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === 'Tab') {
            if (draft.trim()) { e.preventDefault(); commit(draft); }
          } else if (e.key === 'Backspace' && !draft && chips.length > 0) {
            removeChip(chips.length - 1);
          }
        }}
        onBlur={() => { if (draft.trim()) commit(draft); }}
        list={listId}
        placeholder={chips.length === 0 ? placeholder : ''}
        className="flex-1 min-w-[120px] bg-transparent text-xs text-text-primary focus:outline-none px-1"
      />
    </div>
  );
}

function itemToDraft(item: PendingItem): DraftFields {
  return {
    from: item.from,
    to: item.preview.to,
    cc: item.preview.cc || '',
    subject: item.preview.subject,
    body: item.preview.body,
  };
}

export function PendingMailBanner({ token }: Props) {
  const slot = token.match(/user(\d+)/i)?.[1] ?? null;
  const [items, setItems] = useState<PendingItem[]>([]);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [drafts, setDrafts] = useState<Record<string, DraftFields>>({});
  const [sending, setSending] = useState<Record<string, 'send' | 'cancel' | null>>({});
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now());
  const [toast, setToast] = useState<string | null>(null);
  const [recipients, setRecipients] = useState<Recipient[]>([]);
  const prevIdsRef = useRef<Set<string>>(new Set());
  const toastTimerRef = useRef<number | null>(null);

  const showToast = (msg: string) => {
    setToast(msg);
    if (toastTimerRef.current) window.clearTimeout(toastTimerRef.current);
    toastTimerRef.current = window.setTimeout(() => setToast(null), 2000);
  };

  const fetchPending = useCallback(async () => {
    if (!slot) return;
    try {
      const r = await fetch(`/api/mail/pending?userNN=${slot}`);
      const data = await r.json();
      if (data.ok) {
        const newItems: PendingItem[] = data.items || [];
        setItems(newItems);
        const ids = new Set<string>(newItems.map(it => it.mailId));
        // 새 메일 들어오면 자동 펼침 + 드래프트 초기화
        const expandPatch: Record<string, boolean> = {};
        const draftPatch: Record<string, DraftFields> = {};
        newItems.forEach(it => {
          if (!prevIdsRef.current.has(it.mailId)) {
            expandPatch[it.mailId] = true;
            draftPatch[it.mailId] = itemToDraft(it);
          }
        });
        if (Object.keys(expandPatch).length > 0) {
          setExpanded(prev => ({ ...prev, ...expandPatch }));
          setDrafts(prev => ({ ...prev, ...draftPatch }));
        }
        prevIdsRef.current = ids;
      }
    } catch {
      /* 일시 네트워크 오류 무시 */
    }
  }, [slot]);

  const fetchRecipients = useCallback(() => {
    if (!slot) return;
    fetch(`/api/mail/recipients?userNN=${slot}`)
      .then(r => r.json())
      .then(d => { if (d.ok) setRecipients(d.items || []); })
      .catch(() => { /* ignore */ });
  }, [slot]);

  useEffect(() => {
    fetchPending();
    fetchRecipients();
    const t1 = setInterval(fetchPending, POLL_MS);
    const t2 = setInterval(() => setNow(Date.now()), 1000);
    // 발송/취소 후 변동 가능성 있는 recipients는 pending 변경 시 함께 갱신 (별도 timer 불필요)
    return () => { clearInterval(t1); clearInterval(t2); };
  }, [fetchPending, fetchRecipients]);

  const ensureDraft = (item: PendingItem): DraftFields => {
    return drafts[item.mailId] || itemToDraft(item);
  };

  const updateDraft = (mailId: string, patch: Partial<DraftFields>) => {
    setDrafts(prev => ({
      ...prev,
      [mailId]: { ...(prev[mailId] || { from: '', to: '', cc: '', subject: '', body: '' }), ...patch },
    }));
  };

  const handleConfirm = async (item: PendingItem) => {
    setError(null);
    const d = ensureDraft(item);
    setSending(s => ({ ...s, [item.mailId]: 'send' }));
    try {
      const overrides = {
        from: d.from,
        to: d.to,
        cc: d.cc || null,
        subject: d.subject,
        body: d.body,
      };
      const r = await fetch('/api/mail/send-confirm', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mailId: item.mailId, confirmToken: item.confirmToken, overrides }),
      });
      const data = await r.json();
      if (!data.ok) {
        setError(`발송 실패: ${data.error || 'unknown'}`);
        setSending(s => ({ ...s, [item.mailId]: null }));
        return;
      }
      setItems(prev => prev.filter(x => x.mailId !== item.mailId));
      setSending(s => ({ ...s, [item.mailId]: null }));
      showToast('메일이 발송되었습니다');
      fetchRecipients();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setSending(s => ({ ...s, [item.mailId]: null }));
    }
  };

  const handleCancel = async (item: PendingItem) => {
    if (!window.confirm(`이 메일 발송을 취소할까요?\n\n제목: ${item.preview.subject}`)) return;
    setSending(s => ({ ...s, [item.mailId]: 'cancel' }));
    try {
      const r = await fetch('/api/mail/cancel', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mailId: item.mailId, confirmToken: item.confirmToken }),
      });
      const data = await r.json();
      if (!data.ok) {
        setError(`취소 실패: ${data.error || 'unknown'}`);
        setSending(s => ({ ...s, [item.mailId]: null }));
        return;
      }
      setItems(prev => prev.filter(x => x.mailId !== item.mailId));
      setSending(s => ({ ...s, [item.mailId]: null }));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setSending(s => ({ ...s, [item.mailId]: null }));
    }
  };

  const isDirty = (item: PendingItem): boolean => {
    const d = drafts[item.mailId];
    if (!d) return false;
    const orig = itemToDraft(item);
    return d.from !== orig.from || d.to !== orig.to || d.cc !== orig.cc || d.subject !== orig.subject || d.body !== orig.body;
  };

  if (!slot) return null;

  const toastEl = toast && (
    <div className="fixed top-4 left-1/2 -translate-x-1/2 z-[100] flex items-center gap-2 px-4 py-2.5 bg-green-500/95 text-white rounded-lg shadow-lg pointer-events-none animate-in fade-in slide-in-from-top-2 duration-200">
      <CheckCircle2 className="w-4 h-4" />
      <span className="text-sm font-medium">{toast}</span>
    </div>
  );

  if (items.length === 0) return <>{toastEl}</>;

  const datalistEl = (
    <datalist id="mail-recipients-list">
      {recipients.map(r => (
        <option key={r.email} value={r.email}>
          {r.name || ''}
        </option>
      ))}
    </datalist>
  );

  return (
    <>
    {toastEl}
    {datalistEl}
    <div className="bg-amber-500/10 border-b-2 border-amber-500/40">
      <div className="max-w-5xl mx-auto px-4 py-2">
        <div className="flex items-center gap-2 mb-1.5">
          <AlertTriangle className="w-3.5 h-3.5 text-amber-500" />
          <span className="text-xs font-semibold text-amber-500">
            메일 발송 대기 {items.length}건 — 확인/수정 후 발송
          </span>
        </div>
        {error && (
          <div className="text-xs text-red-400 bg-red-500/10 border border-red-500/20 rounded p-2 mb-2">
            ⚠ {error}
          </div>
        )}
        <div className="space-y-1.5">
          {items.map(item => {
            const isOpen = expanded[item.mailId];
            const remaining = formatRemaining(item.expiresAt, now);
            const expired = item.expiresAt <= now;
            const isSending = sending[item.mailId] === 'send';
            const isCanceling = sending[item.mailId] === 'cancel';
            const busy = isSending || isCanceling;
            const draft = ensureDraft(item);
            const dirty = isDirty(item);
            return (
              <div key={item.mailId} className="bg-card border border-border-color rounded-md overflow-hidden">
                {/* 헤더: 접힌 상태에서도 발송/취소 가능 */}
                <div className="flex items-center gap-2 px-3 py-1.5">
                  <Mail className="w-3.5 h-3.5 text-amber-500 flex-shrink-0" />
                  <button
                    onClick={() => setExpanded(p => ({ ...p, [item.mailId]: !p[item.mailId] }))}
                    className="flex-1 min-w-0 text-left flex items-center gap-2"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="text-sm font-medium text-text-primary truncate">
                        {draft.subject || <span className="text-text-secondary italic">(제목 없음)</span>}
                        {dirty && <span className="ml-2 text-[10px] text-amber-500">●수정됨</span>}
                      </div>
                      <div className="text-xs text-text-secondary truncate">
                        → {draft.to}{draft.cc ? ` · cc ${draft.cc}` : ''}
                      </div>
                    </div>
                    {isOpen
                      ? <ChevronUp className="w-4 h-4 text-text-secondary flex-shrink-0" />
                      : <ChevronDown className="w-4 h-4 text-text-secondary flex-shrink-0" />}
                  </button>
                  <div className={`flex items-center gap-1 text-xs flex-shrink-0 ${expired ? 'text-red-400' : 'text-text-secondary'}`}>
                    <Clock className="w-3 h-3" />
                    <span className="tabular-nums">{remaining}</span>
                  </div>
                  <button
                    onClick={() => handleConfirm(item)}
                    disabled={busy || expired}
                    className="flex items-center gap-1 px-2.5 py-1 bg-green-500/15 hover:bg-green-500/25 border border-green-500/40 rounded text-xs font-medium text-green-400 disabled:opacity-40 disabled:cursor-not-allowed flex-shrink-0"
                    title={dirty ? '수정한 내용으로 발송' : '발송'}
                  >
                    {isSending ? <Loader2 className="w-3 h-3 animate-spin" /> : <Send className="w-3 h-3" />}
                    발송
                  </button>
                  <button
                    onClick={() => handleCancel(item)}
                    disabled={busy}
                    className="flex items-center gap-1 px-2.5 py-1 bg-red-500/10 hover:bg-red-500/20 border border-red-500/30 rounded text-xs text-red-400 disabled:opacity-40 disabled:cursor-not-allowed flex-shrink-0"
                    title="발송 취소"
                  >
                    {isCanceling ? <Loader2 className="w-3 h-3 animate-spin" /> : <X className="w-3 h-3" />}
                    취소
                  </button>
                </div>

                {/* 펼침: 편집 폼 */}
                {isOpen && (
                  <div className="px-3 py-2.5 border-t border-border-color bg-background/40 space-y-2">
                    <div className="flex items-center gap-1.5 text-[11px] text-text-secondary mb-1">
                      <Edit3 className="w-3 h-3" /> 모든 필드 수정 후 [발송]을 누르면 수정한 내용으로 전송됩니다.
                    </div>
                    <div className="grid grid-cols-[80px_1fr] gap-x-2 gap-y-1.5 items-center">
                      <label className="text-xs text-text-secondary text-right">보낸 사람</label>
                      <input
                        value={draft.from}
                        onChange={(e) => updateDraft(item.mailId, { from: e.target.value })}
                        className="px-2 py-1 bg-background border border-border-color rounded text-xs text-text-primary focus:outline-none focus:border-accent"
                        placeholder="발신 이메일 (Gmail send-as 별칭만 적용됨)"
                      />
                      <label className="text-xs text-text-secondary text-right pt-1">받는 사람</label>
                      <ChipsInput
                        value={draft.to}
                        onChange={(v) => updateDraft(item.mailId, { to: v })}
                        recipients={recipients}
                        listId="mail-recipients-list"
                        placeholder="이름/이메일 입력 후 Enter — 자동완성 지원"
                      />
                      <label className="text-xs text-text-secondary text-right pt-1">참조</label>
                      <ChipsInput
                        value={draft.cc}
                        onChange={(v) => updateDraft(item.mailId, { cc: v })}
                        recipients={recipients}
                        listId="mail-recipients-list"
                        placeholder="없으면 비워두세요"
                      />
                      <label className="text-xs text-text-secondary text-right">제목</label>
                      <input
                        value={draft.subject}
                        onChange={(e) => updateDraft(item.mailId, { subject: e.target.value })}
                        className="px-2 py-1 bg-background border border-border-color rounded text-xs text-text-primary focus:outline-none focus:border-accent"
                      />
                    </div>
                    <div className="space-y-1">
                      <div className="flex items-center justify-between">
                        <label className="text-xs text-text-secondary">본문 ({draft.body.length}자)</label>
                        {dirty && (
                          <button
                            onClick={() => updateDraft(item.mailId, itemToDraft(item))}
                            className="text-[10px] text-text-secondary hover:text-accent"
                          >
                            원본으로 되돌리기
                          </button>
                        )}
                      </div>
                      <textarea
                        value={draft.body}
                        onChange={(e) => updateDraft(item.mailId, { body: e.target.value })}
                        rows={10}
                        className="w-full px-2 py-1.5 bg-background border border-border-color rounded text-xs text-text-primary focus:outline-none focus:border-accent font-sans resize-y max-h-72"
                      />
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
        <div className="text-[10px] text-text-secondary/70 mt-1.5 px-1">
          ⚠ 봇이 메일을 작성했지만 아직 발송되지 않았어요. 필요하면 수정한 뒤 [발송]을 누르세요. 10분 후 자동 취소됩니다.
        </div>
      </div>
    </div>
    </>
  );
}
