import { memo } from 'react';
import { FileText, AlertTriangle, RotateCcw, CheckCircle2 } from 'lucide-react';

/* work-draft — 업무보고 초안 카드 (보고서 미리보기형)
   비서가 draft-YYYY-Www.json 을 읽어 ```work-draft fence 로 재발행하면 렌더링된다.
   설계 원칙: 메일과 같은 구조(■ 완료 / ■ 진행·차주 / ■ AI 활용) · 청록 단색 ·
   화면에서 본 것 = 발송되는 것. */

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

function Row({ it, alias }: { it: Item; alias?: string }) {
  const unsourced = !it.sources || it.sources.length === 0;
  /* carry(이월)·직접 입력(ai) 은 출처 없음이 정상 — 경고는 그 외에만 */
  const warn = unsourced && !it.carry;
  return (
    <div className={`flex items-baseline gap-2 px-4 py-1 text-xs ${warn ? 'bg-amber-500/[0.06]' : ''}`}>
      <span className="flex-1 leading-snug">
        {alias && <span className="text-accent/70 text-[10px] font-bold mr-1">[{alias}]</span>}
        {it.text}
        {it.merged_count ? <span className="ml-1 text-[9px] text-text-secondary">묶음</span> : null}
        {it.carry ? <span className="ml-1 text-[8.5px] text-accent/60">· 지난주 예정 → 계속</span> : null}
      </span>
      <span className="text-[9px] whitespace-nowrap flex-shrink-0">
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

/* 사업 그룹을 상태별로 평탄화 — 메일 구조(■ 섹션)에 맞춘다 */
function flat(d: WorkDraft, pred: (s?: string) => boolean) {
  const rows: Array<{ it: Item; alias?: string }> = [];
  for (const b of d.businesses) for (const it of b.items) if (pred(it.status)) rows.push({ it, alias: b.alias });
  for (const it of d.common) if (pred(it.status)) rows.push({ it });
  return rows;
}

export const WorkDraftCard = memo(function WorkDraftCard({
  raw, onSelect,
}: { raw: string; onSelect?: (t: string) => void }) {
  let d: WorkDraft | null = null;
  try { d = JSON.parse(raw); } catch { /* streaming partial */ }
  if (!d || !Array.isArray(d.businesses)) {
    return <div className="my-2 p-3 rounded-lg border border-border-color bg-background text-xs text-text-secondary italic">
      업무보고 초안 로딩 중...</div>;
  }
  const done = flat(d, s => s === 'done' || s === undefined);
  const next = flat(d, s => s === 'wip' || s === 'next');
  const ai = Array.isArray(d.ai) ? d.ai : [];
  const warnCount = (d.warnings || []).length;
  const fails = d.failures || [];
  const emptyBiz = d.businesses.filter(b => b.items.length === 0);

  return (
    <div className="my-3 rounded-2xl border border-accent/25 bg-white max-w-2xl overflow-hidden">
      <div className="bg-accent/[0.07] px-4 py-2.5 flex justify-between items-baseline">
        <span className="text-sm font-bold text-accent flex items-center gap-1.5">
          <FileText className="w-4 h-4" /> 업무보고 초안
        </span>
        <span className="text-[10px] text-text-secondary">
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
          <div className="text-base font-extrabold text-accent">{done.length}</div>
          <div className="text-[9.5px] text-text-secondary">완료</div>
        </div>
        <div className="flex-1 py-2">
          <div className="text-base font-extrabold text-accent">{next.length}</div>
          <div className="text-[9.5px] text-text-secondary">진행 · 차주</div>
        </div>
      </div>

      <div className="py-2">
        <div className="px-4 text-[11px] font-extrabold text-accent">■ 완료</div>
        {done.length > 0
          ? done.map((r, i) => <Row key={i} it={r.it} alias={r.alias} />)
          : <div className="px-4 py-1 text-[11px] text-text-secondary/60 italic">(항목 없음)</div>}

        <div className="px-4 pt-2 text-[11px] font-extrabold text-accent">■ 진행 · 차주 계획</div>
        {next.length > 0
          ? next.map((r, i) => <Row key={i} it={r.it} alias={r.alias} />)
          : <div className="px-4 py-1 text-[11px] text-text-secondary/60 italic">(항목 없음)</div>}

        {ai.length > 0 && (
          <>
            <div className="px-4 pt-2 text-[11px] font-extrabold text-accent">■ 업무 - AI 툴 활용</div>
            {ai.map((it, i) => <Row key={i} it={{ ...it, carry: true }} />)}
          </>
        )}
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
        <span className="text-[9.5px] text-text-secondary flex-1">✏️ 수정은 채팅으로 · 화면에 보이는 그대로 메일이 됩니다</span>
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
