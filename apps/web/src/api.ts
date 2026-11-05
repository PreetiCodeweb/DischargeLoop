const BASE = '/api/v1';
const SESSION_KEY = 'dischargeloop.session';

export interface Actor {
  id: string;
  name: string;
  roles: string[];
  wardIds: string[];
}

export interface Session {
  token: string;
  persona: string;
  actor: Actor;
}

export class ApiError extends Error {
  status: number;
  code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export function readSession(): Session | null {
  const raw = localStorage.getItem(SESSION_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as Session;
  } catch {
    localStorage.removeItem(SESSION_KEY);
    return null;
  }
}

export function writeSession(session: Session | null): void {
  if (session) localStorage.setItem(SESSION_KEY, JSON.stringify(session));
  else localStorage.removeItem(SESSION_KEY);
}

export async function signIn(persona: string): Promise<Session> {
  const response = await fetch(`${BASE}/dev/session`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ persona }),
  });
  if (!response.ok) throw new ApiError(response.status, 'SESSION_FAILED', 'Could not start a session');
  const session = (await response.json()) as Session;
  writeSession(session);
  return session;
}

export async function request<T>(
  path: string,
  options: { method?: string; body?: unknown; idempotencyKey?: string } = {},
): Promise<T> {
  const session = readSession();
  if (!session) throw new ApiError(401, 'NO_SESSION', 'Please sign in');
  const headers: Record<string, string> = {
    authorization: `Bearer ${session.token}`,
    'content-type': 'application/json',
  };
  if (options.method && options.method !== 'GET') {
    headers['idempotency-key'] = options.idempotencyKey ?? crypto.randomUUID();
    headers['x-correlation-id'] = crypto.randomUUID();
  }
  const response = await fetch(BASE + path, {
    method: options.method ?? 'GET',
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    const record = (body ?? {}) as { code?: string; title?: string };
    if (response.status === 401) writeSession(null);
    throw new ApiError(response.status, record.code ?? 'REQUEST_FAILED', record.title ?? 'Request failed');
  }
  return body as T;
}
