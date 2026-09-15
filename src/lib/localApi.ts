export async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await apiFetch(`/api${path}`, init);
  if (!response.ok) {
    const body = await response.json().catch(() => null);
    throw new Error(body?.error || `Server returned HTTP ${response.status}`);
  }
  return response.status === 204 ? undefined as T : response.json();
}
export function jsonRequest(method: string, value: unknown): RequestInit {
  return { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value) };
}
import { apiFetch } from '../firebase';
