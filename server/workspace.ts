import type { LocalDatabase } from './database';

type Operations = Pick<LocalDatabase,
  'listConversations' | 'getConversation' | 'saveConversation' | 'deleteConversation' |
  'listGroups' | 'getGroup' | 'saveGroup' | 'deleteGroup' | 'getSettings' | 'saveSettings' |
  'getAudio' | 'saveAudio' | 'deleteAudio' | 'listCheckpoints' | 'getCheckpoint' | 'createCheckpoint' | 'restoreCheckpoint'>;

/** Both storage implementations expose the same validated workspace operations. */
export type WorkspaceDatabase = {
  [K in keyof Operations]: (...args: Parameters<Operations[K]>) => ReturnType<Operations[K]> | Promise<ReturnType<Operations[K]>>;
};
