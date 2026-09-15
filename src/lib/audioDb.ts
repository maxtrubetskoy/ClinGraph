export async function getAudioBlob(id: string): Promise<Blob | null> {
  const response = await apiFetch(`/api/conversations/${encodeURIComponent(id)}/audio`);
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`Could not load audio: HTTP ${response.status}`);
  return response.blob();
}
import { apiFetch } from '../firebase';
