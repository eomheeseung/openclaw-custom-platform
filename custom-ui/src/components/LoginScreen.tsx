import { useState, useEffect } from 'react';
import { Lock, Eye, EyeOff, ArrowRight } from 'lucide-react';

interface LoginScreenProps {
  onLogin: (token: string) => void;
}

function getCookie(name: string): string {
  const match = document.cookie.match(new RegExp(`(^| )${name}=([^;]+)`));
  return match ? decodeURIComponent(match[2]) : '';
}

export function LoginScreen({ onLogin }: LoginScreenProps) {
  const [token, setToken] = useState('');
  const [showToken, setShowToken] = useState(false);
  const [error, setError] = useState('');
  const isTideFloDomain = window.location.hostname === 'claw.tideflo.work';

  // Check for OAuth cookie on mount
  useEffect(() => {
    const gatewayToken = getCookie('gateway_token');
    if (gatewayToken) {
      onLogin(gatewayToken);
    }
  }, [onLogin]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!token.trim()) {
      setError('토큰을 입력해주세요');
      return;
    }
    setError('');
    onLogin(token.trim());
  };

  const handleGoogleLogin = () => {
    window.location.href = '/oauth/google';
  };

  return (
    <div className="min-h-screen bg-background flex items-center justify-center p-4">
      <div className="w-full max-w-md">
        {/* Logo */}
        <div className="text-center mb-8">
          <div className="w-20 h-20 bg-accent rounded-2xl flex items-center justify-center mx-auto mb-4 shadow-lg shadow-accent/20">
            <span className="text-4xl">🐾</span>
          </div>
          <h1 className="text-3xl font-bold text-text-primary mb-2">TideClaw</h1>
          <p className="text-text-secondary">AI 팀 워크스페이스</p>
        </div>

        {/* Login Card */}
        <div className="bg-card border border-border-color rounded-2xl p-6 shadow-xl">
          {isTideFloDomain ? (
            <>
              {/* Google OAuth Login */}
              <div className="flex items-center gap-3 mb-6">
                <Lock className="w-5 h-5 text-accent" />
                <h2 className="text-lg font-semibold text-text-primary">로그인</h2>
              </div>

              <button
                onClick={handleGoogleLogin}
                className="w-full flex items-center justify-center gap-3 py-3 bg-white hover:bg-gray-50 text-gray-800 rounded-xl font-medium transition-colors border border-gray-300"
              >
                <svg className="w-5 h-5" viewBox="0 0 24 24">
                  <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 01-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z"/>
                  <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/>
                  <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"/>
                  <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/>
                </svg>
                Google 계정으로 로그인
              </button>

              <div className="mt-4 pt-4 border-t border-border-color">
                <p className="text-xs text-text-secondary text-center">
                  @tideflo.com 이메일만 접속 가능합니다
                </p>
              </div>
            </>
          ) : (
            <>
              {/* Token Login (direct access) */}
              <div className="flex items-center gap-3 mb-6">
                <Lock className="w-5 h-5 text-accent" />
                <h2 className="text-lg font-semibold text-text-primary">인증</h2>
              </div>

              <form onSubmit={handleSubmit}>
                <div className="mb-4">
                  <label className="block text-sm text-text-secondary mb-2">
                    Gateway Token
                  </label>
                  <div className="relative">
                    <input
                      type={showToken ? 'text' : 'password'}
                      value={token}
                      onChange={(e) => setToken(e.target.value)}
                      placeholder="토큰을 입력하세요"
                      className="w-full px-4 py-3 bg-background border border-border-color rounded-xl text-text-primary placeholder-text-secondary focus:outline-none focus:border-accent transition-colors pr-12"
                    />
                    <button
                      type="button"
                      onClick={() => setShowToken(!showToken)}
                      className="absolute right-3 top-1/2 -translate-y-1/2 p-1 text-text-secondary hover:text-text-primary transition-colors"
                    >
                      {showToken ? <EyeOff className="w-5 h-5" /> : <Eye className="w-5 h-5" />}
                    </button>
                  </div>
                  {error && <p className="text-accent text-sm mt-2">{error}</p>}
                </div>

                <button
                  type="submit"
                  className="w-full flex items-center justify-center gap-2 py-3 bg-accent hover:bg-accent-hover text-white rounded-xl font-medium transition-colors"
                >
                  접속하기
                  <ArrowRight className="w-5 h-5" />
                </button>
              </form>

              <div className="mt-6 pt-6 border-t border-border-color">
                <p className="text-xs text-text-secondary text-center">
                  TideClaw Gateway에 연결하려면 유효한 토큰이 필요합니다.
                </p>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
