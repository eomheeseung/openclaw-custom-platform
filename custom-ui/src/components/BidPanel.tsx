import { useState, useEffect, useCallback } from 'react';
import { FileText, X, CheckCircle, AlertCircle, Loader2, RefreshCw, Monitor, ListChecks, FileSearch, Mail, Send, ChevronDown, ChevronRight, Sliders } from 'lucide-react';

interface BidPanelProps {
  token: string;
  onClose: () => void;
  onSendMessage?: (text: string) => void;
  onOpenVNC?: () => void;
}

function parseUserSlot(token: string): number | null {
  const m = token.match(/user(\d+)/i);
  if (!m) return null;
  const n = parseInt(m[1], 10);
  if (!n || n < 1 || n > 15) return null;
  return n;
}

function slotToStr(slot: number): string {
  return String(slot).padStart(2, '0');
}

type LoginStatus =
  | { kind: 'checking' }
  | { kind: 'logged-in'; count: number }
  | { kind: 'not-logged-in'; reason: string }
  | { kind: 'error'; message: string };

async function checkBidLogin(userNN: string): Promise<LoginStatus> {
  try {
    const res = await fetch('/api/bid/list', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userNN, status: 'assigned' }),
    });
    const data = await res.json().catch(() => ({}));
    if (data && data.ok === true) {
      const count = Array.isArray(data.bids) ? data.bids.length : 0;
      return { kind: 'logged-in', count };
    }
    const err = (data && data.error) || 'Unknown';
    if (typeof err === 'string' && err.includes('쿠키 없음')) {
      return { kind: 'not-logged-in', reason: '쿠키 없음' };
    }
    if (typeof err === 'string' && err.includes('no page target')) {
      return { kind: 'not-logged-in', reason: 'Chrome 탭 없음' };
    }
    return { kind: 'error', message: err };
  } catch (e) {
    return { kind: 'error', message: e instanceof Error ? e.message : String(e) };
  }
}

