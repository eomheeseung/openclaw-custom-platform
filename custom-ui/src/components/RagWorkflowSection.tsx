import { useState, useEffect, useCallback } from 'react';
import { Database, Search, Loader2, FileText, RefreshCw, ExternalLink, ChevronDown, ChevronRight, HelpCircle } from 'lucide-react';

interface Props {
  token: string;
  onUnpin?: () => void;
}

interface Result {
  file_name: string;
  file_id: string;
  folder_path: string;
  mime_type: string;
  modified_time: string;
  snippet: string;
  score: number;
  chunk_index: number;
}

interface Status {
  ok: boolean;
  documents?: number;
  chunks?: number;
  lastSyncTime?: string;
  dbReady?: boolean;
}

export function RagWorkflowSection({ token, onUnpin }: Props) {
  const slot = token.match(/user(\d+)/i)?.[1] ?? '?';
  const [status, setStatus] = useState<Status | null>(null);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<Result[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Record<number, boolean>>({});

  const fetchStatus = useCallback(() => {
    fetch('/api/rag/status')
      .then(r => r.json())
      .then(setStatus)
      .catch(e => setStatus({ ok: false }));
  }, []);

  useEffect(() => { fetchStatus(); }, [fetchStatus]);

  const search = useCallback(async () => {
    if (!query.trim()) return;
    setLoading(true);
    setError(null);
    setResults(null);
    setExpanded({});
    try {
      const r = await fetch('/api/rag/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: query.trim(), limit: 10 }),
      });
      const data = await r.json();
      if (data.ok) {
        setResults(data.results || []);
      } else {
        setError(data.error || 'unknown error');
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [query]);

  return (
    <div className="bg-card border border-border-color rounded-2xl p-5">
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2 relative group">
          <Database className="w-5 h-5 text-accent" />
          <h2 className="text-base font-bold text-text-primary">데이터 분석 · Drive RAG</h2>
          <span className="ml-0.5 text-text-secondary hover:text-amber-500 cursor-help">
            <HelpCircle className="w-4 h-4" />
          </span>
          <div className="absolute left-0 top-full mt-2 w-96 p-4 bg-card border border-border-color rounded-lg shadow-xl text-xs invisible opacity-0 group-hover:visible group-hover:opacity-100 transition-opacity z-50 pointer-events-none">
            <div className="text-sm font-semibold text-text-primary mb-2">📚 Drive RAG 사용법</div>
            <div className="text-text-secondary mb-3">
              회사 Google Drive에 올라간 문서(PDF, Docs, 시트 등) 약 <b className="text-text-primary">2,500건</b>을 의미 기반으로 검색합니다. 키워드가 정확히 일치하지 않아도 비슷한 의미면 잡아냅니다.
            </div>
            <div className="space-y-2">
              <div>
                <div className="text-text-primary font-medium mb-1">검색 예시</div>
                <ul className="space-y-0.5 text-text-secondary list-disc list-inside">
                  <li>사업명: <code className="text-accent">방류종자관리</code>, <code className="text-accent">도시농업</code></li>
                  <li>문서 종류: <code className="text-accent">주간보고</code>, <code className="text-accent">보안서약서</code></li>
                  <li>자연어 질문: <code className="text-accent">제출 서류 체크리스트</code></li>
                  <li>키워드 조합: <code className="text-accent">입찰 평가기준</code></li>
                </ul>
              </div>
              <div className="pt-2 border-t border-border-color">
                <div className="text-text-primary font-medium mb-1">결과 활용</div>
                <ul className="space-y-0.5 text-text-secondary list-disc list-inside">
                  <li>파일 카드 클릭 → 문서 일부 미리보기 펼침</li>
                  <li><b className="text-accent">[🔗 Drive]</b> 클릭 → 새 탭에서 원본 문서 열기</li>
                  <li>관련도가 높은 순서로 정렬됨</li>
                </ul>
              </div>
            </div>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-xs text-text-secondary">user{slot}</span>
          {onUnpin && (
            <button onClick={onUnpin} className="p-1 text-text-secondary hover:text-red-400" title="이 워크플로 제거">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
            </button>
          )}
        </div>
      </div>

      {/* 상태 */}
      <div className="bg-background rounded-lg p-3 mb-3 flex items-center justify-between">
        <div className="flex items-center gap-3 text-sm">
          {status?.ok ? (
            <>
              <span className="text-green-400">●</span>
              <span className="text-text-primary">문서 <b>{status.documents?.toLocaleString()}</b></span>
              <span className="text-text-secondary">청크 {status.chunks?.toLocaleString()}</span>
              {status.lastSyncTime && (
                <span className="text-text-secondary text-xs">
                  마지막 sync: {new Date(status.lastSyncTime).toLocaleString('ko-KR', { hour12: false })}
                </span>
              )}
            </>
          ) : (
            <span className="text-amber-500">상태 확인 중...</span>
          )}
        </div>
        <button onClick={fetchStatus} className="p-1 text-text-secondary hover:text-accent" title="상태 새로고침">
          <RefreshCw className="w-3.5 h-3.5" />
        </button>
      </div>

      {/* 검색 박스 */}
      <div className="flex gap-2 mb-3">
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && !loading) search(); }}
          placeholder="문서 검색 (예: 주간보고, 사업자등록증, 입찰 평가기준)"
          className="flex-1 px-3 py-2 bg-background border border-border-color rounded-md text-sm text-text-primary focus:outline-none focus:border-accent"
        />
        <button
          onClick={search}
          disabled={loading || !query.trim()}
          className="flex items-center gap-2 px-4 py-2 bg-accent/10 hover:bg-accent/20 border border-accent/30 rounded-md text-sm text-accent disabled:opacity-40 disabled:cursor-not-allowed"
        >
          {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Search className="w-4 h-4" />}
          검색
        </button>
      </div>

      {/* 결과 */}
      {error && (
        <div className="text-sm text-red-400 bg-red-500/10 border border-red-500/20 rounded p-2">
          ⚠ {error}
        </div>
      )}

      {results && results.length === 0 && !loading && (
        <div className="text-sm text-text-secondary bg-background rounded p-3 text-center">
          검색 결과 없음
        </div>
      )}

      {results && results.length > 0 && (
        <div className="space-y-2">
          <div className="text-xs text-text-secondary px-1">검색 결과 {results.length}건 (관련도 높은 순)</div>
          {results.map((r, i) => {
            const isOpen = expanded[i];
            const isGoogleNative = r.mime_type?.startsWith('application/vnd.google-apps');
            const driveUrl = isGoogleNative
              ? `https://docs.google.com/document/d/${r.file_id}/view`
              : `https://drive.google.com/file/d/${r.file_id}/view`;
            const dateStr = r.modified_time
              ? new Date(r.modified_time).toLocaleDateString('ko-KR', { year: 'numeric', month: '2-digit', day: '2-digit' }).replace(/\.$/, '')
              : '';
            return (
              <div key={`${r.file_id}-${r.chunk_index}`} className="border border-border-color rounded-md overflow-hidden">
                <div className="flex items-center gap-2 px-3 py-2 bg-background hover:bg-accent/5">
                  <button
                    onClick={() => setExpanded(prev => ({ ...prev, [i]: !prev[i] }))}
                    className="flex items-center gap-2 min-w-0 flex-1 text-left"
                  >
                    <FileText className="w-4 h-4 text-accent flex-shrink-0" />
                    <div className="min-w-0 flex-1">
                      <div className="text-sm font-medium text-text-primary truncate">{r.file_name}</div>
                      {dateStr && <div className="text-xs text-text-secondary mt-0.5">수정 {dateStr}</div>}
                    </div>
                    {isOpen ? <ChevronDown className="w-4 h-4 text-text-secondary flex-shrink-0" /> : <ChevronRight className="w-4 h-4 text-text-secondary flex-shrink-0" />}
                  </button>
                  <a
                    href={driveUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    onClick={(e) => e.stopPropagation()}
                    className="flex items-center gap-1 text-xs text-accent hover:text-accent/80 px-2 py-1 border border-accent/30 rounded transition-colors flex-shrink-0"
                    title="Google Drive에서 원본 열기"
                  >
                    <ExternalLink className="w-3 h-3" /> Drive
                  </a>
                </div>
                {isOpen && (
                  <div className="px-3 py-2 bg-card border-t border-border-color">
                    <div className="text-xs text-text-secondary mb-1.5">미리보기 (문서 일부)</div>
                    <pre className="text-xs text-text-primary whitespace-pre-wrap break-words font-sans max-h-96 overflow-y-auto">
                      {r.snippet}
                    </pre>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
