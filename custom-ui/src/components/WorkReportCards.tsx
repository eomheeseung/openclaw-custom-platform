import { memo, useState, useEffect, useRef, useCallback } from 'react';
import { FileText, AlertTriangle, RotateCcw, CheckCircle2, X, Plus, Check } from 'lucide-react';

/* work-draft — 업무보고 초안 카드 (보고서 미리보기형)
   비서가 draft-YYYY-Www.json 을 읽어 ```work-draft fence 로 재발행하면 렌더링된다.
   설계 원칙: 메일과 같은 구조(■ 완료 / ■ 진행·차주 / ■ AI 활용) · 청록 단색 ·
   화면에서 본 것 = 발송되는 것.

   수정·추가·삭제는 화면이 초안 파일을 직접 고친다(PUT /api/work-report/draft).
   채팅으로 시키면 모델이 항목을 새로 써서 한글이 깨지고(업무→업묵) 출처가 사라진다(실측). */

interface Src { source: string; url?: string | null }
interface Item {
  text: string; status?: string; sources?: Src[];
  merged_count?: number; carry?: boolean;
}
interface BizGroup { id: string; name: string; alias: string; items: Item[] }
export interface WorkDraft {
  period: string; week?: string; generated_at?: string;
  businesses: BizGroup[]; common: Item[]; ai?: Item[];
  failures?: string[]; warnings?: Item[];
}

const TOOL_KO: Record<string, string> = {
  dooray: '두레이', gmail: 'Gmail', calendar: '캘린더',
  drive: '드라이브', github: 'GitHub', figma: 'Figma', carry: '이월',
};

/** 사업 인덱스: -1 = 공통(사업 없음), -2 = AI 활용 */
const COMMON = -1;
const AI = -2;
interface Ref { gi: number; ii: number }

