const BASE = 'http://localhost:3001/api/auth';
const LS_TOKEN = 'otzar_token';
const LS_EMAIL = 'otzar_email';

export interface AuthResult {
  token: string;
  email: string;
}

async function post(path: string, body: object): Promise<AuthResult> {
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json() as { token?: string; email?: string; error?: string };
  if (!res.ok || data.error) throw new Error(data.error ?? 'שגיאה לא ידועה');
  return { token: data.token!, email: data.email! };
}

export const authService = {
  async register(email: string, password: string): Promise<AuthResult> {
    const result = await post('/register', { email, password });
    authService.save(result);
    return result;
  },

  async login(email: string, password: string): Promise<AuthResult> {
    const result = await post('/login', { email, password });
    authService.save(result);
    return result;
  },

  save(result: AuthResult): void {
    localStorage.setItem(LS_TOKEN, result.token);
    localStorage.setItem(LS_EMAIL, result.email);
  },

  logout(): void {
    localStorage.removeItem(LS_TOKEN);
    localStorage.removeItem(LS_EMAIL);
  },

  getToken(): string | null {
    return localStorage.getItem(LS_TOKEN);
  },

  getEmail(): string | null {
    return localStorage.getItem(LS_EMAIL);
  },

  isLoggedIn(): boolean {
    const token = authService.getToken();
    if (!token) return false;
    // Check expiry without a library — JWT payload is base64url second segment
    try {
      const payload = JSON.parse(atob(token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
      return payload.exp * 1000 > Date.now();
    } catch {
      return false;
    }
  },
};
