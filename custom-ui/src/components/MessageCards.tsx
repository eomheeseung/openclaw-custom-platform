import { useState, useEffect, useMemo, memo } from 'react';
import { Calendar, ClipboardList, Layers, FileText, Download, Eye, RefreshCw, CheckCircle2, AlertTriangle, Plus, X, Pencil } from 'lucide-react';

/* remount 되어도 편집 중이던 그룹 상태 유지
   - Map: 세션 내 remount 대비 (라이트)
   - sessionStorage: 탭 재방문·부분 리로드 대비 (헤비)
   - 키: 원본 JSON의 구조적 fingerprint (공백/문자열 변동 무시)
*/
const groupingStateStore = new Map<string, Group[]>();

function stableGroupingKey(initial: GroupingData | null, messageId?: string): string {
  if (!initial) return '';
  /* 구조 기반 지문: 각 그룹의 sr_no 목록 */
  const sig = (initial.groups || []).map((g, i) => `${i}:${(g.items || []).map(it => it.sr_no).join(',')}`).join('|');
  /* messageId 포함 → 세션별로 격리. 없으면 예전 방식 (하위 호환) */
  return messageId ? `gk:${messageId}:${sig}` : `gk:${sig}`;
}

function restoreGroupingState(key: string): Group[] | null {
  if (!key) return null;
  if (groupingStateStore.has(key)) return groupingStateStore.get(key)!;
  try {
    const raw = sessionStorage.getItem(key);
    if (raw) {
      const parsed = JSON.parse(raw) as Group[];
      groupingStateStore.set(key, parsed);
      return parsed;
    }
  } catch { /* ignore */ }
  return null;
}
function saveGroupingState(key: string, groups: Group[]): void {
  if (!key) return;
  groupingStateStore.set(key, groups);
  try { sessionStorage.setItem(key, JSON.stringify(groups)); } catch { /* ignore */ }
}
function clearGroupingState(key: string): void {
  if (!key) return;
  groupingStateStore.delete(key);
  try { sessionStorage.removeItem(key); } catch { /* ignore */ }
}

/* ─────────────────────────────────────────────────────────
   공통 유틸
   ───────────────────────────────────────────────────────── */

function parseJsonSafe<T>(raw: string): T | null {
  try { return JSON.parse(raw) as T; } catch { return null; }
}

/* 숫자만 입력받아 YYYY-MM-DD로 자동 포맷. 8자리 넘으면 잘라냄. */
function formatDateFromDigits(input: string): string {
  const digits = input.replace(/\D/g, '').slice(0, 8);
  if (digits.length <= 4) return digits;
  if (digits.length <= 6) return `${digits.slice(0, 4)}-${digits.slice(4)}`;
  return `${digits.slice(0, 4)}-${digits.slice(4, 6)}-${digits.slice(6)}`;
}

function CardError({ label, raw }: { label: string; raw: string }) {
  /* 스트리밍 중 partial JSON일 가능성 — closing brace 없으면 조용히 로딩 표시 */
  const trimmed = raw.trim();
  if (!trimmed.endsWith('}')) {
    return (
      <div className="my-2 p-3 rounded-lg border border-border-color bg-background text-xs text-text-secondary italic">
        {label} 카드 로딩 중...
      </div>
    );
  }
  return (
    <div className="my-2 p-3 rounded-lg bg-red-500/10 border border-red-500/30 text-xs text-red-500 font-mono">
      {label} 파싱 실패
      <pre className="mt-1 whitespace-pre-wrap opacity-70">{raw.slice(0, 200)}</pre>
    </div>
  );
}

/* ─────────────────────────────────────────────────────────
   sr-table — SR 조회 결과
   ───────────────────────────────────────────────────────── */

interface SrTableData {
  title?: string;
  range?: string;
  items: Array<{
    sr_no: string;
    title: string;
    status?: string;
    closed_at?: string;
    priority?: string;
  }>;
  /** @deprecated LLM 이 손으로 센 값이라 오차 발생. 요약은 items 에서 직접 계산함 */
  summary?: string;
}

/* 요약 표기 순서 — SR 진행 흐름 역순 (완료된 것부터). 목록에 없는 상태는 뒤에 붙어 합계와 항상 일치 */
const STATUS_SUMMARY_ORDER = ['종료', '해결됨', '진행중', '대기', '분류됨', '신규'];

function buildStatusSummary(items: Array<{ status?: string }>): string {
  const counts = new Map<string, number>();
  for (const it of items) {
    const s = it.status?.trim() || '(상태 없음)';
    counts.set(s, (counts.get(s) ?? 0) + 1);
  }
  const ordered = [
    ...STATUS_SUMMARY_ORDER.filter(s => counts.has(s)),
    ...[...counts.keys()].filter(s => !STATUS_SUMMARY_ORDER.includes(s)),
  ];
  return ordered.map(s => `${s} ${counts.get(s)}건`).join(' · ');
}

