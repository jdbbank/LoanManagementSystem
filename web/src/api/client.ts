import axios from 'axios';

export interface ApiErrorBody {
  error: { message: string; code?: string; details?: unknown };
}

/** The server's error code arrives inside `details`, and a page sometimes needs it, not only the text. */
export interface ApiRequestError extends Error {
  status?: number;
  code?: string;
  details?: unknown;
}

export const api = axios.create({
  baseURL: import.meta.env.VITE_API_URL ?? '/api',
});

export const TOKEN_KEY = 'loanms.token';

api.interceptors.request.use((config) => {
  const token = localStorage.getItem(TOKEN_KEY);
  if (token) config.headers.Authorization = `Bearer ${token}`;
  return config;
});

api.interceptors.response.use(
  (response) => response,
  (error) => {
    if (error.response?.status === 401) {
      localStorage.removeItem(TOKEN_KEY);
    }
    const body = error.response?.data?.error as ApiErrorBody['error'] | undefined;
    const message: string = body?.message ?? error.message ?? 'Request failed';
    const details = body?.details as { code?: string } | undefined;
    const wrapped = new Error(message) as ApiRequestError;
    wrapped.status = error.response?.status;
    wrapped.code = body?.code ?? details?.code;
    wrapped.details = body?.details;
    return Promise.reject(wrapped);
  },
);

/** All server responses are wrapped as { data: T } or { data: T, total: n }. */
export const unwrap = <T>(response: { data: { data: T } }): T => response.data.data;
