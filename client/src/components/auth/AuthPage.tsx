import { useState, type FormEvent } from 'react';
import { authService } from '../../services/authService';

interface Props {
  onAuth: (email: string) => void;
}

export default function AuthPage({ onAuth }: Props) {
  const [mode, setMode]           = useState<'login' | 'register'>('login');
  const [email, setEmail]         = useState('');
  const [password, setPassword]   = useState('');
  const [password2, setPassword2] = useState('');
  const [loading, setLoading]     = useState(false);
  const [error, setError]         = useState<string | null>(null);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);

    if (mode === 'register' && password !== password2) {
      setError('הסיסמאות אינן תואמות');
      return;
    }

    setLoading(true);
    try {
      const result = mode === 'login'
        ? await authService.login(email, password)
        : await authService.register(email, password);
      onAuth(result.email);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'שגיאה לא ידועה');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-900 via-blue-950 to-slate-900 flex items-center justify-center px-4">
      <div className="w-full max-w-md">

        {/* Logo / branding */}
        <div className="text-center mb-8">
          <div className="text-5xl mb-3">🏦</div>
          <h1 className="text-3xl font-bold text-white">Otzar</h1>
          <p className="text-blue-300 text-sm mt-1">מרכז הפיקוד הפיננסי שלך</p>
        </div>

        {/* Card */}
        <div className="bg-white/5 backdrop-blur-sm border border-white/10 rounded-2xl p-8 shadow-2xl">

          {/* Tab switcher */}
          <div className="flex bg-white/5 rounded-xl p-1 mb-6">
            {(['login', 'register'] as const).map((m) => (
              <button
                key={m}
                type="button"
                onClick={() => { setMode(m); setError(null); }}
                className={`flex-1 py-2 rounded-lg text-sm font-medium transition-all ${
                  mode === m
                    ? 'bg-blue-600 text-white shadow'
                    : 'text-blue-200 hover:text-white'
                }`}
              >
                {m === 'login' ? 'התחברות' : 'הרשמה'}
              </button>
            ))}
          </div>

          <form onSubmit={handleSubmit} className="space-y-4" dir="rtl">
            {/* Email */}
            <div>
              <label className="block text-xs text-blue-200 mb-1.5 font-medium">אימייל</label>
              <input
                type="email"
                required
                autoComplete="email"
                value={email}
                onChange={e => setEmail(e.target.value)}
                placeholder="you@example.com"
                className="w-full bg-white/10 border border-white/20 rounded-lg px-4 py-2.5 text-white placeholder-white/30 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent transition-all"
              />
            </div>

            {/* Password */}
            <div>
              <label className="block text-xs text-blue-200 mb-1.5 font-medium">סיסמה</label>
              <input
                type="password"
                required
                autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
                value={password}
                onChange={e => setPassword(e.target.value)}
                placeholder={mode === 'register' ? 'לפחות 6 תווים' : '••••••••'}
                className="w-full bg-white/10 border border-white/20 rounded-lg px-4 py-2.5 text-white placeholder-white/30 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent transition-all"
              />
            </div>

            {/* Confirm password (register only) */}
            {mode === 'register' && (
              <div>
                <label className="block text-xs text-blue-200 mb-1.5 font-medium">אישור סיסמה</label>
                <input
                  type="password"
                  required
                  autoComplete="new-password"
                  value={password2}
                  onChange={e => setPassword2(e.target.value)}
                  placeholder="הקלד שוב את הסיסמה"
                  className="w-full bg-white/10 border border-white/20 rounded-lg px-4 py-2.5 text-white placeholder-white/30 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent transition-all"
                />
              </div>
            )}

            {/* Error */}
            {error && (
              <div className="bg-red-500/20 border border-red-500/40 rounded-lg px-4 py-2.5 text-red-200 text-sm text-center">
                {error}
              </div>
            )}

            {/* Submit */}
            <button
              type="submit"
              disabled={loading}
              className="w-full bg-blue-600 hover:bg-blue-500 disabled:opacity-50 disabled:cursor-not-allowed text-white font-semibold py-2.5 rounded-lg text-sm transition-colors mt-2"
            >
              {loading
                ? (mode === 'login' ? 'מתחבר...' : 'נרשם...')
                : (mode === 'login' ? 'כניסה' : 'צור חשבון')}
            </button>
          </form>

          {/* Switch hint */}
          <p className="text-center text-blue-300/70 text-xs mt-5">
            {mode === 'login' ? 'אין לך חשבון עדיין? ' : 'כבר רשום? '}
            <button
              type="button"
              onClick={() => { setMode(mode === 'login' ? 'register' : 'login'); setError(null); }}
              className="text-blue-400 hover:text-blue-200 underline underline-offset-2 transition-colors"
            >
              {mode === 'login' ? 'הירשם כאן' : 'התחבר כאן'}
            </button>
          </p>
        </div>
      </div>
    </div>
  );
}