export function BidPanel({ token, onClose, onOpenVNC, onSendMessage }: BidPanelProps) {
  const slot = parseUserSlot(token);
  const [detail, setDetail] = useState<'normal' | 'detailed' | 'deep'>('normal');
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [status, setStatus] = useState<LoginStatus>({ kind: 'checking' });
  const [bidQuery, setBidQuery] = useState('');
  const [mailTo, setMailTo] = useState('je_aime_she@tideflo.com');
  const [mailSubject, setMailSubject] = useState('');
  const loggedIn = status.kind === 'logged-in';

  const todayStr = new Date().toLocaleDateString('ko-KR', { year: 'numeric', month: '2-digit', day: '2-digit' }).replace(/\. /g, '-').replace('.', '');

  const detailSpec = {
    normal: { lines: '30~40줄', bullets: '불릿 7~10개', extraInstruction: '' },
    detailed: { lines: '60~80줄', bullets: '불릿 12~15개', extraInstruction: '\n- 각 요구사항별로 우리 보유 기술 매핑\n- 예산·일정 합리성 평가' },
    deep: {
      lines: '100줄+',
      bullets: '불릿 15개+ (각 항목 1~2문장 설명)',
      extraInstruction: `\n- **각 bid마다 sessions_spawn으로 개발봇 또는 기획봇 호출**해서 분야별 심층 분석 위임
- 기술 요구사항 → developer 위임
- 평가 기준·전략 → planner 위임
- 결과 종합해서 비서가 최종 리포트`,
    },
  }[detail];

  const sendSummarize = () => {
    if (!onSendMessage) return;
    const prompt = `bid_summarize_assigned 도구 호출해서 오늘 배정된 입찰공고 전부 가져온 뒤, 각 사업마다 ${detailSpec.lines} 분량으로 아래 구조로 정리. 사업 간은 --- 로 구분:

[사업명 / 발주기관 / 예산 / 마감일]
- 사업 개요 (1~2단락)
- 핵심 기술 요구사항 (${detailSpec.bullets})
- 평가 기준·배점표
- 제출 서류 체크리스트
- 우리 회사 적합도 분석
- 리스크·질의사항${detailSpec.extraInstruction}

마지막에 4개 비교표(사업명/예산/마감일/추천도)와 입찰 추천도 순위 포함.
**절대 browser·web_search 사용 금지. bid_* 도구만 사용.**`;
    onSendMessage(prompt);
  };

  const sendDetailOne = () => {
    if (!onSendMessage || !bidQuery.trim()) return;
    const prompt = `bid_summarize_assigned 도구 호출한 뒤, 결과에서 "${bidQuery.trim()}"에 해당하는 사업만 골라서 제안요청서·공고서 세부 내용까지 포함해 ${detailSpec.lines} 분량의 상세 리포트 작성. 기술 요구사항·평가기준·제출서류·일정·리스크 전부 포함.${detailSpec.extraInstruction} bid_* 도구만 사용.`;
    onSendMessage(prompt);
  };

  const sendMail = () => {
    if (!onSendMessage || !mailTo.trim()) return;
    const subject = mailSubject.trim() || `[입찰 일일 브리핑] ${todayStr}`;
    const prompt = `bid_summarize_assigned 호출해서 오늘 배정된 입찰 요약한 뒤, mail_send 도구로 메일 발송.

수신자: ${mailTo.trim()}
제목: ${subject}
본문: 각 사업 요약 + 비교표 (마크다운)

mail_send가 실패하면 exec 도구로 다음 명령 실행:
gcurl POST /api/mail/send '{"to":"${mailTo.trim()}","subject":"${subject}","body":"<요약내용>"}'`;
    onSendMessage(prompt);
  };

  const refresh = useCallback(() => {
    if (slot === null) return;
    setStatus({ kind: 'checking' });
    checkBidLogin(slotToStr(slot)).then(setStatus);
  }, [slot]);

  useEffect(() => { refresh(); }, [refresh]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={onClose}>
      <div className="bg-card border border-border-color rounded-2xl w-[560px] max-w-[92vw] p-6 shadow-xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-2">
            <FileText className="w-5 h-5 text-accent" />
            <h3 className="text-base font-bold text-text-primary">제안서 / 입찰</h3>
          </div>
          <button onClick={onClose} className="text-text-secondary hover:text-text-primary">
            <X className="w-5 h-5" />
          </button>
        </div>

        {slot === null ? (
          <div className="text-sm text-red-400">사용자 슬롯을 확인할 수 없습니다.</div>
        ) : (
          <div className="space-y-4">
            {/* 로그인 상태 */}
            <div className="bg-background rounded-lg p-3">
              <div className="flex items-center justify-between">
                <span className="text-xs text-text-secondary">bid.tideflo.work 로그인 상태</span>
                <button
                  onClick={refresh}
                  className="p-1 text-text-secondary hover:text-accent"
                  title="상태 재확인"
                  disabled={status.kind === 'checking'}
                >
                  <RefreshCw className={`w-3.5 h-3.5 ${status.kind === 'checking' ? 'animate-spin' : ''}`} />
                </button>
              </div>
              <div className="mt-2">
                {status.kind === 'checking' && (
                  <div className="flex items-center gap-2 text-sm text-text-secondary">
                    <Loader2 className="w-4 h-4 animate-spin" />
                    <span>확인 중...</span>
                  </div>
                )}
                {status.kind === 'logged-in' && (
                  <div className="flex items-center gap-2 text-sm">
                    <CheckCircle className="w-4 h-4 text-green-400" />
                    <span className="text-green-400 font-medium">로그인 완료</span>
                    <span className="text-text-secondary">— 오늘 배정 {status.count}건</span>
                  </div>
                )}
                {status.kind === 'not-logged-in' && (
                  <div>
                    <div className="flex items-center gap-2 text-sm">
                      <AlertCircle className="w-4 h-4 text-amber-500" />
                      <span className="text-amber-500 font-medium">로그인 필요</span>
                      <span className="text-text-secondary text-xs">({status.reason})</span>
                    </div>
                    <div className="mt-2 text-xs text-text-secondary">
                      VNC로 Chrome 열어서 <code className="text-accent">bid.tideflo.work</code> 로그인 후 🔄 재확인.
                    </div>
                    {onOpenVNC && (
                      <button
                        onClick={onOpenVNC}
                        className="mt-2 flex items-center gap-2 px-3 py-1.5 bg-accent hover:bg-accent-hover text-white rounded-lg text-xs"
                      >
                        <Monitor className="w-3.5 h-3.5" /> VNC 열기
                      </button>
                    )}
                  </div>
                )}
                {status.kind === 'error' && (
                  <div className="text-sm text-red-400">
                    ⚠ {status.message}
                  </div>
                )}
              </div>
            </div>

            {/* 퀵액션 3개 */}
            <div className="space-y-2">
              <div className="text-xs text-text-secondary px-1">빠른 실행</div>

              {/* A. 오늘 배정 요약 */}
              <button
                onClick={sendSummarize}
                disabled={!loggedIn || !onSendMessage}
                className="w-full flex items-center gap-3 px-4 py-3 bg-accent/10 hover:bg-accent/20 border border-accent/30 rounded-lg text-left disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
              >
                <ListChecks className="w-5 h-5 text-accent flex-shrink-0" />
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-medium text-text-primary">📋 오늘 배정 요약</div>
                  <div className="text-xs text-text-secondary mt-0.5">배정된 모든 입찰 한 번에 상세 정리 + 비교표</div>
                </div>
                <Send className="w-4 h-4 text-text-secondary" />
              </button>

              {/* B. 특정 사업 상세 */}
              <div className="bg-background border border-border-color rounded-lg p-3 space-y-2">
                <div className="flex items-center gap-2">
                  <FileSearch className="w-4 h-4 text-accent" />
                  <span className="text-sm font-medium text-text-primary">📄 특정 사업 상세</span>
                </div>
                <input
                  value={bidQuery}
                  onChange={(e) => setBidQuery(e.target.value)}
                  placeholder="사업명 키워드 또는 공고번호 (예: 공유마당)"
                  className="w-full px-3 py-2 bg-card border border-border-color rounded-md text-sm text-text-primary focus:outline-none focus:border-accent"
                />
                <button
                  onClick={sendDetailOne}
                  disabled={!loggedIn || !bidQuery.trim() || !onSendMessage}
                  className="w-full flex items-center justify-center gap-2 px-3 py-2 bg-accent/10 hover:bg-accent/20 border border-accent/30 rounded-md text-sm text-accent disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                >
                  <Send className="w-3.5 h-3.5" /> 상세 리포트 생성
                </button>
              </div>

              {/* C. 요약 메일 발송 */}
              <div className="bg-background border border-border-color rounded-lg p-3 space-y-2">
                <div className="flex items-center gap-2">
                  <Mail className="w-4 h-4 text-accent" />
                  <span className="text-sm font-medium text-text-primary">📧 요약 메일 발송</span>
                </div>
                <input
                  value={mailTo}
                  onChange={(e) => setMailTo(e.target.value)}
                  placeholder="수신자 이메일"
                  className="w-full px-3 py-2 bg-card border border-border-color rounded-md text-sm text-text-primary focus:outline-none focus:border-accent"
                />
                <input
                  value={mailSubject}
                  onChange={(e) => setMailSubject(e.target.value)}
                  placeholder={`제목 (기본: [입찰 일일 브리핑] ${todayStr})`}
                  className="w-full px-3 py-2 bg-card border border-border-color rounded-md text-sm text-text-primary focus:outline-none focus:border-accent"
                />
                <button
                  onClick={sendMail}
                  disabled={!loggedIn || !mailTo.trim() || !onSendMessage}
                  className="w-full flex items-center justify-center gap-2 px-3 py-2 bg-accent/10 hover:bg-accent/20 border border-accent/30 rounded-md text-sm text-accent disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                >
                  <Send className="w-3.5 h-3.5" /> 요약 후 메일 발송
                </button>
              </div>
            </div>

            {/* 고급 옵션 */}
            <div className="bg-background rounded-lg">
              <button
                onClick={() => setAdvancedOpen(o => !o)}
                className="w-full flex items-center justify-between px-3 py-2 text-xs text-text-secondary hover:text-text-primary"
              >
                <span className="flex items-center gap-2">
                  {advancedOpen ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
                  <Sliders className="w-3.5 h-3.5" /> 고급 옵션
                </span>
                <span className="text-accent">
                  {detail === 'normal' && '🟢 정상'}
                  {detail === 'detailed' && '🟡 상세'}
                  {detail === 'deep' && '🔴 초상세'}
                </span>
              </button>
              {advancedOpen && (
                <div className="px-3 pb-3 pt-1 space-y-2">
                  <div className="text-xs text-text-secondary mb-1">디테일 수준</div>
                  {[
                    { value: 'normal', label: '🟢 정상', desc: '30~40줄/bid · 빠른 일일 브리핑' },
                    { value: 'detailed', label: '🟡 상세', desc: '60~80줄/bid · 제안서 준비용' },
                    { value: 'deep', label: '🔴 초상세', desc: '100줄+/bid · 서브에이전트 병렬 분석' },
                  ].map(opt => (
                    <label key={opt.value} className="flex items-start gap-2 cursor-pointer p-2 rounded hover:bg-card">
                      <input
                        type="radio"
                        name="detail"
                        value={opt.value}
                        checked={detail === opt.value}
                        onChange={() => setDetail(opt.value as 'normal' | 'detailed' | 'deep')}
                        className="mt-0.5 accent-accent"
                      />
                      <div className="flex-1">
                        <div className="text-sm text-text-primary">{opt.label}</div>
                        <div className="text-xs text-text-secondary">{opt.desc}</div>
                      </div>
                    </label>
                  ))}
                  {detail === 'deep' && (
                    <div className="text-xs text-amber-500 bg-amber-500/10 border border-amber-500/30 px-2 py-1.5 rounded">
                      ⚠ 초상세는 토큰·시간 4~5배. 중요한 사업 단건 분석 시에만 권장.
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
