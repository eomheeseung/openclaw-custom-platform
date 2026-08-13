import { useState, useEffect, useCallback } from 'react';
import { Briefcase, Plus, X, Loader2, Archive, RotateCcw, Save, ChevronDown, ChevronRight } from 'lucide-react';

/* 사업 마스터 — /opt/openclaw/data/businesses.json 한 파일을 16명이 공유한다.
   담당자를 바꾸면 그 사람의 주간보고 내용이 바뀌므로 관리자만 만진다.

   ⚠ 검증은 서버가 한다. 여기서 막는 건 안내일 뿐이고, 저장 결과는 서버 응답을 따른다.
   양식이 깨지면 수집이 사업을 못 찾아 모든 항목이 '공통' 으로 떨어진다. */

export interface Business {
  id: string;
  name: string;
  alias: string;
  aliases?: string[];
  org: string;
  owners: string[];
  supporters: string[];
  members?: string[];
  dooray_project_id?: string;
  figma_file_keys?: string[];
  kind?: string;
  closed?: boolean;
}

interface Props {
  /** 번호 → 이름. 담당자를 번호가 아니라 이름으로 고르게 한다 */
  userNames: Record<string, string>;
}

const empty = (kind: string): Business => ({
  id: '', name: '', alias: '', org: '', owners: [], supporters: [],
  dooray_project_id: '', figma_file_keys: [], ...(kind === 'service' ? { kind } : {}),
});

