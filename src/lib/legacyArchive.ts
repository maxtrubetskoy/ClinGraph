/** Original records are opaque: never normalize them into the current annotation model. */
export interface ArchivedSessionSummary { id: string; title: string; createdAt: string }
export interface ArchivedSession {
  id: string;
  record: Record<string, unknown>;
  group: { id: string; record: Record<string, unknown> } | null;
}