function Row({
  it, alias, refr, editable, bizList, onEdit, onRemove, onStatus, onBiz,
}: {
  it: Item; alias?: string; refr: Ref; editable: boolean;
  bizList: Array<{ alias: string; gi: number }>;
  onEdit: (r: Ref, text: string) => void;
  onRemove: (r: Ref) => void;
  onStatus: (r: Ref, status: string) => void;
  onBiz: (r: Ref, gi: number) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(it.text);
  useEffect(() => { if (!editing) setDraft(it.text); }, [it.text, editing]);

  const commit = () => {
    setEditing(false);
    const t = draft.trim();
    if (t && t !== it.text) onEdit(refr, t);
    else setDraft(it.text);
  };

  const unsourced = !it.sources || it.sources.length === 0;
  /* carry(이월)·직접 입력(ai) 은 출처 없음이 정상 — 경고는 그 외에만 */
  const warn = unsourced && !it.carry;

  if (editing) {
    return (
      <div className="flex items-center gap-1.5 px-5 py-1">
        <input
          autoFocus value={draft}
          onChange={e => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={e => {
            if (e.key === 'Enter') { e.preventDefault(); commit(); }
            if (e.key === 'Escape') { setDraft(it.text); setEditing(false); }
          }}
          className="flex-1 px-2 py-1 bg-white border border-accent/50 rounded text-sm
                     focus:outline-none focus:ring-1 focus:ring-accent"
        />
      </div>
    );
  }

  return (
    <div className={`group flex items-baseline gap-2 px-5 py-1.5 text-sm ${warn ? 'bg-amber-500/[0.06]' : ''}`}>
      <span className="flex-1 leading-snug">
        {alias && <span className="text-accent/70 text-[11px] font-bold mr-1">[{alias}]</span>}
        {editable
          ? <span onClick={() => setEditing(true)}
                  className="cursor-text hover:bg-accent/[0.07] rounded px-1 -mx-1"
                  title="클릭해서 수정">{it.text}</span>
          : it.text}
        {it.merged_count ? <span className="ml-1 text-[9px] text-text-secondary">묶음</span> : null}
        {it.carry ? <span className="ml-1 text-[8.5px] text-accent/60">· 지난주 예정 → 계속</span> : null}
      </span>

      {editable && (
        <span className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity flex-shrink-0">
          {refr.gi !== AI && (
            <>
              <select value={refr.gi} onChange={e => onBiz(refr, Number(e.target.value))}
                className="text-[10px] bg-transparent border border-border-color rounded px-1 py-0.5 text-text-secondary"
                title="사업 바꾸기">
                <option value={COMMON}>(사업 없음)</option>
                {bizList.map(b => <option key={b.gi} value={b.gi}>{b.alias}</option>)}
              </select>
              <button onClick={() => onStatus(refr, it.status === 'done' ? 'next' : 'done')}
                className="text-[10px] px-1.5 py-0.5 border border-border-color rounded text-text-secondary hover:border-accent hover:text-accent"
                title="완료 ↔ 진행·차주 옮기기">
                {it.status === 'done' ? '→ 진행' : '→ 완료'}
              </button>
            </>
          )}
          <button onClick={() => onRemove(refr)} className="p-0.5 text-text-secondary hover:text-red-500" title="삭제">
            <X className="w-3.5 h-3.5" />
          </button>
        </span>
      )}

      <span className="text-[10.5px] whitespace-nowrap flex-shrink-0">
        {(it.sources || []).map((s, i) => (
          s.url
            ? <a key={i} href={s.url} target="_blank" rel="noopener noreferrer"
                 className="text-accent/60 hover:text-accent ml-1 border-b border-dotted border-accent/30">
                {TOOL_KO[s.source] || s.source} ↗</a>
            : <span key={i} className="text-text-secondary/70 ml-1">{TOOL_KO[s.source] || s.source}</span>
        ))}
        {unsourced && (
          warn
            ? <span className="text-amber-700 font-bold ml-1">⚠ 출처 없음</span>
            : <span className="text-text-secondary/50 ml-1">—</span>
        )}
      </span>
    </div>
  );
}

/** 새 항목 한 줄 입력 */
function AddRow({ label, onAdd }: { label: string; onAdd: (text: string) => void }) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState('');
  const commit = () => {
    const t = text.trim();
    if (t) onAdd(t);
    setText(''); setOpen(false);
  };
  if (!open) {
    return (
      <button onClick={() => setOpen(true)}
        className="mx-5 mt-1 px-2 py-1 text-[11px] text-text-secondary hover:text-accent flex items-center gap-1">
        <Plus className="w-3 h-3" /> {label}
      </button>
    );
  }
  return (
    <div className="px-5 py-1">
      <input autoFocus value={text} placeholder={`${label} — 입력 후 Enter`}
        onChange={e => setText(e.target.value)}
        onBlur={commit}
        onKeyDown={e => {
          if (e.key === 'Enter') { e.preventDefault(); commit(); }
          if (e.key === 'Escape') { setText(''); setOpen(false); }
        }}
        className="w-full px-2 py-1 bg-white border border-accent/50 rounded text-sm
                   focus:outline-none focus:ring-1 focus:ring-accent" />
    </div>
  );
}

/* 사업 그룹을 상태별로 평탄화 — 메일 구조(■ 섹션)에 맞춘다 */
function flat(d: WorkDraft, pred: (s?: string) => boolean) {
  const rows: Array<{ it: Item; alias?: string; refr: Ref }> = [];
  d.businesses.forEach((b, gi) => b.items.forEach((it, ii) => {
    if (pred(it.status)) rows.push({ it, alias: b.alias, refr: { gi, ii } });
  }));
  d.common.forEach((it, ii) => { if (pred(it.status)) rows.push({ it, refr: { gi: COMMON, ii } }); });
  return rows;
}

export const WorkDraftCard = memo(function WorkDraftCard({
  raw, onSelect,
}: { raw: string; onSelect?: (t: string) => void }) {
  const parsed = (() => { try { return JSON.parse(raw) as WorkDraft; } catch { return null; } })();

  /* 편집 상태는 카드가 들고 있는다 — 저장은 초안 파일로 나간다.
     raw 는 대화에 박제된 값이라 저장 후에도 옛 내용 그대로다. 되돌아가면 안 된다. */
  const [d, setD] = useState<WorkDraft | null>(parsed);
  const [saveState, setSave] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const loadedFor = useRef<string | null>(null);

  const week = parsed?.week || '';
  /* 카드가 다시 마운트되면(스크롤·세션 전환) 저장해 둔 최신본을 불러온다 */
  useEffect(() => {
    if (!week || loadedFor.current === week) return;
    loadedFor.current = week;
    fetch(`/api/work-report/draft?week=${encodeURIComponent(week)}`, { credentials: 'include' })
      .then(r => r.json())
      .then(j => { if (j?.ok && j.draft) setD(j.draft); })
      .catch(() => { /* 없으면 대화에 박힌 값 그대로 */ });
  }, [week]);

  const save = useCallback((next: WorkDraft) => {
    if (!week) return;
    if (timer.current) clearTimeout(timer.current);
    setSave('saving');
    timer.current = setTimeout(() => {
      fetch(`/api/work-report/draft?week=${encodeURIComponent(week)}`, {
        method: 'PUT', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ businesses: next.businesses, common: next.common, ai: next.ai || [] }),
      })
        .then(r => r.json())
        .then(j => setSave(j?.ok ? 'saved' : 'error'))
        .catch(() => setSave('error'));
    }, 600);
  }, [week]);

  const mutate = useCallback((fn: (cur: WorkDraft) => WorkDraft) => {
    setD(cur => {
      if (!cur) return cur;
      const next = fn(structuredClone(cur));
      save(next);
      return next;
    });
  }, [save]);

  const listOf = (cur: WorkDraft, gi: number): Item[] =>
    gi === AI ? (cur.ai ||= []) : gi === COMMON ? cur.common : cur.businesses[gi].items;

  const onEdit = (r: Ref, text: string) => mutate(cur => { listOf(cur, r.gi)[r.ii].text = text; return cur; });
  const onRemove = (r: Ref) => mutate(cur => { listOf(cur, r.gi).splice(r.ii, 1); return cur; });
  const onStatus = (r: Ref, status: string) => mutate(cur => { listOf(cur, r.gi)[r.ii].status = status; return cur; });
  const onBiz = (r: Ref, gi: number) => mutate(cur => {
    if (gi === r.gi) return cur;
    const [moved] = listOf(cur, r.gi).splice(r.ii, 1);
    listOf(cur, gi).push(moved);
    return cur;
  });
  /* 직접 입력한 항목은 출처가 없는 게 정상이다 — carry 로 표시해 ⚠ 경고를 띄우지 않는다 */
  const onAdd = (gi: number, status: string) => (text: string) =>
    mutate(cur => { listOf(cur, gi).push({ text, status, sources: [], carry: true }); return cur; });

  if (!d || !Array.isArray(d.businesses)) {
    return <div className="my-2 p-3 rounded-lg border border-border-color bg-background text-xs text-text-secondary italic">
      업무보고 초안 로딩 중...</div>;
  }

  const editable = !!week;
  const done = flat(d, s => s === 'done' || s === undefined);
  const next = flat(d, s => s === 'wip' || s === 'next');
  const ai = Array.isArray(d.ai) ? d.ai : [];
  const warnCount = done.concat(next).filter(r => !r.it.carry && !(r.it.sources || []).length).length;
  const fails = d.failures || [];
  const emptyBiz = d.businesses.filter(b => b.items.length === 0);
  const bizList = d.businesses.map((b, gi) => ({ alias: b.alias, gi }));
  const rowProps = { editable, bizList, onEdit, onRemove, onStatus, onBiz };

  return (
    <div className="my-3 rounded-2xl border border-accent/25 bg-white max-w-4xl overflow-hidden">
      <div className="bg-accent/[0.07] px-5 py-3 flex justify-between items-baseline">
        <span className="text-base font-bold text-accent flex items-center gap-1.5">
          <FileText className="w-[18px] h-[18px]" /> 업무보고 초안
        </span>
        <span className="text-[11.5px] text-text-secondary">
          {d.period}{d.generated_at ? ` · ${d.generated_at.slice(5, 16).replace('T', ' ')} 생성` : ''}
        </span>
      </div>

      {fails.length > 0 && (
        <div className="px-4 py-2 bg-amber-500/10 border-b border-amber-500/30 text-[11px] text-amber-800 flex items-center gap-1.5">
          <AlertTriangle className="w-3.5 h-3.5 flex-shrink-0" />
          <span><b>{fails.map(f => TOOL_KO[f] || f).join(' · ')} 수집 실패</b> — 해당 출처가 빠진 초안입니다. 연동 확인 후 다시 생성하세요.</span>
        </div>
      )}

      <div className="flex border-b border-border-color/60 text-center">
        <div className="flex-1 py-2 border-r border-border-color/60">
          <div className="text-xl font-extrabold text-accent">{done.length}</div>
          <div className="text-[11px] text-text-secondary">완료</div>
        </div>
        <div className="flex-1 py-2">
          <div className="text-xl font-extrabold text-accent">{next.length}</div>
          <div className="text-[11px] text-text-secondary">진행 · 차주</div>
        </div>
      </div>

      <div className="py-2">
        <div className="px-4 text-[11px] font-extrabold text-accent">■ 완료</div>
        {done.length > 0
          ? done.map(r => <Row key={`${r.refr.gi}:${r.refr.ii}`} it={r.it} alias={r.alias} refr={r.refr} {...rowProps} />)
          : <div className="px-4 py-1 text-[11px] text-text-secondary/60 italic">(항목 없음)</div>}
        {editable && <AddRow label="완료 항목 추가" onAdd={onAdd(COMMON, 'done')} />}

        <div className="px-4 pt-2 text-[11px] font-extrabold text-accent">■ 진행 · 차주 계획</div>
        {next.length > 0
          ? next.map(r => <Row key={`${r.refr.gi}:${r.refr.ii}`} it={r.it} alias={r.alias} refr={r.refr} {...rowProps} />)
          : <div className="px-4 py-1 text-[11px] text-text-secondary/60 italic">(항목 없음)</div>}
        {editable && <AddRow label="진행·차주 항목 추가" onAdd={onAdd(COMMON, 'next')} />}

        <div className="px-4 pt-2 text-[11px] font-extrabold text-accent">■ 업무 - AI 툴 활용</div>
        {ai.length > 0
          ? ai.map((it, ii) => <Row key={`ai:${ii}`} it={{ ...it, carry: true }} refr={{ gi: AI, ii }} {...rowProps} />)
          : <div className="px-4 py-1 text-[11px] text-text-secondary/60 italic">(항목 없음)</div>}
        {editable && <AddRow label="AI 활용 항목 추가" onAdd={onAdd(AI, 'done')} />}
      </div>

      {emptyBiz.length > 0 && (
        <div className="px-4 pb-1 text-[10px] text-text-secondary/70">
          이번 주 활동 없음: {emptyBiz.map(b => b.name).join(' · ')}
        </div>
      )}
      {warnCount > 0 && (
        <div className="px-4 pb-2 flex items-start gap-1.5 text-[10.5px] text-amber-700">
          <AlertTriangle className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" />
          <span>출처 없는 항목 {warnCount}건 — 실제로 한 일이 맞는지 확인하세요.</span>
        </div>
      )}

      <div className="border-t border-border-color/60 px-4 py-2.5 flex items-center gap-2">
        <button onClick={() => onSelect?.('업무보고 초안 처음 상태로 되돌려줘')}
          className="px-3 py-1.5 text-xs border border-border-color rounded-lg text-text-secondary flex items-center gap-1 flex-shrink-0">
          <RotateCcw className="w-3 h-3" /> 초기화
        </button>
        <span className="text-[11px] text-text-secondary flex-1 flex items-center gap-1">
          {saveState === 'saving' && <span className="text-accent">저장 중...</span>}
          {saveState === 'saved' && <span className="text-accent flex items-center gap-0.5"><Check className="w-3 h-3" /> 저장됨</span>}
          {saveState === 'error' && <span className="text-red-500">저장 실패 — 다시 시도해주세요</span>}
          {saveState === 'idle' && (editable
            ? '✏️ 항목을 클릭해 수정 · 화면에 보이는 그대로 메일이 됩니다'
            : '✏️ 수정은 채팅으로 · 화면에 보이는 그대로 메일이 됩니다')}
        </span>
        <button onClick={() => onSelect?.('업무보고 초안 확정. 메일 발송 준비해줘')}
          className="px-4 py-1.5 text-xs bg-accent hover:bg-accent-hover text-white font-semibold rounded-lg flex items-center gap-1 flex-shrink-0">
          <CheckCircle2 className="w-3.5 h-3.5" /> 확정
        </button>
      </div>
    </div>
  );
});

