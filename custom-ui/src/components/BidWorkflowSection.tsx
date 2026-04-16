import { useState, useEffect, useCallback } from 'react';
import { FileText, CheckCircle, AlertCircle, Loader2, RefreshCw, ListChecks, FileSearch, Mail, Send, ChevronDown, ChevronRight, Sliders, HelpCircle } from 'lucide-react';
import { BidHelpModal } from './BidHelpModal';

interface Props {
  token: string;
  onSendMessage: (text: string) => void;
  onOpenVNC: () => void;
  onUnpin?: () => void;
}

function parseUserSlot(token: string): number | null {
  const m = token.match(/user(\d+)/i);
  if (!m) return null;
  const n = parseInt(m[1], 10);
  if (!n || n < 1 || n > 15) return null;
  return n;
}

const slotToStr = (slot: number) => String(slot).padStart(2, '0');

type LoginStatus =
  | { kind: 'checking' }
  | { kind: 'logged-in'; count: number }
  | { kind: 'not-logged-in'; reason: string }
  | { kind: 'chrome-down'; detail: string }
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
    if (typeof err === 'string' && (err.includes('ECONNREFUSED') && err.includes('18800'))) return { kind: 'chrome-down', detail: err };
    if (typeof err === 'string' && err.includes('쿠키 없음')) return { kind: 'not-logged-in', reason: '쿠키 없음' };
    if (typeof err === 'string' && err.includes('no page target')) return { kind: 'not-logged-in', reason: 'Chrome 탭 없음' };
    return { kind: 'error', message: err };
  } catch (e) {
    return { kind: 'error', message: e instanceof Error ? e.message : String(e) };
  }
}