export const SrTableCard = memo(function SrTableCard({ raw }: { raw: string }) {
  const data = parseJsonSafe<SrTableData>(raw);
  if (!data || !Array.isArray(data.items)) return <CardError label="sr-table" raw={raw} />;

  /* SR 시스템 CSS와 동일한 배지 색상 */
  const pill = (status?: string) => {
    if (!status) return null;
    let style: React.CSSProperties = { background: 'hsl(var(--muted, 210 40% 96%))', color: 'hsl(215 16% 47%)' };
    if (status.includes('신규')) style = { background: 'hsl(217 91% 60% / 0.1)', color: 'hsl(217 91% 45%)' };
    else if (status.includes('분류')) style = { background: 'hsl(280 65% 60% / 0.1)', color: 'hsl(280 65% 45%)' };
    else if (status.includes('진행')) style = { background: 'hsl(45 93% 47% / 0.1)', color: 'hsl(45 93% 35%)' };
    else if (status.includes('대기')) style = { background: 'hsl(215 20% 85% / 0.5)', color: 'hsl(215 16% 40%)' };
    else if (status.includes('해결')) style = { background: 'hsl(142 76% 36% / 0.1)', color: 'hsl(142 76% 30%)' };
    else if (status.includes('종료') || status.includes('완료')) style = { background: 'hsl(215 16% 90%)', color: 'hsl(215 16% 40%)' };
    return <span className="px-2 py-0.5 rounded-full text-xs font-semibold" style={style}>{status}</span>;
  };

  return (
    <div className="my-3 rounded-2xl border border-accent/25 bg-white p-4 max-w-3xl">
      <div className="flex items-center gap-2 text-sm font-bold text-accent mb-3">
        <ClipboardList className="w-4 h-4" />
        {data.title || 'SR 조회 결과'}
        <span className="text-text-secondary font-normal ml-1">· {data.items.length}건{data.range ? ` (${data.range})` : ''}</span>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="border-b border-border-color">
              <th className="text-left py-1.5 pr-2 text-text-secondary font-semibold uppercase tracking-wide text-[10px]">SR 번호</th>
              <th className="text-left py-1.5 pr-2 text-text-secondary font-semibold uppercase tracking-wide text-[10px]">제목</th>
              <th className="text-left py-1.5 text-text-secondary font-semibold uppercase tracking-wide text-[10px]">상태</th>
            </tr>
          </thead>
          <tbody>
            {data.items.map(it => (
              <tr key={it.sr_no} className="border-b border-border-color/50">
                <td className="py-1.5 pr-2 font-mono text-text-secondary text-[11px]">{it.sr_no}</td>
                <td className="py-1.5 pr-2 text-text-primary">{it.title}</td>
                <td className="py-1.5">{pill(it.status)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {/* 요약은 items 에서 직접 계산 — LLM 이 손으로 센 summary 는 오차가 나므로 쓰지 않음 */}
      {data.items.length > 0 && (
        <div className="mt-2 text-xs text-text-secondary">
          ✔ {buildStatusSummary(data.items)} · 합계 {data.items.length}건
        </div>
      )}
    </div>
  );
});

/* ─────────────────────────────────────────────────────────
   week-picker — 주차 선택
   ───────────────────────────────────────────────────────── */

interface WeekPickerData {
  prompt?: string;
  options: Array<{ label: string; from?: string; to?: string; recommended?: boolean; custom?: boolean }>;
  note?: string;
}

export const WeekPickerCard = memo(function WeekPickerCard({ raw, onSelect }: { raw: string; onSelect?: (text: string) => void }) {
  const data = parseJsonSafe<WeekPickerData>(raw);
  if (!data || !Array.isArray(data.options)) return <CardError label="week-picker" raw={raw} />;

  const [customFrom, setCustomFrom] = useState('');
  const [customTo, setCustomTo] = useState('');

  const pick = (opt: WeekPickerData['options'][number]) => {
    if (opt.custom) return;
    if (!onSelect) return;
    onSelect(`${opt.label}로 진행 (${opt.from} ~ ${opt.to})`);
  };
  const submitCustom = () => {
    if (!customFrom || !customTo || !onSelect) return;
    onSelect(`주차 지정: ${customFrom} ~ ${customTo}`);
  };

  return (
    <div className="my-3 rounded-2xl border border-accent/25 bg-white p-4 max-w-2xl">
      <div className="flex items-center gap-2 text-sm font-bold text-accent mb-3">
        <Calendar className="w-4 h-4" />
        {data.prompt || '주차를 확인해주세요'}
      </div>
      <div className="flex flex-wrap gap-2">
        {data.options.map((opt, i) => (
          opt.custom ? (
            <div key={i} className="w-full mt-1 p-3 rounded-lg bg-background border border-border-color">
              <div className="text-xs text-text-secondary mb-2">{opt.label} (숫자 8자리, 예: 20260713)</div>
              <div className="flex gap-2 items-center flex-wrap">
                <input
                  type="text"
                  inputMode="numeric"
                  placeholder="20260713"
                  value={customFrom}
                  onChange={e => setCustomFrom(formatDateFromDigits(e.target.value))}
                  maxLength={10}
                  className="w-32 px-2 py-1 bg-white border border-border-color rounded text-xs font-mono text-text-primary focus:outline-none focus:ring-1 focus:ring-accent"
                />
                <span className="text-text-secondary">~</span>
                <input
                  type="text"
                  inputMode="numeric"
                  placeholder="20260717"
                  value={customTo}
                  onChange={e => setCustomTo(formatDateFromDigits(e.target.value))}
                  maxLength={10}
                  className="w-32 px-2 py-1 bg-white border border-border-color rounded text-xs font-mono text-text-primary focus:outline-none focus:ring-1 focus:ring-accent"
                />
                <button
                  onClick={submitCustom}
                  disabled={!/^\d{4}-\d{2}-\d{2}$/.test(customFrom) || !/^\d{4}-\d{2}-\d{2}$/.test(customTo)}
                  className="px-3 py-1 bg-accent text-white text-xs rounded disabled:opacity-40 hover:bg-accent-hover"
                >
                  진행
                </button>
              </div>
            </div>
          ) : (
            <button key={i} onClick={() => pick(opt)}
              className={`px-3 py-2 text-xs rounded-lg border transition-all ${
                opt.recommended
                  ? 'border-accent bg-accent/10 text-accent font-semibold hover:bg-accent hover:text-white'
                  : 'border-border-color bg-white text-text-primary hover:border-accent hover:text-accent'
              }`}>
              {opt.recommended && '📅 '}{opt.label}
            </button>
          )
        ))}
      </div>
      {data.note && <div className="mt-3 text-xs text-text-secondary">{data.note}</div>}
    </div>
  );
});

/* ─────────────────────────────────────────────────────────
   grouping-editor — 그룹핑 편집
   ───────────────────────────────────────────────────────── */

interface GroupItem {
  sr_no: string;
  title: string;
  status?: string;
  checked?: boolean;
}
interface Group {
  title: string;
  items: GroupItem[];
}
interface GroupingData {
  prompt?: string;
  groups: Group[];
}

export const GroupingEditorCard = memo(function GroupingEditorCard({ raw, onSelect, messageId }: { raw: string; onSelect?: (text: string) => void; messageId?: string }) {
  const initial = parseJsonSafe<GroupingData>(raw);
  const cacheKey = stableGroupingKey(initial, messageId);
  const [groups, setGroupsRaw] = useState<Group[]>(() => {
    /* remount 후 편집 중이던 상태 복원 (구조 지문 키) */
    const restored = restoreGroupingState(cacheKey);
    if (restored) return restored;
    return initial?.groups?.map(g => ({
      title: g.title,
      items: (g.items || []).map(it => ({ ...it, checked: it.checked !== false })),
    })) || [];
  });
  const setGroups = (updater: Group[] | ((prev: Group[]) => Group[])) => {
    setGroupsRaw(prev => {
      const next = typeof updater === 'function' ? (updater as (p: Group[]) => Group[])(prev) : updater;
      saveGroupingState(cacheKey, next);
      return next;
    });
  };
  /* 첫 마운트 시에도 store에 초기값 저장 (다음 remount 위해) */
  useEffect(() => {
    if (!cacheKey) return;
    if (!groupingStateStore.has(cacheKey)) saveGroupingState(cacheKey, groups);
  }, [cacheKey]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!initial) return <CardError label="grouping-editor" raw={raw} />;

  const setTitle = (gi: number, v: string) => setGroups(prev => prev.map((g, i) => i === gi ? { ...g, title: v } : g));
  const toggleItem = (gi: number, ii: number) => setGroups(prev => prev.map((g, i) =>
    i === gi ? { ...g, items: g.items.map((it, j) => j === ii ? { ...it, checked: !it.checked } : it) } : g
  ));
  const removeGroup = (gi: number) => setGroups(prev => prev.filter((_, i) => i !== gi));
  const addGroup = () => setGroups(prev => [...prev, { title: '새 그룹', items: [] }]);
  const moveItem = (fromGi: number, itemIdx: number, toGi: number) => setGroups(prev => {
    const it = prev[fromGi]?.items[itemIdx]; if (!it) return prev;
    return prev.map((g, i) => {
      if (i === fromGi) return { ...g, items: g.items.filter((_, j) => j !== itemIdx) };
      if (i === toGi) return { ...g, items: [...g.items, it] };
      return g;
    });
  });

  const confirm = () => {
    if (!onSelect) return;

    /* 초기 그룹의 title 집합 (수동 추가 그룹 감지용) */
    const initialTitles = new Set((initial?.groups || []).map(g => g.title));

    /* 확정된 그룹 (기존 SR 포함) · 체크된 SR 만 · 빈 그룹은 확정에서 제외 */
    const keptGroups = groups
      .map(g => ({ title: g.title, items: g.items.filter(it => it.checked) }))
      .filter(g => g.items.length > 0);

    /* 수동 추가 그룹: items 비어있고 title 이 "새 그룹" 이 아니고 initial 에 없던 title
       → 그룹 자체를 하나의 진행사항으로 간주 (그룹 title = 진행사항 내용) */
    const manualGroups = groups.filter(g =>
      g.items.length === 0 &&
      g.title.trim() !== '' &&
      g.title.trim() !== '새 그룹' &&
      !initialTitles.has(g.title)
    );

    /* 초기 SR 목록 · 현재 유지된 SR 목록 · 차이 = 제외 */
    const initialItems = (initial?.groups || []).flatMap(g => g.items || []);
    const initialAll = new Set(initialItems.map(it => it.sr_no));
    const currentKeptSet = new Set(keptGroups.flatMap(g => g.items.map(it => it.sr_no)));
    const excludedSrNos = [...initialAll].filter(sr => !currentKeptSet.has(sr));
    const excludedItems = initialItems.filter(it => excludedSrNos.includes(it.sr_no));

    /* 메시지 조립
       ⚠ 이 형식은 MessageList 의 findGroupingConfirmBefore() 가 파싱함 —
         【확정된 그룹】 헤더 · "N. 그룹명" · " - SR번호 제목" 구조를 바꾸면 그쪽도 같이 고칠 것 */
    let msg = '이 그룹핑으로 확정:\n\n【확정된 그룹】 (아래 SR 제목은 원본 그대로임 · details 에 복사하지 말고 수행사 관점 명사종결로 재작성할 것)\n';
    if (keptGroups.length === 0) {
      msg += '(없음)\n';
    } else {
      msg += keptGroups.map((g, i) =>
        `${i + 1}. ${g.title}\n${g.items.map(k => `   - ${k.sr_no} ${k.title}`).join('\n')}`
      ).join('\n');
    }

    if (manualGroups.length > 0) {
      msg += '\n\n【수동 추가 진행사항】 (사용자가 grouping-editor 에서 새 그룹으로 직접 입력한 항목 · SR 조회에 없던 것)\n';
      msg += manualGroups.map((g, i) => `${i + 1}. ${g.title}`).join('\n');
    }

    if (excludedItems.length > 0) {
      msg += '\n\n【제외된 SR】 (체크 해제 · 그룹 삭제로 이번 주 보고서에서 제외)\n';
      msg += excludedItems.map(it => `   - ${it.sr_no} ${it.title}`).join('\n');
    }

    onSelect(msg);
  };
  const reset = () => {
    const fresh = initial?.groups?.map(g => ({
      title: g.title,
      items: (g.items || []).map(it => ({ ...it, checked: it.checked !== false })),
    })) || [];
    clearGroupingState(cacheKey);
    setGroups(fresh);
  };

  return (
    <div className="my-3 rounded-2xl border border-accent/25 bg-white p-4 max-w-3xl">
      <div className="flex items-center gap-2 text-sm font-bold text-accent mb-1">
        <Layers className="w-4 h-4" />
        {initial.prompt || '작업항목 그룹핑'}
      </div>
      <div className="text-xs text-text-secondary mb-3">제목 편집·항목 체크·그룹 이동 후 [이대로 진행]</div>

      <div className="space-y-2">
        {groups.map((g, gi) => (
          <div key={gi} className="rounded-lg border border-border-color bg-background p-2.5">
            <div className="flex items-center gap-2 mb-1.5">
              <span className="text-xs font-bold text-text-secondary w-4">{gi + 1}.</span>
              <input value={g.title} onChange={e => setTitle(gi, e.target.value)}
                className="flex-1 px-2 py-1 bg-white border border-border-color rounded text-xs font-semibold text-text-primary focus:outline-none focus:ring-1 focus:ring-accent" />
              <button onClick={() => removeGroup(gi)} className="p-1 text-text-secondary hover:text-red-500" title="그룹 삭제">
                <X className="w-3.5 h-3.5" />
              </button>
            </div>
            <ul className="space-y-1 pl-6">
              {g.items.map((it, ii) => (
                <li key={ii} className="flex items-center gap-2 text-xs">
                  <input type="checkbox" checked={it.checked !== false} onChange={() => toggleItem(gi, ii)} />
                  <span className="font-mono text-text-secondary">{it.sr_no}</span>
                  <span className="text-text-primary flex-1 truncate">{it.title}</span>
                  {groups.length > 1 && (
                    <select
                      className="text-[10px] bg-transparent border border-border-color rounded px-1 py-0.5 text-text-secondary"
                      value={gi}
                      onChange={e => moveItem(gi, ii, parseInt(e.target.value))}
                    >
                      {groups.map((gg, gi2) => (
                        <option key={gi2} value={gi2}>→ {gi2 + 1}. {gg.title.slice(0, 10)}</option>
                      ))}
                    </select>
                  )}
                </li>
              ))}
              {g.items.length === 0 && <li className="text-xs text-text-secondary italic">항목 없음</li>}
            </ul>
          </div>
        ))}
      </div>

      <button onClick={addGroup} className="mt-2 w-full py-1.5 border border-dashed border-border-color rounded-lg text-xs text-text-secondary hover:border-accent hover:text-accent flex items-center justify-center gap-1">
        <Plus className="w-3 h-3" /> 새 그룹 추가
      </button>
      <div className="mt-1 text-[10px] text-text-secondary/70 text-center leading-relaxed">
        새 그룹의 제목을 입력하고 [이대로 진행] 누르면 그 제목이 진행사항에 그대로 추가돼요.
      </div>

      <div className="flex justify-between items-center gap-2 mt-3">
        <button onClick={reset} className="px-3 py-1.5 text-xs border border-border-color rounded-lg text-text-secondary hover:border-red-500 hover:text-red-500 flex items-center gap-1" title="편집 내용 취소하고 최초 상태로">
          <RefreshCw className="w-3 h-3 rotate-180" />
          초기화
        </button>
        <button onClick={confirm} className="px-4 py-1.5 text-xs bg-accent hover:bg-accent-hover text-white font-semibold rounded-lg flex items-center gap-1">
          <CheckCircle2 className="w-3.5 h-3.5" />
          이대로 진행
        </button>
      </div>
    </div>
  );
});

/* ─────────────────────────────────────────────────────────
   draft-card — 초안 미리보기 (with [확인 필요])
   ───────────────────────────────────────────────────────── */

interface DraftItem {
  text: string;
  confirm_needed?: boolean;
  status?: string;
  /* SR 조회 결과 기반 항목의 원본 SR 번호. UI 검증용 표시 · hwpx 출력에는 안 나감 */
  sr_no?: string;
}
interface DraftWorkItem {
  no: string | number;
  title: string;
  details?: string[];
  status?: string;
  memo?: string;
  confirm_needed?: boolean;
  /* 진행중 SR 의 원본 SR 번호. planned 항목과 동기화하는 매칭 키 · hwpx 출력에는 안 나감 */
  sr_no?: string;
}
interface DraftCardData {
  title?: string;
  period?: string;
  progress: (DraftItem | string)[];
  planned: (DraftItem | string)[];
  remarks?: (DraftItem | string)[];   // 업무 참고 사항 및 비고
  work_items: DraftWorkItem[];
  work_section_title?: string;   // 기본: "작업 항목"
  work_col_title?: string;       // 기본: "상세 내용"
  progress_label?: string;       // 기본: "진행사항"
  planned_label?: string;        // 기본: "예정사항"
  remarks_label?: string;        // 기본: "업무 참고 사항 및 비고"
}

/* ─────────────────────────────────────────────────────────
   draft-card 누락 검증
   기준: 같은 세션의 sr-table (같은 시점 스냅샷이라 API 재조회보다 안전)
   검사 대상: 예정사항(신규·분류됨·대기·진행중)만 — 완료 SR 은 그룹핑에서 빠지는 게 정상이라 오탐 원인
   ───────────────────────────────────────────────────────── */

/** 예정사항에 들어가야 하는 상태 (= sr_fetch.py 의 STATUS_OPEN) */
const PLANNED_STATUSES = ['신규', '분류됨', '대기', '진행중'];

export interface SrBaselineItem { sr_no: string; title: string; status: string }

export interface DraftMissing {
  planned: SrBaselineItem[];
  workItems: SrBaselineItem[];
}

/** sr-table 카드 raw JSON → 검증 기준 목록. 파싱 실패하면 null (= 검증 생략) */
export function parseSrBaseline(raw: string): SrBaselineItem[] | null {
  const d = parseJsonSafe<{ items?: Array<{ sr_no?: string; title?: string; status?: string }> }>(raw);
  if (!d || !Array.isArray(d.items)) return null;
  return d.items
    .filter(it => it.sr_no && it.status)
    .map(it => ({ sr_no: it.sr_no!, title: it.title || '', status: it.status! }));
}

/** 기준 대비 draft-card 에서 빠진 SR 찾기 */
export function findDraftMissing(draft: DraftCardData, baseline: SrBaselineItem[]): DraftMissing {
  const plannedHave = new Set(
    (draft.planned || []).map(p => normalizeItem(p as DraftItem | string).sr_no).filter(Boolean) as string[],
  );
  const workHave = new Set((draft.work_items || []).map(w => w.sr_no).filter(Boolean) as string[]);

  const missing: DraftMissing = { planned: [], workItems: [] };
  for (const sr of baseline) {
    if (!PLANNED_STATUSES.includes(sr.status)) continue;
    if (!plannedHave.has(sr.sr_no)) missing.planned.push(sr);
    /* work_items 는 진행중만 대상 (신규·분류됨·대기는 표에 넣지 않는 게 규칙) */
    if (sr.status === '진행중' && !workHave.has(sr.sr_no)) missing.workItems.push(sr);
  }
  return missing;
}

/* ── 그룹핑 확정 결과 (작업완료 행의 SR 매핑 · 종료 SR 누락 검증에 사용) ──
   출처: GroupingEditorCard.confirm() 이 만든 사용자 메시지.
   형식이 바뀌면 여기도 같이 고칠 것. */
export interface ConfirmedGroup { title: string; srs: SrBaselineItem[] }

export function parseGroupingConfirm(text: string): ConfirmedGroup[] | null {
  const head = text.indexOf('【확정된 그룹】');
  if (head === -1) return null;
  /* 다음 섹션(【수동 추가…】/【제외된 SR】) 전까지만 */
  const rest = text.slice(head);
  const nextSection = rest.slice(1).search(/【/);
  const body = nextSection === -1 ? rest : rest.slice(0, nextSection + 1);

  const groups: ConfirmedGroup[] = [];
  for (const line of body.split('\n')) {
    const g = line.match(/^\s*\d+\.\s+(.+?)\s*$/);
    if (g) { groups.push({ title: g[1], srs: [] }); continue; }
    /* " - SR번호 제목" · 앞의 공백/대시 개수는 유연하게 */
    const s = line.match(/^\s*[-·]\s*([A-Za-z][\w-]*-\d{8}-\d+)\s+(.+?)\s*$/);
    if (s && groups.length) groups[groups.length - 1].srs.push({ sr_no: s[1], title: s[2], status: '종료' });
  }
  return groups.length ? groups : null;
}

/** 확정된 그룹 중 draft-card work_items 에 안 들어간 것 */
export function findMissingGroups(draft: DraftCardData, confirmed: ConfirmedGroup[]): ConfirmedGroup[] {
  const titles = new Set((draft.work_items || []).map(w => w.title?.trim()).filter(Boolean));
  /* SR 이 하나도 없는 그룹(수동 추가)은 검증 대상 아님 */
  return confirmed.filter(g => g.srs.length > 0 && !titles.has(g.title.trim()));
}

export function countMissing(m: DraftMissing | null): number {
  if (!m) return 0;
  /* 같은 SR 이 양쪽에 빠졌으면 1건으로 셈 */
  return new Set([...m.planned, ...m.workItems].map(s => s.sr_no)).size;
}

/** LLM 에 보낼 교정 지시문 */
function buildRepairInstruction(m: DraftMissing | null, groups: ConfirmedGroup[] | null): string {
  const lines: string[] = [];

  if (m) {
    const bySr = new Map<string, { item: SrBaselineItem; planned: boolean; work: boolean }>();
    for (const s of m.planned) bySr.set(s.sr_no, { item: s, planned: true, work: false });
    for (const s of m.workItems) {
      const e = bySr.get(s.sr_no);
      if (e) e.work = true;
      else bySr.set(s.sr_no, { item: s, planned: false, work: true });
    }
    for (const { item, planned, work } of bySr.values()) {
      const targets = [planned && 'planned', work && 'work_items(status="진행중", sr_no 포함)']
        .filter(Boolean).join(' + ');
      lines.push(`· ${item.sr_no} (${item.status}) — ${item.title}\n  → ${targets} 에 추가`);
    }
  }

  for (const g of groups || []) {
    lines.push(
      `· 확정된 그룹 "${g.title}" 이 work_items 에서 통째로 빠짐\n` +
      `  → work_items 에 status="작업완료" 로 추가 · title 은 그룹명 그대로\n` +
      `  → details 는 아래 SR 을 수행사 관점 명사종결로 재작성 (원본 제목 복사 금지):\n` +
      g.srs.map(s => `     ${s.sr_no} ${s.title}`).join('\n'),
    );
  }

  return [
    'draft-card 에서 아래 항목이 누락됐어. 추가해서 draft-card 를 다시 뱉어줘.',
    '',
    ...lines,
    '',
    '문구는 수행사 관점 명사종결형으로 재작성 (기존 항목들과 톤 맞춰서 · `~요청`·`~중` 금지).',
    '이미 있는 항목·사용자가 편집한 내용은 그대로 유지.',
  ].join('\n');
}

/* 에이전트가 문자열 배열로 넘길 수도 있고 객체 배열로 넘길 수도 있어서 정규화 */
function normalizeItem(it: DraftItem | string | null | undefined): DraftItem {
  if (it == null) return { text: '' };
  if (typeof it === 'string') return { text: it };
  const raw = it as DraftItem & { title?: string };
  return {
    text: raw.text || raw.title || '',
    confirm_needed: raw.confirm_needed,
    status: raw.status,
    sr_no: raw.sr_no,
  };
}

function ConfirmChip({ children, onClick }: { children: React.ReactNode; onClick?: () => void }) {
  return (
    <button onClick={onClick} className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-amber-500/20 border border-dashed border-amber-500 text-amber-700 text-xs font-semibold cursor-pointer hover:bg-amber-500/30">
      <AlertTriangle className="w-3 h-3" />
      {children}
    </button>
  );
}

export const DraftCard = memo(function DraftCard({ raw, onSelect, onPrefill, srBaseline, confirmedGroups }: { raw: string; onSelect?: (text: string) => void; onPrefill?: (text: string) => void; srBaseline?: SrBaselineItem[] | null; confirmedGroups?: ConfirmedGroup[] | null }) {
  const data = parseJsonSafe<DraftCardData>(raw);
  /* 경고 접기 상태 · 훅은 early return 앞에 있어야 함 */
  const [missingDismissed, setMissingDismissed] = useState(false);
  const [confirmPrompt, setConfirmPrompt] = useState(false);

  const missing = useMemo(() => {
    /* sr-table 이 없으면 (압축·다른 흐름) 검증 생략 */
    if (!data || !srBaseline || srBaseline.length === 0) return null;
    const m = findDraftMissing(data, srBaseline);
    return m.planned.length || m.workItems.length ? m : null;
  }, [data, srBaseline]);

  /* 확정된 그룹인데 작업표에서 통째로 빠진 것 (종료 SR 누락) */
  const missingGroups = useMemo(() => {
    if (!data || !confirmedGroups?.length) return null;
    const g = findMissingGroups(data, confirmedGroups);
    return g.length ? g : null;
  }, [data, confirmedGroups]);

  /* 작업완료 행 title → 소속 SR 목록 */
  const groupSrMap = useMemo(() => {
    const m = new Map<string, SrBaselineItem[]>();
    for (const g of confirmedGroups || []) m.set(g.title.trim(), g.srs);
    return m;
  }, [confirmedGroups]);

  if (!data) return <CardError label="draft-card" raw={raw} />;

  const unresolved = missing && !missingDismissed ? missing : null;
  const unresolvedGroups = missingGroups && !missingDismissed ? missingGroups : null;
  const hasAnyMissing = !!(unresolved || unresolvedGroups);

  /* 편집·추가 = 챗 입력창에 프리필 (사용자가 실제 내용 타이핑 후 전송) */
  const prefill = (text: string) => (onPrefill ?? onSelect)?.(text);
  const askEdit = (label: string) => () => prefill(`${label} 내용을 이렇게 수정: `);
  const repairMissing = () => {
    if (!hasAnyMissing) return;
    onSelect?.(buildRepairInstruction(unresolved, unresolvedGroups));
    setConfirmPrompt(false);
  };
  /* 확정 = 즉시 전송 · 미해결 누락이 있으면 한 번 되물음 (강제 아님) */
  const doConfirm = () => onSelect?.('초안 이대로 확정. 다운로드까지 진행해줘');
  const confirmAll = () => {
    if (hasAnyMissing) { setConfirmPrompt(true); return; }
    doConfirm();
  };
  const resetDraft = () => onSelect?.('내가 수정한 내용 다 취소하고 처음 초안 그대로 다시 뱉어줘');

  return (
    <div className="my-3 rounded-2xl border border-accent/25 bg-gradient-to-br from-white to-accent/[0.02] p-4 max-w-3xl">
      {hasAnyMissing && (
        <div className="mb-3 rounded-xl border border-amber-400/60 bg-amber-50/70 p-3">
          <div className="flex items-center gap-1.5 text-xs font-bold text-amber-700">
            <AlertTriangle className="w-3.5 h-3.5" />
            SR 조회 결과와 다릅니다 — {countMissing(unresolved) + (unresolvedGroups?.length || 0)}건 누락
          </div>
          {unresolvedGroups && (
            <ul className="mt-2 space-y-1.5">
              {unresolvedGroups.map(g => (
                <li key={g.title} className="text-[11px] leading-snug">
                  <span className="text-text-primary font-semibold">{g.title}</span>
                  <span className="ml-1.5 text-amber-700">— {data.work_section_title || '주요 과업별 상세 수행 내용'} 에서 그룹 전체 누락</span>
                  <div className="font-mono text-text-secondary/70 text-[9px] mt-0.5">
                    {g.srs.map(s => s.sr_no).join(' · ')}
                  </div>
                </li>
              ))}
            </ul>
          )}
          {unresolved && (
            <ul className="mt-2 space-y-1.5">
              {[...new Map<string, SrBaselineItem>(
                [...unresolved.planned, ...unresolved.workItems].map(s => [s.sr_no, s] as const),
              ).values()].map(s => {
                const where = [
                  unresolved.planned.some(p => p.sr_no === s.sr_no) && (data.planned_label || '예정사항'),
                  unresolved.workItems.some(w => w.sr_no === s.sr_no) && (data.work_section_title || '주요 과업별 상세 수행 내용'),
                ].filter(Boolean).join(' · ');
                return (
                  <li key={s.sr_no} className="text-[11px] leading-snug">
                    <span className="font-mono text-text-secondary">{s.sr_no}</span>
                    <span className="ml-1.5 text-text-primary">{s.title}</span>
                    <span className="ml-1.5 text-amber-700">— {where}</span>
                  </li>
                );
              })}
            </ul>
          )}
          {confirmPrompt && (
            <div className="mt-2 text-[11px] text-amber-800 font-semibold">
              누락이 반영되지 않은 상태입니다. 되채우고 진행할까요?
            </div>
          )}
          <div className="mt-2.5 flex gap-2 justify-end">
            <button
              onClick={() => { setMissingDismissed(true); setConfirmPrompt(false); }}
              className="px-2.5 py-1 text-[11px] border border-border-color rounded-lg text-text-secondary hover:text-text-primary"
            >
              {confirmPrompt ? '무시하고 진행' : '무시'}
            </button>
            {confirmPrompt && (
              <button onClick={doConfirm} className="px-2.5 py-1 text-[11px] border border-border-color rounded-lg text-text-secondary hover:text-text-primary">
                그대로 진행
              </button>
            )}
            <button onClick={repairMissing} className="px-3 py-1 text-[11px] bg-amber-500 hover:bg-amber-600 text-white font-semibold rounded-lg">
              {confirmPrompt ? '되채우고 진행' : '되채우기'}
            </button>
          </div>
        </div>
      )}
      <div className="flex items-center gap-2 text-sm font-bold text-accent mb-1">
        <FileText className="w-4 h-4" />
        {data.title || '주간보고서 초안'}
      </div>
      {data.period && <div className="text-xs text-text-secondary mb-3">{data.period}</div>}

      <div className="space-y-3">
        <section>
          <div className="text-xs font-bold text-text-primary mb-1">{data.progress_label || '진행사항'}</div>
          {data.progress && data.progress.length > 0 ? (
            <ul className="text-xs space-y-1 pl-4 list-disc marker:text-text-secondary">
              {data.progress.map((raw, i) => {
                const it = normalizeItem(raw);
                return (
                <li key={i} className="text-text-primary group flex items-start gap-1.5">
                  <button
                    onClick={() => prefill(`진행사항 "${it.text}" 을 이렇게 수정해줘: `)}
                    className="flex-1 text-left hover:bg-amber-500/10 rounded px-1 -mx-1 transition-colors"
                    title="클릭하면 채팅창에 프리필됨"
                  >
                    {it.text}
                    {it.status && <span className="ml-2 px-1.5 py-0.5 rounded bg-amber-500/15 text-amber-600 text-[10px] font-semibold">{it.status}</span>}
                    <Pencil className="inline-block w-2.5 h-2.5 ml-1 opacity-0 group-hover:opacity-60 text-text-secondary" />
                  </button>
                </li>
              );})}
            </ul>
          ) : (
            <div className="text-xs text-text-secondary italic pl-4">(항목 없음)</div>
          )}
        </section>

        <section>
          <div className="flex items-center justify-between mb-1">
            <div className="text-xs font-bold text-text-primary">{data.planned_label || '예정사항'}</div>
            <button
              onClick={() => prefill('예정사항에 다음 항목 추가해줘: ')}
              className="text-[10px] px-1.5 py-0.5 rounded border border-border-color text-text-secondary hover:border-accent hover:text-accent flex items-center gap-1"
              title="클릭하면 채팅창에 프리필됨. 항목 내용 이어서 타이핑 후 엔터"
            >
              <Plus className="w-2.5 h-2.5" />
              항목 추가
            </button>
          </div>
          {data.planned && data.planned.length > 0 ? (
            <ul className="text-xs space-y-1 pl-4 list-disc marker:text-text-secondary">
              {data.planned.map((raw, i) => {
                const it = normalizeItem(raw);
                return (
                <li key={i} className="text-text-primary group flex items-start gap-1.5">
                  <button
                    onClick={() => prefill(`예정사항 "${it.text}" 을 이렇게 수정해줘: `)}
                    className="flex-1 text-left hover:bg-amber-500/10 rounded px-1 -mx-1 transition-colors"
                    title="클릭하면 채팅창에 프리필됨. 수정 내용 이어서 타이핑 후 엔터"
                  >
                    {it.sr_no && <span className="mr-1.5 px-1 py-0.5 rounded bg-text-secondary/10 text-text-secondary text-[9px] font-mono">{it.sr_no}</span>}
                    {it.text}
                    <Pencil className="inline-block w-2.5 h-2.5 ml-1 opacity-0 group-hover:opacity-60 text-text-secondary" />
                  </button>
                </li>
              );})}
            </ul>
          ) : (
            <div className="text-xs text-text-secondary italic pl-4">(비어 있음 · [항목 추가] 로 채워)</div>
          )}
        </section>

        <section>
          <div className="flex items-center justify-between mb-1">
            <div className="text-xs font-bold text-text-primary">{data.remarks_label || '업무 참고 사항 및 비고'}</div>
            <button
              onClick={() => prefill('업무 참고 사항에 다음 항목 추가해줘: ')}
              className="text-[10px] px-1.5 py-0.5 rounded border border-border-color text-text-secondary hover:border-accent hover:text-accent flex items-center gap-1"
              title="클릭하면 채팅창에 프리필됨. 항목 내용 이어서 타이핑 후 엔터"
            >
              <Plus className="w-2.5 h-2.5" />
              항목 추가
            </button>
          </div>
          {data.remarks && data.remarks.length > 0 ? (
            <ul className="text-xs space-y-1 pl-4 list-disc marker:text-text-secondary">
              {data.remarks.map((raw, i) => {
                const it = normalizeItem(raw);
                return (
                <li key={i} className="text-text-primary group flex items-start gap-1.5">
                  <button
                    onClick={() => prefill(`업무 참고 사항 "${it.text}" 을 이렇게 수정해줘: `)}
                    className="flex-1 text-left hover:bg-amber-500/10 rounded px-1 -mx-1 transition-colors"
                    title="클릭하면 채팅창에 프리필됨. 수정 내용 이어서 타이핑 후 엔터"
                  >
                    {it.text}
                    <Pencil className="inline-block w-2.5 h-2.5 ml-1 opacity-0 group-hover:opacity-60 text-text-secondary" />
                  </button>
                </li>
              );})}
            </ul>
          ) : (
            <div className="text-xs text-text-secondary italic pl-4">(비어 있음 · [항목 추가] 로 채워)</div>
          )}
        </section>

        <section>
          <div className="text-xs font-bold text-text-primary mb-1">{data.work_section_title || '작업 항목'}</div>
          <div className="overflow-x-auto">
            <table className="w-full text-xs border border-border-color">
              <thead className="bg-accent/5">
                <tr>
                  <th className="p-1.5 text-center border-b border-border-color w-10">NO</th>
                  <th className="p-1.5 text-left border-b border-border-color">{data.work_col_title || '상세 내용'}</th>
                  <th className="p-1.5 text-left border-b border-border-color w-24">작업현황</th>
                  <th className="p-1.5 text-left border-b border-border-color w-32">비고</th>
                </tr>
              </thead>
              <tbody>
                {data.work_items?.map((wi, i) => {
                  /* 작업완료 행은 그룹(N개 SR) — 확정 메시지에서 매핑을 가져옴.
                     details 개수와 SR 개수가 같을 때만 줄별로 붙이고, 다르면 행 하단에 모아서 표시 (어긋난 뱃지 방지) */
                  const groupSrs = wi.title ? groupSrMap.get(wi.title.trim()) : undefined;
                  const dets = wi.details || [];
                  const perLine = !!groupSrs && groupSrs.length > 0 && groupSrs.length === dets.length;
                  return (
                  <tr key={i} className="border-b border-border-color/60">
                    <td className="p-1.5 text-center text-text-secondary">{wi.no}</td>
                    <td className="p-1.5">
                      <div className="font-semibold text-text-primary">
                        {/* sr_no 는 진행중 SR 에만 붙음 (예정사항과 동기화용 키) · hwpx 출력에는 안 나감 */}
                        {wi.sr_no && (
                          <span className="mr-1.5 px-1 py-0.5 rounded bg-text-secondary/10 text-text-secondary text-[9px] font-mono font-normal align-middle">
                            {wi.sr_no}
                          </span>
                        )}
                        {wi.title}
                      </div>
                      {dets.length > 0 && (
                        <ul className="mt-1 text-[11px] text-text-secondary list-disc pl-4 space-y-0.5">
                          {dets.map((d, j) => (
                            <li key={j}>
                              {perLine && (
                                <span className="mr-1 px-1 py-0.5 rounded bg-text-secondary/10 text-[9px] font-mono">
                                  {groupSrs![j].sr_no}
                                </span>
                              )}
                              {d}
                            </li>
                          ))}
                        </ul>
                      )}
                      {groupSrs && groupSrs.length > 0 && !perLine && (
                        <div className="mt-1 pl-4 text-[9px] font-mono text-text-secondary/70">
                          {groupSrs.map(s => s.sr_no).join(' · ')}
                        </div>
                      )}
                    </td>
                    <td className="p-1.5 text-text-primary">{wi.status || '-'}</td>
                    <td className="p-1.5">{wi.memo || ''}</td>
                  </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>
      </div>

      <div className="flex justify-between items-center gap-2 mt-4">
        <button onClick={resetDraft} className="px-3 py-1.5 text-xs border border-border-color rounded-lg text-text-secondary hover:border-red-500 hover:text-red-500 flex items-center gap-1" title="편집 내용 다 취소하고 처음 초안으로">
          <RefreshCw className="w-3 h-3 rotate-180" />
          초기화
        </button>
        <button onClick={confirmAll} className="px-4 py-1.5 text-xs bg-accent hover:bg-accent-hover text-white font-semibold rounded-lg flex items-center gap-1">
          <CheckCircle2 className="w-3.5 h-3.5" />
          이대로 다운로드
        </button>
      </div>
    </div>
  );
});

/* ─────────────────────────────────────────────────────────
   download-card — 다운로드 완료
   ───────────────────────────────────────────────────────── */

interface DownloadCardData {
  title?: string;
  filename: string;
  download_url: string;
  preview_url?: string;
  meta?: string[];
  cron_hint?: boolean;
}

export const DownloadCard = memo(function DownloadCard({ raw, onSelect }: { raw: string; onSelect?: (text: string) => void }) {
  const data = parseJsonSafe<DownloadCardData>(raw);
  const [dlState, setDlState] = useState<'idle' | 'loading' | 'error'>('idle');
  const [dlError, setDlError] = useState<string>('');
  if (!data || !data.filename || !data.download_url) return <CardError label="download-card" raw={raw} />;

  const registerCron = () => onSelect?.('매주 금요일 15시에 자동으로 초안 생성해줘');

  /* HTTP 사이트의 hwpx 직접 링크는 Chrome이 Safe Browsing으로 차단.
     fetch로 바이트 받아서 Blob URL로 트리거하면 우회됨. */
  const handleDownload = async (e: React.MouseEvent) => {
    e.preventDefault();
    setDlState('loading');
    setDlError('');
    try {
      const resp = await fetch(data.download_url, { credentials: 'include' });
      if (!resp.ok) {
        const bodyText = await resp.text().catch(() => '');
        throw new Error(`HTTP ${resp.status} ${resp.statusText}${bodyText ? ' · ' + bodyText.slice(0, 200) : ''}`);
      }
      const blob = await resp.blob();
      if (blob.size < 100) throw new Error(`파일 크기 이상 (${blob.size} bytes)`);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = data.filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      setDlState('idle');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error('Download failed:', err, 'url:', data.download_url);
      setDlError(msg);
      setDlState('error');
    }
  };

  return (
    <div className="my-3 rounded-2xl border-2 border-emerald-500/40 bg-white p-4 max-w-2xl">
      <div className="flex items-center gap-2 text-sm font-bold text-emerald-600 mb-2">
        <CheckCircle2 className="w-4 h-4" />
        {data.title || '주간보고서 완성'}
      </div>
      <div className="inline-block bg-background border border-border-color rounded-lg px-3 py-1.5 font-mono text-xs text-text-primary mb-3 break-all">
        {data.filename}
      </div>

      <div className="flex gap-2 flex-wrap items-center">
        <button onClick={handleDownload} disabled={dlState === 'loading'}
          className="px-4 py-2 bg-emerald-500 hover:bg-emerald-600 text-white text-xs font-semibold rounded-lg flex items-center gap-1.5 no-underline disabled:opacity-60">
          <Download className="w-3.5 h-3.5" />
          {dlState === 'loading' ? '다운로드 중...' : dlState === 'error' ? '실패 · 재시도' : 'hwpx 다운로드'}
        </button>
        <a href={data.download_url} target="_blank" rel="noopener noreferrer"
          className="px-3 py-2 text-xs border border-emerald-500/40 text-emerald-600 rounded-lg no-underline hover:bg-emerald-500/10"
          title="위 버튼이 실패하면 이걸로 직접 링크 열기">
          직접 링크
        </a>
        {data.preview_url && (
          <a href={data.preview_url} target="_blank" rel="noopener noreferrer"
            className="px-3 py-2 text-xs border border-emerald-500/40 text-emerald-600 rounded-lg no-underline hover:bg-emerald-500/10">
            <Eye className="w-3.5 h-3.5 inline mr-1" />
            미리보기
          </a>
        )}
        {dlState === 'error' && dlError && (
          <div className="text-xs text-red-500 max-w-full break-all">
            <b>실패 원인:</b> {dlError}
          </div>
        )}
      </div>

      {data.meta && data.meta.length > 0 && (
        <div className="mt-3 text-xs text-text-secondary space-y-0.5">
          {data.meta.map((m, i) => <div key={i}>· {m}</div>)}
        </div>
      )}

      {data.cron_hint && (
        <div className="mt-3 p-2.5 rounded-lg bg-amber-500/10 border-l-4 border-amber-500 text-xs text-text-primary">
          <b>다음 번 자동 실행</b> — 매주 금요일 오후 3시에 자동 초안 생성 원하면{' '}
          <button onClick={registerCron} className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-accent/10 border border-accent/30 text-accent font-semibold text-[10px] hover:bg-accent hover:text-white">
            ⏰ cron 등록
          </button>
        </div>
      )}
    </div>
  );
});
