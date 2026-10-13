import axios from 'axios';

export interface ApiErrorBody {
  error: { message: string; code?: string; details?: unknown };
}

export const api = axios.create({ baseURL: '/api' });

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
    const message: string =
      error.response?.data?.error?.message ?? error.message ?? 'Request failed';
    return Promise.reject(new Error(message));
  },
);

/** All server responses are wrapped as { data: T } or { data: T, total: n }. */
export const unwrap = <T>(response: { data: { data: T } }): T => response.data.data;
