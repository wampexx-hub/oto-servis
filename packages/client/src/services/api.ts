/**
 * Client API HTTP Client
 */

export class ApiError extends Error {
  code?: string;
  statusCode: number;

  constructor(message: string, statusCode: number, code?: string) {
    super(message);
    this.name = 'ApiError';
    this.statusCode = statusCode;
    this.code = code;
  }
}

let authToken: string | null = localStorage.getItem('auth_token');

export function setAuthToken(token: string | null) {
  authToken = token;
  if (token) {
    localStorage.setItem('auth_token', token);
  } else {
    localStorage.removeItem('auth_token');
  }
}

export function getAuthToken(): string | null {
  return authToken;
}

export async function apiRequest<T = any>(
  endpoint: string,
  options: RequestInit = {}
): Promise<T> {
  const headers = new Headers(options.headers || {});

  // Content-Type yalnızca gövde varsa gönderilir; aksi halde sunucu
  // boş gövdeli JSON isteğini reddeder ("Body cannot be empty...")
  if (options.body !== undefined && !(options.body instanceof FormData)) {
    if (!headers.has('Content-Type')) {
      headers.set('Content-Type', 'application/json');
    }
  }

  if (authToken && !headers.has('Authorization')) {
    headers.set('Authorization', `Bearer ${authToken}`);
  }

  const url = endpoint.startsWith('http') ? endpoint : `/api${endpoint.startsWith('/') ? endpoint : `/${endpoint}`}`;

  try {
    const response = await fetch(url, {
      ...options,
      headers,
      credentials: 'include'
    });

    const data = await response.json().catch(() => null);

    if (!response.ok) {
      const errorMsg = data?.error || `İşlem başarısız oldu (${response.status})`;
      throw new ApiError(errorMsg, response.status, data?.code);
    }

    return data as T;
  } catch (err: any) {
    if (err instanceof ApiError) {
      throw err;
    }
    // Network / Offline error
    throw new ApiError(
      navigator.onLine
        ? 'Sunucuya bağlanılamadı. Lütfen sunucunun açık olduğundan emin olun.'
        : 'İnternet veya ağ bağlantısı yok. Çevrimdışı moddasınız.',
      0,
      'NETWORK_ERROR'
    );
  }
}

/**
 * İkili (binary) içerik indirir (yedek ZIP veya .sqlite dosyası).
 * Tarayıcıda indirme başlatır; Electron masaüstünde kaydetme penceresi açılır.
 */
export async function apiDownload(endpoint: string, fallbackName: string): Promise<void> {
  const headers = new Headers();
  if (authToken) {
    headers.set('Authorization', `Bearer ${authToken}`);
  }

  const url = endpoint.startsWith('http')
    ? endpoint
    : `/api${endpoint.startsWith('/') ? endpoint : `/${endpoint}`}`;

  const response = await fetch(url, { headers, credentials: 'include' });
  if (!response.ok) {
    const data = await response.json().catch(() => null);
    throw new ApiError(data?.error || `İndirme başarısız oldu (${response.status})`, response.status);
  }

  const disposition = response.headers.get('Content-Disposition') || '';
  const match = disposition.match(/filename="?([^"]+)"?/);
  const filename = match?.[1] || fallbackName;

  const blob = await response.blob();
  const objectUrl = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = objectUrl;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(objectUrl), 4000);
}