/** 사람 고르기 — 칩을 눌러 넣고 뺀다 */
function PeoplePicker({
  label, hint, selected, exclude, userNames, onChange,
}: {
  label: string; hint?: string; selected: string[]; exclude: string[];
  userNames: Record<string, string>; onChange: (v: string[]) => void;
}) {
  const all = Object.keys(userNames).sort();
  return (
    <div>
      <div className="text-xs text-text-secondary mb-1">
        {label}{hint && <span className="ml-1 text-text-secondary/60">{hint}</span>}
      </div>
      <div className="flex flex-wrap gap-1">
        {all.map(nn => {
          const on = selected.includes(nn);
          const blocked = !on && exclude.includes(nn);
          return (
            <button key={nn} type="button" disabled={blocked}
              onClick={() => onChange(on ? selected.filter(x => x !== nn) : [...selected, nn])}
              className={`px-2 py-1 rounded-lg text-xs border transition-colors ${
                on ? 'bg-accent text-white border-accent'
                  : blocked ? 'border-border-color text-text-secondary/30 cursor-not-allowed'
                  : 'border-border-color text-text-secondary hover:border-accent hover:text-accent'}`}
              title={blocked ? '이미 다른 역할로 지정됨' : ''}>
              {userNames[nn] || nn}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function Editor({
  value, userNames, saving, onSave, onCancel,
}: {
  value: Business; userNames: Record<string, string>; saving: boolean;
  onSave: (b: Business) => void; onCancel: () => void;
}) {
  const [b, setB] = useState<Business>(value);
  const set = (k: keyof Business, v: unknown) => setB(prev => ({ ...prev, [k]: v }));
  const field = 'w-full px-2 py-1.5 bg-white border border-border-color rounded text-sm text-text-primary focus:outline-none focus:ring-1 focus:ring-accent';

  return (
    <div className="rounded-xl border border-accent/30 bg-accent/[0.02] p-4 space-y-3">
      <div className="grid grid-cols-2 gap-3">
        <div>
          <div className="text-xs text-text-secondary mb-1">사업명 <span className="text-red-500">*</span></div>
          <input className={field} value={b.name} onChange={e => set('name', e.target.value)}
            placeholder="경기도 균형발전지원센터 정보서비스 고도화" />
        </div>
        <div>
          <div className="text-xs text-text-secondary mb-1">발주처 <span className="text-red-500">*</span></div>
          <input className={field} value={b.org} onChange={e => set('org', e.target.value)} placeholder="경기연구원" />
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div>
          <div className="text-xs text-text-secondary mb-1">
            별칭 <span className="text-red-500">*</span>
            <span className="ml-1 text-text-secondary/60">보고서에 [이 이름] 으로 붙습니다</span>
          </div>
          <input className={field} value={b.alias} onChange={e => set('alias', e.target.value)} placeholder="경기연구원" />
        </div>
        <div>
          <div className="text-xs text-text-secondary mb-1">
            옛 이름 <span className="ml-1 text-text-secondary/60">쉼표로 구분 · 선택</span>
          </div>
          <input className={field} value={(b.aliases || []).join(', ')}
            onChange={e => set('aliases', e.target.value.split(',').map(s => s.trim()).filter(Boolean))}
            placeholder="메타버스아카데미, 가상융합기술아카데미" />
        </div>
      </div>

      <PeoplePicker label="담당" hint="한 명 이상 · 필수" selected={b.owners}
        exclude={b.supporters} userNames={userNames} onChange={v => set('owners', v)} />
      <PeoplePicker label="지원" hint="선택" selected={b.supporters}
        exclude={b.owners} userNames={userNames} onChange={v => set('supporters', v)} />

      <div className="grid grid-cols-2 gap-3">
        <div>
          <div className="text-xs text-text-secondary mb-1">
            두레이 프로젝트 ID <span className="ml-1 text-text-secondary/60">숫자 · 자동 매칭 실패 시만</span>
          </div>
          <input className={field} value={b.dooray_project_id || ''}
            onChange={e => set('dooray_project_id', e.target.value)} placeholder="4380691616492854470" />
        </div>
        <div>
          <div className="text-xs text-text-secondary mb-1">
            피그마 파일 키 <span className="ml-1 text-text-secondary/60">쉼표로 구분 · 선택</span>
          </div>
          <input className={field} value={(b.figma_file_keys || []).join(', ')}
            onChange={e => set('figma_file_keys', e.target.value.split(',').map(s => s.trim()).filter(Boolean))}
            placeholder="rIT5ZW62qJALV26sHvhYRk" />
        </div>
      </div>

      <div className="flex justify-end gap-2 pt-1">
        <button onClick={onCancel} className="px-3 py-1.5 text-xs border border-border-color rounded-lg text-text-secondary">
          취소
        </button>
        <button onClick={() => onSave(b)} disabled={saving}
          className="px-4 py-1.5 text-xs bg-accent hover:bg-accent-hover text-white font-semibold rounded-lg flex items-center gap-1 disabled:opacity-50">
          {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />} 저장
        </button>
      </div>
    </div>
  );
}

export function BusinessMaster({ userNames }: Props) {
  const [list, setList] = useState<Business[]>([]);
  const [allAccess, setAllAccess] = useState<string[]>([]);
  const [editing, setEditing] = useState<string | null>(null);   // id 또는 'new-biz' / 'new-svc'
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [msg, setMsg] = useState('');
  const [showClosed, setShowClosed] = useState(false);

  const load = useCallback(async () => {
    try {
      const r = await fetch('/api/admin/businesses', { credentials: 'include' });
      const d = await r.json();
      if (d.ok) { setList(d.businesses || []); setAllAccess(d.all_access || []); }
      else setError(d.error || '불러오지 못했습니다');
    } catch (e) { setError(String(e)); }
  }, []);
  useEffect(() => { load(); }, [load]);

  const flash = (m: string) => { setMsg(m); setTimeout(() => setMsg(''), 3000); };

  const save = async (b: Business) => {
    setSaving(true); setError('');
    const isNew = !b.id;
    try {
      const r = await fetch('/api/admin/businesses', {
        method: isNew ? 'POST' : 'PUT', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(b),
      });
      const d = await r.json();
      if (!d.ok) { setError(d.error || '저장 실패'); return; }
      setList(d.businesses || []); setEditing(null);
      flash(isNew ? '사업을 추가했습니다' : '저장했습니다');
    } catch (e) { setError(String(e)); }
    finally { setSaving(false); }
  };

  const close = async (b: Business, reopen: boolean) => {
    if (!reopen && !confirm(`'${b.name}' 을 종료 처리할까요?\n지난 보고서는 그대로 남고, 앞으로 수집에서만 빠집니다.`)) return;
    setError('');
    try {
      const r = await fetch(`/api/admin/businesses?id=${encodeURIComponent(b.id)}${reopen ? '&reopen=1' : ''}`,
        { method: 'DELETE', credentials: 'include' });
      const d = await r.json();
      if (!d.ok) { setError(d.error || '실패'); return; }
      setList(d.businesses || []);
      flash(reopen ? '다시 진행 중으로 바꿨습니다' : '종료 처리했습니다');
    } catch (e) { setError(String(e)); }
  };

  const saveAllAccess = async (v: string[]) => {
    setAllAccess(v);
    try {
      await fetch('/api/admin/businesses', {
        method: 'PUT', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ all_access: v }),
      });
      flash('전 사업 분류 대상을 저장했습니다');
    } catch (e) { setError(String(e)); }
  };

  const names = (nns: string[]) => nns.map(n => userNames[n] || n).join(' ') || '—';
  const active = list.filter(b => !b.closed);
  const closed = list.filter(b => b.closed);

  const Card = (b: Business) => (
    <div key={b.id} className="border-b border-border-color/60 last:border-0">
      {editing === b.id ? (
        <div className="p-3">
          <Editor value={b} userNames={userNames} saving={saving} onSave={save} onCancel={() => setEditing(null)} />
        </div>
      ) : (
        <div className="flex items-start gap-3 px-4 py-3 hover:bg-accent/[0.02]">
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2">
              <span className="text-sm font-semibold text-text-primary">{b.name}</span>
              {b.kind === 'service' && <span className="text-[10px] px-1.5 py-0.5 rounded bg-accent/10 text-accent">자사</span>}
              {b.closed && <span className="text-[10px] px-1.5 py-0.5 rounded bg-gray-500/10 text-text-secondary">종료</span>}
            </div>
            <div className="text-xs text-text-secondary mt-0.5">
              별칭 <b className="text-accent/80">{b.alias}</b>
              {(b.aliases || []).length > 0 && <span className="text-text-secondary/70"> · {(b.aliases || []).join(' · ')}</span>}
              {b.org && <span> · 발주처 {b.org}</span>}
            </div>
            <div className="text-xs text-text-secondary mt-1">
              담당 <b className="text-text-primary">{names(b.owners || [])}</b>
              <span className="ml-3">지원 {names(b.supporters || [])}</span>
            </div>
          </div>
          <div className="flex items-center gap-1 flex-shrink-0">
            <button onClick={() => setEditing(b.id)}
              className="px-2 py-1 text-xs border border-border-color rounded text-text-secondary hover:border-accent hover:text-accent">
              편집
            </button>
            <button onClick={() => close(b, !!b.closed)} title={b.closed ? '다시 진행 중으로' : '종료 처리'}
              className="p-1.5 text-text-secondary hover:text-red-500">
              {b.closed ? <RotateCcw className="w-3.5 h-3.5" /> : <Archive className="w-3.5 h-3.5" />}
            </button>
          </div>
        </div>
      )}
    </div>
  );

  return (
    <div className="space-y-4">
      {msg && <div className="p-3 bg-green-500/10 border border-green-500/30 rounded-lg text-green-500 text-sm">{msg}</div>}
      {error && <div className="p-3 bg-red-500/10 border border-red-500/30 rounded-lg text-red-500 text-sm">{error}</div>}

      <div className="bg-card border border-border-color rounded-xl">
        <div className="flex items-center justify-between px-4 py-3 border-b border-border-color">
          <span className="text-sm font-semibold text-text-primary flex items-center gap-2">
            <Briefcase className="w-4 h-4 text-accent" /> 사업 마스터 ({active.length})
          </span>
          <div className="flex gap-1.5">
            <button onClick={() => setEditing('new-svc')}
              className="px-3 py-1.5 text-xs border border-border-color rounded-lg text-text-secondary hover:border-accent hover:text-accent flex items-center gap-1">
              <Plus className="w-3 h-3" /> 자사 서비스
            </button>
            <button onClick={() => setEditing('new-biz')}
              className="px-3 py-1.5 text-xs bg-accent hover:bg-accent-hover text-white font-semibold rounded-lg flex items-center gap-1">
              <Plus className="w-3 h-3" /> 사업 추가
            </button>
          </div>
        </div>

        {(editing === 'new-biz' || editing === 'new-svc') && (
          <div className="p-3 border-b border-border-color">
            <Editor value={empty(editing === 'new-svc' ? 'service' : '')} userNames={userNames}
              saving={saving} onSave={save} onCancel={() => setEditing(null)} />
          </div>
        )}

        {active.map(Card)}
        {active.length === 0 && <div className="px-4 py-6 text-sm text-text-secondary text-center">등록된 사업이 없습니다</div>}
      </div>

      {closed.length > 0 && (
        <div className="bg-card border border-border-color rounded-xl">
          <button onClick={() => setShowClosed(v => !v)}
            className="w-full flex items-center gap-2 px-4 py-3 text-sm text-text-secondary hover:text-text-primary">
            {showClosed ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
            종료된 사업 {closed.length}개
            <span className="text-xs text-text-secondary/60">— 지난 보고서를 위해 남겨둡니다</span>
          </button>
          {showClosed && closed.map(Card)}
        </div>
      )}

      <div className="bg-card border border-border-color rounded-xl p-4">
        <div className="text-sm font-semibold text-text-primary mb-1">전 사업 분류 대상</div>
        <div className="text-xs text-text-secondary mb-2">
          디자이너·팀장급처럼 여러 사업을 오가는 사람. 담당으로 지정되지 않은 사업의 활동도 분류됩니다.
        </div>
        <PeoplePicker label="" selected={allAccess} exclude={[]} userNames={userNames} onChange={saveAllAccess} />
      </div>

      <div className="text-[11px] text-text-secondary/70 leading-relaxed px-1">
        <b>별칭</b>이 가장 중요합니다 — 수집한 항목을 사업에 붙이는 기준입니다.
        사업명이 바뀌었다면 옛 이름을 <b>옛 이름</b>에 남겨두세요. 지난 자료가 계속 매칭됩니다.
        <br />
        <b>종료</b>는 삭제가 아닙니다. 지난 보고서의 사업 표시가 깨지지 않도록 데이터는 남기고 수집에서만 제외합니다.
      </div>
    </div>
  );
}
