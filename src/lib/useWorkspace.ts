import { useCallback, useEffect, useRef, useState } from 'react';
import type { AnnotationCheckpoint, AnnotationCheckpointSummary, Conversation, SessionGroup, UserAiConfig } from '../types';
import { jsonRequest, request as baseRequest } from './localApi';

interface Workspace { conversations: Conversation[]; groups: SessionGroup[]; settings: UserAiConfig | null }
const replace = <T extends { id: string; createdAt: string }>(rows: T[], value: T) =>
  [...rows.filter(row => row.id !== value.id), value].sort((a, b) => b.createdAt.localeCompare(a.createdAt));

export function useWorkspace() {
  const requests = useRef(new AbortController());
  const request = useCallback(<T,>(path: string, init: RequestInit = {}) =>
    baseRequest<T>(path, { ...init, signal: requests.current.signal }), []);
  const [workspace, setWorkspace] = useState<Workspace>({ conversations: [], groups: [], settings: null });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  const mounted = useRef(false);
  // Serialize writes and focus refreshes so older responses cannot replace newer saves.
  const run = useCallback(<T,>(operation: () => Promise<T>): Promise<T> => {
    const result = queue.current.then(operation);
    queue.current = result.catch((err) => {
      if (mounted.current) setError(err.message || 'Could not save to your workspace');
    });
    return result;
  }, []);
  const reload = useCallback(() => run(async () => {
    const data = await request<Workspace>('/workspace');
    if (mounted.current) { setWorkspace(data); setError(null); }
  }), [run]);
  useEffect(() => {
    requests.current = new AbortController();
    mounted.current = true;
    void reload().catch(() => {}).finally(() => { if (mounted.current) setLoading(false); });
    const refresh = () => { void reload().catch(() => {}); };
    window.addEventListener('focus', refresh);
    return () => { mounted.current = false; requests.current.abort(); window.removeEventListener('focus', refresh); };
  }, [reload]);
  const saveConversation = useCallback((id: string, data: Partial<Conversation>, options?: { merge: boolean }) => run(async () => {
    const saved = await request<Conversation>(`/conversations/${encodeURIComponent(id)}`, jsonRequest(options?.merge ? 'PATCH' : 'PUT', data));
    setWorkspace(prev => ({ ...prev, conversations: replace(prev.conversations, saved) }));
    return saved;
  }), [run]);
  const deleteConversation = useCallback((id: string) => run(async () => {
    await request(`/conversations/${encodeURIComponent(id)}`, { method: 'DELETE' });
    setWorkspace(prev => ({ ...prev, conversations: prev.conversations.filter(c => c.id !== id) }));
  }), [run]);
  const saveGroup = useCallback((id: string, data: Partial<SessionGroup>, options?: { merge: boolean }) => run(async () => {
    const saved = await request<SessionGroup>(`/groups/${encodeURIComponent(id)}`, jsonRequest(options?.merge ? 'PATCH' : 'PUT', data));
    setWorkspace(prev => ({ ...prev, groups: replace(prev.groups, saved) }));
  }), [run]);
  const deleteGroup = useCallback((id: string) => run(async () => {
    await request(`/groups/${encodeURIComponent(id)}`, { method: 'DELETE' });
    setWorkspace(prev => ({ ...prev, groups: prev.groups.filter(g => g.id !== id),
      conversations: prev.conversations.map(c => c.groupId === id ? { ...c, groupId: null } : c) }));
  }), [run]);
  const saveSettings = useCallback((settings: UserAiConfig) => run(async () => {
    const saved = await request<UserAiConfig>('/settings', jsonRequest('PUT', settings));
    setWorkspace(prev => ({ ...prev, settings: saved }));
  }), [run]);
  const saveAudio = useCallback((id: string, blob?: Blob) => run(async () => {
    const saved = await request<Conversation>(`/conversations/${encodeURIComponent(id)}/audio`, blob
      ? { method: 'PUT', headers: { 'Content-Type': blob.type || 'application/octet-stream' }, body: blob }
      : { method: 'DELETE' });
    setWorkspace(prev => ({ ...prev, conversations: replace(prev.conversations, saved) }));
  }), [run]);
  // Share the save queue: a checkpoint clicked immediately after an edit includes that saved edit.
  const listCheckpoints = useCallback((id: string) => run(() =>
    request<AnnotationCheckpointSummary[]>(`/conversations/${encodeURIComponent(id)}/checkpoints`)), [run]);
  const getCheckpoint = useCallback((id: string, checkpointId: string) => run(() =>
    request<AnnotationCheckpoint>(`/conversations/${encodeURIComponent(id)}/checkpoints/${encodeURIComponent(checkpointId)}`)), [run]);
  const createCheckpoint = useCallback((id: string, label = '', reason: AnnotationCheckpointSummary['reason'] = 'manual') => run(() =>
    request<AnnotationCheckpoint>(`/conversations/${encodeURIComponent(id)}/checkpoints`, jsonRequest('POST', { label, reason }))), [run]);
  const restoreCheckpoint = useCallback((id: string, checkpointId: string) => run(async () => {
    const saved = await request<Conversation>(`/conversations/${encodeURIComponent(id)}/checkpoints/${encodeURIComponent(checkpointId)}/restore`, jsonRequest('POST', {}));
    setWorkspace(prev => ({ ...prev, conversations: replace(prev.conversations, saved) }));
    return saved;
  }), [run]);
  return { conversations: workspace.conversations, sessionGroups: workspace.groups, settings: workspace.settings,
    loading, error, clearError: () => setError(null), reload, saveConversation, deleteConversation, saveGroup, deleteGroup, saveSettings, saveAudio,
    listCheckpoints, getCheckpoint, createCheckpoint, restoreCheckpoint };
}