export function BidWorkflowSection({ token, onSendMessage, onOpenVNC, onUnpin }: Props) {
  const slot = parseUserSlot(token);
  const [detail, setDetail] = useState<'normal' | 'detailed' | 'deep'>('normal');
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [status, setStatus] = useState<LoginStatus>({ kind: 'checking' });
  const [bidQuery, setBidQuery] = useState('');
  const [mailTo, setMailTo] = useState('je_aime_she@tideflo.com');
  const [mailSubject, setMailSubject] = useState('');
  type QueueBid = { bidRowId: string; bidNo?: string; title?: string; preview?: string; summary?: string; error?: string; elapsedMs?: number };
  const [queueRunning, setQueueRunning] = useState(false);
  const [queueResults, setQueueResults] = useState<QueueBid[] | null>(null);
  const [queueMeta, setQueueMeta] = useState<{ totalElapsedMs?: number; detail?: string; error?: string } | null>(null);
  const [queueExpanded, setQueueExpanded] = useState<Record<string, boolean>>({});
  const loggedIn = status.kind === 'logged-in';
  const todayStr = new Date().toLocaleDateString('ko-KR', { year: 'numeric', month: '2-digit', day: '2-digit' }).replace(/\. /g, '-').replace('.', '');

  const refresh = useCallback(() => {
    if (slot === null) return;
    setStatus({ kind: 'checking' });
    checkBidLogin(slotToStr(slot)).then(setStatus);
  }, [slot]);

  useEffect(() => { refresh(); }, [refresh]);

  const detailSpec = {
    normal: { lines: '30~40줄', bullets: '불릿 7~10개', extra: '' },
    detailed: { lines: '60~80줄', bullets: '불릿 12~15개', extra: '\n- 각 요구사항별로 우리 보유 기술 매핑\n- 예산·일정 합리성 평가' },
    deep: { lines: '100줄+', bullets: '불릿 15개+ (각 항목 1~2문장 설명)', extra: '\n- 각 bid마다 sessions_spawn으로 개발봇/기획봇 호출해서 분야별 심층 분석 위임\n- 결과 종합해서 비서가 최종 리포트' },
  }[detail];

  const sendSummarize = () => {
    onSendMessage(`**bid_queue_summarize** 도구를 {"detail":"${detail}","concurrency":3} 파라미터로 딱 1번 호출해. 이 도구가 내부 큐로 동시 3개 병렬 요약을 자동 실행함. 다른 bid_* 도구, sessions_spawn, 배치 로직 일절 금지.

결과 받으면 **각 bid의 summary 필드를 한 글자도 줄이지 말고 그대로 출력**. 축약·생략·"..." 표기 금지. 각 사업 간은 --- 로 구분.
마지막에 비교표(사업명/예산/마감일/추천도) + 추천 순위 추가.
browser·web_search 절대 금지.`);
  };
  const sendDetailOne = () => {
    if (!bidQuery.trim()) return;
    onSendMessage(`다음 순서로 "${bidQuery.trim()}" 사업의 상세 리포트를 작성해. bid_* 도구만 사용, 다른 도구 금지.\n1. bid_list(status="assigned") 호출 → 목록에서 "${bidQuery.trim()}"와 일치하는 bidRowId 찾기\n2. bid_detail(bidRowId) 호출 → 문서 목록(docId) 확인\n3. 각 docId마다 bid_document_text(docId) 호출 → 원문 취득\n4. 취득한 원문 전체를 바탕으로 ${detailSpec.lines} 분량 상세 리포트 작성 (기술 요구사항·평가기준·제출서류·일정·리스크 전부 포함).${detailSpec.extra}`);
  };

  const sendMail = () => {
    if (!mailTo.trim()) return;
    const subject = mailSubject.trim() || `[입찰 일일 브리핑] ${todayStr}`;
    onSendMessage(`bid_summarize_assigned 호출해서 오늘 배정된 입찰 요약한 뒤, mail_send 도구로 메일 발송.

수신자: ${mailTo.trim()}
제목: ${subject}
본문: 각 사업 요약 + 비교표 (마크다운)

mail_send 실패 시 exec로:
gcurl POST /api/mail/send '{"to":"${mailTo.trim()}","subject":"${subject}","body":"<요약내용>"}'`);
  };

  return (
    <div className="bg-card border border-border-color rounded-2xl p-5">
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2">
          <FileText className="w-5 h-5 text-accent" />
          <h2 className="text-base font-bold text-text-primary">제안서 / 입찰</h2>
          <button
            onClick={() => setHelpOpen(true)}
            className="ml-1 text-text-secondary hover:text-amber-500 transition-colors"
            title="로그인 도움말"
          >
            <HelpCircle className="w-4 h-4" />
          </button>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-xs text-text-secondary">user{slot !== null ? slotToStr(slot) : '?'}</span>
          {onUnpin && (
            <button
              onClick={onUnpin}
              className="p-1 text-text-secondary hover:text-red-400 transition-colors"
              title="이 워크플로 제거"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
            </button>
          )}
        </div>
      </div>

      {slot === null ? (
        <div className="text-sm text-red-400">사용자 슬롯 확인 불가</div>
      ) : (
        <div className="space-y-4">
          {/* 로그인 상태 */}
          <div className="bg-background rounded-lg p-3">
            <div className="flex items-center justify-between">
              <span className="text-xs text-text-secondary">bid.tideflo.work 로그인 상태</span>
              <button onClick={refresh} className="p-1 text-text-secondary hover:text-accent" title="재확인" disabled={status.kind === 'checking'}>
                <RefreshCw className={`w-3.5 h-3.5 ${status.kind === 'checking' ? 'animate-spin' : ''}`} />
              </button>
            </div>
            <div className="mt-2">
              {status.kind === 'checking' && (
                <div className="flex items-center gap-2 text-sm text-text-secondary">
                  <Loader2 className="w-4 h-4 animate-spin" /> 확인 중...
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
                <div className="flex items-center gap-2 text-sm">
                  <AlertCircle className="w-4 h-4 text-amber-500" />
                  <span className="text-amber-500 font-medium">로그인 필요</span>
                  <span className="text-text-secondary text-xs">({status.reason})</span>
                </div>
              )}
              {status.kind === 'chrome-down' && (
                <div className="text-sm space-y-2">
                  <div className="flex items-center gap-2">
                    <AlertCircle className="w-4 h-4 text-red-400" />
                    <span className="text-red-400 font-medium">Chrome 꺼져있음</span>
                  </div>
                  <div className="text-xs text-text-secondary leading-relaxed bg-red-500/10 border border-red-500/20 rounded p-2">
                    컨테이너 재시작 후 내부 Chrome이 아직 안 떴어요.<br />
                    <b className="text-text-primary">해결:</b>
                    <ol className="list-decimal list-inside mt-1 space-y-0.5">
                      <li>좌측 🖥️ VNC 버튼 클릭 → 원격 데스크톱 열기</li>
                      <li>Chrome 아이콘 더블클릭해서 실행</li>
                      <li>주소창에 <code className="text-accent">bid.tideflo.work</code> 입력 (쿠키는 저장돼 있어서 자동 로그인)</li>
                      <li>이 화면 돌아와서 🔄 재확인</li>
                    </ol>
                  </div>
                  <button onClick={onOpenVNC} className="w-full flex items-center justify-center gap-2 px-3 py-2 bg-accent/10 hover:bg-accent/20 border border-accent/30 rounded text-sm text-accent">
                    VNC 지금 열기
                  </button>
                </div>
              )}
              {status.kind === 'error' && (
                <div className="text-sm space-y-1">
                  <div className="text-red-400">⚠ {status.message}</div>
                  <div className="text-xs text-text-secondary">
                    일시적 문제일 수 있어요. 🔄 재확인 눌러보고, 계속되면 관리자에게 문의.
                  </div>
                </div>
              )}
            </div>
          </div>

          {/* 퀵액션 3개 */}
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            {/* A. 오늘 배정 요약 */}
            <button
              onClick={sendSummarize}
              disabled={!loggedIn}
              className="flex flex-col items-start gap-2 px-4 py-4 bg-accent/10 hover:bg-accent/20 border border-accent/30 rounded-lg text-left disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            >
              <ListChecks className="w-5 h-5 text-accent" />
              <div className="text-sm font-medium text-text-primary">📋 오늘 배정 요약</div>
              <div className="text-xs text-text-secondary">모든 입찰 한 번에 정리 + 비교표</div>
              <Send className="w-3.5 h-3.5 text-text-secondary mt-auto" />
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
                placeholder="사업명 또는 공고번호"
                className="w-full px-3 py-2 bg-card border border-border-color rounded-md text-sm text-text-primary focus:outline-none focus:border-accent"
              />
              <button
                onClick={sendDetailOne}
                disabled={!loggedIn || !bidQuery.trim()}
                className="w-full flex items-center justify-center gap-2 px-3 py-2 bg-accent/10 hover:bg-accent/20 border border-accent/30 rounded-md text-sm text-accent disabled:opacity-40 disabled:cursor-not-allowed"
              >
                <Send className="w-3.5 h-3.5" /> 상세 리포트
              </button>
            </div>

            {/* C. 메일 발송 */}
            <div className="bg-background border border-border-color rounded-lg p-3 space-y-2">
              <div className="flex items-center gap-2">
                <Mail className="w-4 h-4 text-accent" />
                <span className="text-sm font-medium text-text-primary">📧 요약 메일</span>
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
                placeholder={`제목 (기본: 일일 브리핑 ${todayStr})`}
                className="w-full px-3 py-2 bg-card border border-border-color rounded-md text-sm text-text-primary focus:outline-none focus:border-accent"
              />
              <button
                onClick={sendMail}
                disabled={!loggedIn || !mailTo.trim()}
                className="w-full flex items-center justify-center gap-2 px-3 py-2 bg-accent/10 hover:bg-accent/20 border border-accent/30 rounded-md text-sm text-accent disabled:opacity-40 disabled:cursor-not-allowed"
              >
                <Send className="w-3.5 h-3.5" /> 요약 후 발송
              </button>
            </div>
          </div>

          {/* 큐 요약 결과 카드 영역 */}
          {(queueRunning || queueResults || queueMeta?.error) && (
            <div className="bg-background rounded-lg p-3 space-y-2">
              <div className="flex items-center justify-between">
                <div className="text-sm font-medium text-text-primary">
                  {queueRunning ? '⏳ 요약 생성 중...' : queueResults ? `✅ ${queueResults.length}건 완료` : '⚠ 오류'}
                </div>
                {queueMeta?.totalElapsedMs && (
                  <div className="text-xs text-text-secondary">{(queueMeta.totalElapsedMs/1000).toFixed(1)}s · {queueMeta.detail}</div>
                )}
              </div>
              {queueMeta?.error && <div className="text-xs text-red-400 break-words">{queueMeta.error}</div>}
              {queueRunning && (
                <div className="text-xs text-text-secondary">동시 3개 병렬로 kimi 요약 중. 각 bid당 30초~2분 소요.</div>
              )}
              {queueResults && queueResults.map((b) => {
                const isOpen = queueExpanded[b.bidRowId];
                return (
                  <div key={b.bidRowId} className="border border-border-color rounded-md overflow-hidden">
                    <button
                      onClick={() => setQueueExpanded(prev => ({ ...prev, [b.bidRowId]: !prev[b.bidRowId] }))}
                      className="w-full flex items-center justify-between gap-2 px-3 py-2 bg-card hover:bg-accent/5 text-left"
                    >
                      <div className="min-w-0 flex-1">
                        <div className="text-sm font-medium text-text-primary truncate">
                          {b.preview || b.title || `bid ${b.bidRowId}`}
                        </div>
                        <div className="text-xs text-text-secondary">
                          {b.bidRowId} {b.bidNo && `· ${b.bidNo}`} {b.elapsedMs && `· ${(b.elapsedMs/1000).toFixed(1)}s`}
                          {b.error && <span className="text-red-400"> · 오류: {b.error.slice(0, 80)}</span>}
                        </div>
                      </div>
                      {isOpen ? <ChevronDown className="w-4 h-4 text-text-secondary flex-shrink-0" /> : <ChevronRight className="w-4 h-4 text-text-secondary flex-shrink-0" />}
                    </button>
                    {isOpen && (
                      <div className="px-3 py-2 bg-background border-t border-border-color">
                        {b.error ? (
                          <div className="text-xs text-red-400">{b.error}</div>
                        ) : (
                          <pre className="text-xs text-text-primary whitespace-pre-wrap break-words font-sans">{b.summary || '(empty)'}</pre>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}

          {/* 고급 옵션 */}
          <div className="bg-background rounded-lg">
            <button onClick={() => setAdvancedOpen(o => !o)} className="w-full flex items-center justify-between px-3 py-2 text-xs text-text-secondary hover:text-text-primary">
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
                    <input type="radio" name="detail" value={opt.value} checked={detail === opt.value} onChange={() => setDetail(opt.value as 'normal' | 'detailed' | 'deep')} className="mt-0.5 accent-accent" />
                    <div className="flex-1">
                      <div className="text-sm text-text-primary">{opt.label}</div>
                      <div className="text-xs text-text-secondary">{opt.desc}</div>
                    </div>
                  </label>
                ))}
                {detail === 'deep' && (
                  <div className="text-xs text-amber-500 bg-amber-500/10 border border-amber-500/30 px-2 py-1.5 rounded">
                    ⚠ 초상세는 토큰·시간 4~5배. 중요한 사업 단건 분석 시에만.
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      )}

      {helpOpen && <BidHelpModal onClose={() => setHelpOpen(false)} onOpenVNC={onOpenVNC} />}
    </div>
  );
}