/* tool-pick — 조회 소스 조정 카드. 기본은 안 뜨고 "조회할 곳 바꿔줘" 때만 비서가 발행 */
export interface ToolPickData {
  tools: Array<{ id: string; name: string; desc: string; on: boolean; connected: boolean }>;
}

export const ToolPickCard = memo(function ToolPickCard({
  raw, onSelect,
}: { raw: string; onSelect?: (t: string) => void }) {
  let d: ToolPickData | null = null;
  try { d = JSON.parse(raw); } catch { /* partial */ }
  if (!d || !Array.isArray(d.tools)) return null;
  return (
    <div className="my-3 rounded-2xl border border-accent/25 bg-white p-4 max-w-md">
      <div className="text-sm font-bold text-accent mb-1">🔧 조회할 곳</div>
      <div className="text-[10.5px] text-text-secondary mb-2">이번 회차에만 적용됩니다</div>
      {d.tools.map(t => (
        <div key={t.id}
          className={`flex items-center gap-2 border rounded-lg px-3 py-2 mb-1.5 text-xs
            ${!t.connected ? 'opacity-50' : t.on ? 'border-accent/40 bg-accent/[0.05]' : 'border-border-color'}`}>
          <span className={`w-3.5 h-3.5 rounded border text-[9px] text-center leading-3 flex-shrink-0
            ${t.on ? 'bg-accent text-white border-accent' : 'border-gray-300'}`}>{t.on ? '✓' : ''}</span>
          <span className="flex-1 font-semibold">{t.name}
            <span className="ml-1 font-normal text-text-secondary">{t.desc}</span></span>
          {!t.connected && <span className="text-[9px] text-amber-700 font-bold flex-shrink-0">연동 필요</span>}
        </div>
      ))}
      <div className="flex gap-1.5 mt-1">
        <button onClick={() => onSelect?.('이 구성을 기본값으로 저장하고 다시 집계해줘')}
          className="flex-1 px-3 py-1.5 text-[10.5px] border border-border-color rounded-lg text-text-secondary">
          기본값으로 저장 + 집계
        </button>
        <button onClick={() => onSelect?.('이 구성으로 업무보고 다시 집계해줘')}
          className="flex-1 px-3 py-1.5 text-xs bg-accent hover:bg-accent-hover text-white font-semibold rounded-lg">
          이대로 집계 (이번만)
        </button>
      </div>
    </div>
  );
});
