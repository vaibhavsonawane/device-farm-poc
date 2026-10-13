import type { AuthTokensDto } from '@devicelab/shared-types';
import { useAuth } from '../stores/auth';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

let refreshing: Promise<boolean> | null = null;

/** Exchange the refresh token for a new pair (single-flight across concurrent 401s). */
export function refreshSession(): Promise<boolean> {
  refreshing ??= (async () => {
    const refreshToken = useAuth.getState().refreshToken;
    if (!refreshToken) return false;
    try {
      const res = await fetch('/api/auth/refresh', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refreshToken }),
      });
      if (!res.ok) {
        useAuth.getState().clear();
        return false;
      }
      useAuth.getState().setSession((await res.json()) as AuthTokensDto);
      return true;
    } catch {
      return false;
    }
  })().finally(() => {
    refreshing = null;
  });
  return refreshing;
}

async function parseError(res: Response): Promise<ApiError> {
  let message = res.statusText || `HTTP ${res.status}`;
  let details: unknown;
  try {
    const body = (await res.json()) as {
      message?: string | string[];
      errors?: { path: string; message: string }[];
    };
    if (body.errors?.length)
      message = body.errors.map((e) => (e.path ? `${e.path}: ${e.message}` : e.message)).join('; ');
    else if (body.message)
      message = Array.isArray(body.message) ? body.message.join('; ') : body.message;
    details = body;
  } catch {
    /* not JSON */
  }
  return new ApiError(res.status, message, details);
}

export interface RequestOptions {
  method?: string;
  body?: unknown;
  signal?: AbortSignal;
  raw?: boolean;
}

/** fetch wrapper: bearer token, JSON, transparent token refresh on 401. */
export async function api<T = unknown>(
  path: string,
  opts: RequestOptions = {},
  retried = false,
): Promise<T> {
  const token = useAuth.getState().accessToken;
  const res = await fetch(`/api${path}`, {
    method: opts.method ?? (opts.body === undefined ? 'GET' : 'POST'),
    headers: {
      ...(opts.body !== undefined && !(opts.body instanceof FormData)
        ? { 'Content-Type': 'application/json' }
        : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body:
      opts.body === undefined
        ? undefined
        : opts.body instanceof FormData
          ? opts.body
          : JSON.stringify(opts.body),
    signal: opts.signal,
  });
  if (res.status === 401 && !retried && path !== '/auth/login' && (await refreshSession())) {
    return api<T>(path, opts, true);
  }
  if (!res.ok) throw await parseError(res);
  if (opts.raw) return res as unknown as T;
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  return (text ? JSON.parse(text) : undefined) as T;
}

/** Authenticated file download (artifacts, builds, CSV). */
export async function downloadFile(path: string, fallbackName: string): Promise<void> {
  const res = await api<Response>(path, { raw: true });
  const blob = await res.blob();
  const cd = res.headers.get('content-disposition') ?? '';
  const name = /filename="([^"]+)"/.exec(cd)?.[1] ?? fallbackName;
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
}

/** Authenticated blob URL for inline previews (e.g. screenshots). */
export async function blobUrl(path: string): Promise<string> {
  const res = await api<Response>(path, { raw: true });
  return URL.createObjectURL(await res.blob());
}

/** Multipart upload with progress (fetch has no upload progress). */
export function uploadWithProgress<T>(
  path: string,
  form: FormData,
  onProgress: (pct: number) => void,
): Promise<T> {
  const send = (token: string | null): Promise<{ status: number; body: string }> =>
    new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', `/api${path}`);
      if (token) xhr.setRequestHeader('Authorization', `Bearer ${token}`);
      xhr.upload.onprogress = (e) =>
        e.lengthComputable && onProgress(Math.round((e.loaded / e.total) * 100));
      xhr.onload = () => resolve({ status: xhr.status, body: xhr.responseText });
      xhr.onerror = () => reject(new ApiError(0, 'Network error during upload'));
      xhr.send(form);
    });
  return (async () => {
    let r = await send(useAuth.getState().accessToken);
    if (r.status === 401 && (await refreshSession()))
      r = await send(useAuth.getState().accessToken);
    if (r.status < 200 || r.status >= 300) {
      let msg = `Upload failed (HTTP ${r.status})`;
      try {
        const b = JSON.parse(r.body) as { message?: string };
        if (b.message) msg = b.message;
      } catch {
        /* ignore */
      }
      throw new ApiError(r.status, msg);
    }
    return JSON.parse(r.body) as T;
  })();
}
