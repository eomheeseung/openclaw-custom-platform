import { useEffect } from 'react';
import { Monitor, X, AlertCircle } from 'lucide-react';

interface Props {
  onClose: () => void;
  onOpenVNC: () => void;
}

export function BidHelpModal({ onClose, onOpenVNC }: Props) {
  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onClose]);

  return (
    <>
      {/* 화살표 — 좌측 사이드바의 VNC 아이콘 가리키기 */}
      {/* dock 위치: 좌측 64px wide, VNC 아이콘은 하단 spacer 다음 */}
      <div
        className="fixed z-[60] pointer-events-none"
        style={{ left: 76, bottom: 110 }}
      >
        <div className="relative animate-bounce-x">
          <svg width="120" height="80" viewBox="0 0 120 80" fill="none" xmlns="http://www.w3.org/2000/svg">
            <defs>
              <marker id="arrowhead" markerWidth="12" markerHeight="12" refX="10" refY="6" orient="auto">
                <polygon points="0 0, 12 6, 0 12" fill="#f59e0b" />
              </marker>
            </defs>
            <path d="M 100 40 Q 60 40 20 40" stroke="#f59e0b" strokeWidth="3" fill="none" strokeLinecap="round" markerEnd="url(#arrowhead)" strokeDasharray="6 4" />
          </svg>
          <div className="absolute top-0 left-[40px] -translate-y-full mt-[-8px] bg-amber-500 text-white text-xs font-bold px-3 py-1.5 rounded-lg shadow-lg whitespace-nowrap">
            여기 🖥️ 클릭!
          </div>
        </div>
      </div>

      <style>{`
        @keyframes bounce-x {
          0%, 100% { transform: translateX(0); }
          50% { transform: translateX(-8px); }
        }
        .animate-bounce-x { animation: bounce-x 1s ease-in-out infinite; }
      `}</style>

      {/* 모달 */}
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={onClose}>
        <div className="bg-card border border-border-color rounded-2xl w-[520px] max-w-[92vw] p-6 shadow-xl" onClick={(e) => e.stopPropagation()}>
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center gap-2">
              <AlertCircle className="w-5 h-5 text-amber-500" />
              <h3 className="text-base font-bold text-text-primary">bid.tideflo.work 로그인 가이드</h3>
            </div>
            <button onClick={onClose} className="text-text-secondary hover:text-text-primary">
              <X className="w-5 h-5" />
            </button>
          </div>

          <div className="space-y-4">
            <p className="text-sm text-text-secondary">
              한 번만 로그인해두면 세션 만료 전까지 자동으로 동작해요.
            </p>

            <ol className="space-y-3">
              <li className="flex gap-3">
                <span className="w-7 h-7 rounded-full bg-amber-500 text-white text-sm font-bold flex items-center justify-center flex-shrink-0">1</span>
                <div className="pt-0.5">
                  <div className="text-sm text-text-primary font-medium">아래 <span className="text-accent">[VNC 열기]</span> 버튼 클릭</div>
                  <div className="text-xs text-text-secondary mt-0.5">또는 화면 좌측 🖥️ 아이콘 — 화살표가 가리키는 곳</div>
                </div>
              </li>
              <li className="flex gap-3">
                <span className="w-7 h-7 rounded-full bg-amber-500 text-white text-sm font-bold flex items-center justify-center flex-shrink-0">2</span>
                <div className="pt-0.5">
                  <div className="text-sm text-text-primary font-medium">새 탭에 원격 데스크톱 열림 → Chrome 주소창에 입력</div>
                  <code className="inline-block mt-1 bg-background px-2 py-1 rounded text-accent text-xs">bid.tideflo.work</code>
                </div>
              </li>
              <li className="flex gap-3">
                <span className="w-7 h-7 rounded-full bg-amber-500 text-white text-sm font-bold flex items-center justify-center flex-shrink-0">3</span>
                <div className="pt-0.5">
                  <div className="text-sm text-text-primary font-medium">본인 계정으로 로그인</div>
                  <div className="text-xs text-text-secondary mt-0.5">로그인 후 화면이 메인으로 넘어가면 OK</div>
                </div>
              </li>
              <li className="flex gap-3">
                <span className="w-7 h-7 rounded-full bg-amber-500 text-white text-sm font-bold flex items-center justify-center flex-shrink-0">4</span>
                <div className="pt-0.5">
                  <div className="text-sm text-text-primary font-medium">이 화면으로 돌아와서 🔄 재확인</div>
                  <div className="text-xs text-text-secondary mt-0.5">상태가 ✅ 로그인 완료로 바뀝니다</div>
                </div>
              </li>
            </ol>

            <button
              onClick={() => { onClose(); onOpenVNC(); }}
              className="w-full flex items-center justify-center gap-2 px-4 py-2.5 bg-accent hover:bg-accent-hover text-white rounded-lg text-sm font-medium"
            >
              <Monitor className="w-4 h-4" /> 지금 VNC 열기
            </button>

            <p className="text-xs text-text-secondary text-center">
              💡 세션은 보통 수일~수주 유지돼요
            </p>
          </div>
        </div>
      </div>
    </>
  );
}
