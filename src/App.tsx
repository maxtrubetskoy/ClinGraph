import { useState, useEffect, useMemo } from 'react';
import { db, auth } from './firebase';
import {
  collection,
  onSnapshot,
  doc,
  setDoc,
  deleteDoc,
  query,
  orderBy,
  where,
  getDoc
} from 'firebase/firestore';
import {
  signInWithPopup,
  GoogleAuthProvider,
  signOut,
  onAuthStateChanged,
  User
} from 'firebase/auth';
import { Conversation, ClinicalCategory, Entity, Mention, migrateToMentionsSchema, SessionGroup, SessionGroupSettings, DEFAULT_ANNOTATION_SCHEMA, normalizeAnnotationSchema, areSchemasIdentical } from './types';
import { saveAudioBlob, getAudioBlob, deleteAudioBlob } from './lib/audioDb';
import { motion, AnimatePresence } from 'motion/react';

// Components
import ConversationList from './components/ConversationList';
import ConversationEditor from './components/ConversationEditor';
import AudioRecorder from './components/AudioRecorder';
import KnowledgeGraph from './components/KnowledgeGraph';
import ClinicalNotesView from './components/ClinicalNotesView';
import RawTranscriptView from './components/RawTranscriptView';

// Icons
import { Sparkles, Brain, MessageSquare, Shield, HelpCircle, PanelLeftClose, PanelLeftOpen, X, FileText, Check, Share2, LogOut, LogIn, Copy, ExternalLink, ShieldAlert, Key, Folder, FolderPlus } from 'lucide-react';

enum OperationType {
  CREATE = 'create',
  UPDATE = 'update',
  DELETE = 'delete',
  LIST = 'list',
  GET = 'get',
  WRITE = 'write',
}

interface FirestoreErrorInfo {
  error: string;
  operationType: OperationType;
  path: string | null;
  authInfo: {
    userId?: string | null;
    email?: string | null;
    emailVerified?: boolean | null;
    isAnonymous?: boolean | null;
    tenantId?: string | null;
    providerInfo?: {
      providerId?: string | null;
      email?: string | null;
    }[];
  }
}

function handleFirestoreError(error: unknown, operationType: OperationType, path: string | null) {
  const errInfo: FirestoreErrorInfo = {
    error: error instanceof Error ? error.message : String(error),
    authInfo: {
      userId: auth.currentUser?.uid,
      email: auth.currentUser?.email,
      emailVerified: auth.currentUser?.emailVerified,
      isAnonymous: auth.currentUser?.isAnonymous,
      tenantId: auth.currentUser?.tenantId,
      providerInfo: auth.currentUser?.providerData?.map(provider => ({
        providerId: provider.providerId,
        email: provider.email,
      })) || []
    },
    operationType,
    path
  };
  console.error('Firestore Error: ', JSON.stringify(errInfo));
  throw new Error(JSON.stringify(errInfo));
}

export default function App() {
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [sessionGroups, setSessionGroups] = useState<SessionGroup[]>([]);
  const [activeGroupId, setActiveGroupId] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<'graph' | 'dialogue'>('dialogue');
  const [selectedEntityId, setSelectedEntityId] = useState<string | null>(null);
  const [selectedMentionId, setSelectedMentionId] = useState<string | null>(null);
  
  const handleSelectEntity = (id: string | null) => {
    setSelectedEntityId(id);
    setSelectedMentionId(null);
  };
  const [isSidebarOpen, setIsSidebarOpen] = useState(true);
  
  // Audio state
  const [audioUrl, setAudioUrl] = useState<string | undefined>(undefined);
  const [warningMessage, setWarningMessage] = useState<string | null>(null);
  const [isDiarizing, setIsDiarizing] = useState(false);

  // Session Creation Dialog State
  const [isCreateModalOpen, setIsCreateModalOpen] = useState(false);
  const [newSessionTitle, setNewSessionTitle] = useState('');
  const [newSessionType, setNewSessionType] = useState<'dialogue' | 'note'>('dialogue');
  const [selectedGroupIdForCreation, setSelectedGroupIdForCreation] = useState<string | null>(null);

  // Account Management & User Authentication
  const [currentUser, setCurrentUser] = useState<User | null>(null);
  const [authLoading, setAuthLoading] = useState(true);

  // Backend server readiness status
  const [serverStatus, setServerStatus] = useState<'checking' | 'ready' | 'loading' | 'error'>('checking');

  // Check backend server readiness
  useEffect(() => {
    let active = true;
    let timeoutId: any;

    const checkHealth = async () => {
      try {
        const res = await fetch('/api/health');
        if (res.ok) {
          const contentType = res.headers.get('content-type') || '';
          if (contentType.includes('application/json')) {
            const data = await res.json();
            if (data && data.status === 'ready') {
              if (active) {
                setServerStatus('ready');
                // Poll less frequently once ready (15 seconds)
                timeoutId = setTimeout(checkHealth, 15000);
                return;
              }
            }
          }
        }
        // If response is ok but not JSON (or not ready), server is booting
        if (active) {
          setServerStatus('loading');
          timeoutId = setTimeout(checkHealth, 2500);
        }
      } catch (err) {
        // Fetch failed (server not listening yet)
        if (active) {
          setServerStatus('loading');
          timeoutId = setTimeout(checkHealth, 2500);
        }
      }
    };

    checkHealth();

    return () => {
      active = false;
      clearTimeout(timeoutId);
    };
  }, []);

  // Sharing & Cloning State
  const [sharedSession, setSharedSession] = useState<Conversation | null>(null);
  const [loadingShared, setLoadingShared] = useState(false);
  const [shareError, setShareError] = useState<string | null>(null);
  const [isShareModalOpen, setIsShareModalOpen] = useState(false);
  const [copiedShareLink, setCopiedShareLink] = useState(false);
  const [sharedLinkUrl, setSharedLinkUrl] = useState('');

  // Custom AI Settings (Bring Your Own Model)
  const [userAiConfig, setUserAiConfig] = useState<any>({
    transcription: { provider: 'gemini', model: 'gemini-3.1-flash-lite', apiKey: '', baseUrl: '' },
    annotation: { provider: 'gemini', model: 'gemini-3.1-flash-lite', apiKey: '', baseUrl: '' }
  });
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [localConfig, setLocalConfig] = useState<any>({
    transcription: { provider: 'gemini', model: 'gemini-3.1-flash-lite', apiKey: '', baseUrl: '' },
    annotation: { provider: 'gemini', model: 'gemini-3.1-flash-lite', apiKey: '', baseUrl: '' }
  });

  // Load User AI settings from Firestore
  useEffect(() => {
    if (!currentUser) {
      setUserAiConfig({
        transcription: { provider: 'gemini', model: 'gemini-3.1-flash-lite', apiKey: '', baseUrl: '' },
        annotation: { provider: 'gemini', model: 'gemini-3.1-flash-lite', apiKey: '', baseUrl: '' }
      });
      return;
    }

    const docRef = doc(db, 'user_settings', currentUser.uid);
    const unsubscribe = onSnapshot(docRef, (docSnap) => {
      if (docSnap.exists()) {
        const data = docSnap.data();
        setUserAiConfig({
          transcription: data.transcription || { provider: 'gemini', model: 'gemini-3.1-flash-lite', apiKey: '', baseUrl: '' },
          annotation: data.annotation || { provider: 'gemini', model: 'gemini-3.1-flash-lite', apiKey: '', baseUrl: '' }
        });
      } else {
        setUserAiConfig({
          transcription: { provider: 'gemini', model: 'gemini-3.1-flash-lite', apiKey: '', baseUrl: '' },
          annotation: { provider: 'gemini', model: 'gemini-3.1-flash-lite', apiKey: '', baseUrl: '' }
        });
      }
    }, (error) => {
      handleFirestoreError(error, OperationType.GET, `user_settings/${currentUser.uid}`);
    });

    return () => unsubscribe();
  }, [currentUser]);

  const openSettingsModal = () => {
    setLocalConfig(JSON.parse(JSON.stringify(userAiConfig || {
      transcription: { provider: 'gemini', model: 'gemini-3.1-flash-lite', apiKey: '', baseUrl: '' },
      annotation: { provider: 'gemini', model: 'gemini-3.1-flash-lite', apiKey: '', baseUrl: '' }
    })));
    setIsSettingsOpen(true);
  };

  const handleSaveSettings = async () => {
    if (!currentUser) return;
    try {
      await setDoc(doc(db, 'user_settings', currentUser.uid), localConfig);
      setUserAiConfig(localConfig);
      setIsSettingsOpen(false);
    } catch (err) {
      handleFirestoreError(err, OperationType.WRITE, `user_settings/${currentUser.uid}`);
    }
  };

  // Firestore reference
  const conversationsCollection = collection(db, 'clinical_conversations');

  // Handle Auth Changes
  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, (user) => {
      setCurrentUser(user);
      setAuthLoading(false);
    });
    return () => unsubscribe();
  }, []);

  // Handle Google Sign-In
  const handleGoogleSignIn = async () => {
    const provider = new GoogleAuthProvider();
    try {
      await signInWithPopup(auth, provider);
    } catch (err) {
      console.error('Google Sign In Error:', err);
    }
  };

  // Handle Sign-Out
  const handleSignOut = async () => {
    try {
      await signOut(auth);
      setConversations([]);
      setActiveId(null);
    } catch (err) {
      console.error('Sign Out Error:', err);
    }
  };

  // Load shared session if 'share' query param is in the URL on mount
  useEffect(() => {
    const urlParams = new URLSearchParams(window.location.search);
    const shareId = urlParams.get('share');
    if (shareId) {
      setLoadingShared(true);
      const docRef = doc(db, 'clinical_conversations', shareId);
      getDoc(docRef)
        .then((docSnap) => {
          if (docSnap.exists()) {
            const data = docSnap.data() as Conversation;
            if (data.isShared) {
              setSharedSession({ id: docSnap.id, ...data });
              setActiveId(shareId);
            } else {
              setShareError("This clinical session is not shared publicly.");
            }
          } else {
            setShareError("The requested shared clinical session was not found.");
          }
        })
        .catch((err) => {
          console.error("Error loading shared session:", err);
          setShareError("Could not retrieve the shared session.");
        })
        .finally(() => {
          setLoadingShared(false);
        });
    }
  }, []);

  // Real-time listener for user-specific conversations
  useEffect(() => {
    if (!currentUser) {
      setConversations([]);
      return;
    }

    // Query for conversations belonging to current user
    const q = query(conversationsCollection, where('userId', '==', currentUser.uid));
    const unsubscribe = onSnapshot(q, (snapshot) => {
      const list: Conversation[] = [];
      snapshot.forEach((doc) => {
        list.push({ id: doc.id, ...doc.data() } as Conversation);
      });
      
      // Sort in memory by createdAt descending to bypass indexing limitations
      list.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
      
      setConversations(list);

      // Set first conversation as active if none selected and not viewing shared
      const urlParams = new URLSearchParams(window.location.search);
      if (list.length > 0 && !activeId && !urlParams.has('share')) {
        setActiveId(list[0].id);
      }
    }, (error) => {
      console.error("Firestore loading error:", error);
    });

    return () => unsubscribe();
  }, [currentUser, activeId]);

  // Real-time listener for user-specific session groups
  useEffect(() => {
    if (!currentUser) {
      setSessionGroups([]);
      return;
    }

    const sessionGroupsCollection = collection(db, 'session_groups');
    const q = query(sessionGroupsCollection, where('userId', '==', currentUser.uid));
    const unsubscribe = onSnapshot(q, (snapshot) => {
      const list: SessionGroup[] = [];
      snapshot.forEach((doc) => {
        list.push({ id: doc.id, ...doc.data() } as SessionGroup);
      });
      list.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
      setSessionGroups(list);
    }, (error) => {
      console.error("Firestore loading session groups error:", error);
    });

    return () => unsubscribe();
  }, [currentUser]);

  // Session group CRUD handlers
  const handleCreateGroup = async (name: string) => {
    if (!currentUser) return;
    const newGroupId = `group_${Date.now()}`;
    const newGroup: SessionGroup = {
      id: newGroupId,
      name,
      createdAt: new Date().toISOString(),
      userId: currentUser.uid,
      settings: {
        description: '',
        encounterTemplate: 'standard',
        preferredModel: 'gemini-3.5-flash',
        clinicalTaxonomy: 'all'
      }
    };
    try {
      await setDoc(doc(db, 'session_groups', newGroupId), newGroup);
    } catch (err) {
      console.error("Error creating session group:", err);
    }
  };

  const handleUpdateGroup = async (id: string, name: string, settings: any) => {
    if (!currentUser) return;
    try {
      await setDoc(doc(db, 'session_groups', id), {
        name,
        settings
      }, { merge: true });

      // Keep sharedGroupData in sync for any shared sessions belonging to this group
      const sharedSessionsInGroup = conversations.filter(c => c.groupId === id && c.isShared);
      for (const session of sharedSessionsInGroup) {
        await setDoc(doc(db, 'clinical_conversations', session.id), {
          sharedGroupData: {
            id,
            name,
            settings
          }
        }, { merge: true });
      }
    } catch (err) {
      console.error("Error updating session group:", err);
    }
  };

  const handleDeleteGroup = async (id: string) => {
    if (!currentUser) return;
    try {
      await deleteDoc(doc(db, 'session_groups', id));
      
      // Update any sessions belonging to this group to remove the group association
      const sessionsInGroup = conversations.filter(c => c.groupId === id);
      for (const session of sessionsInGroup) {
        await setDoc(doc(db, 'clinical_conversations', session.id), {
          groupId: null
        }, { merge: true });
      }
      
      if (activeGroupId === id) {
        setActiveGroupId(null);
      }
    } catch (err) {
      console.error("Error deleting session group:", err);
    }
  };

  // Clone a shared session to the current user's local workspace
  const handleCloneShared = async () => {
    if (!currentUser || !sharedSession) return;
    
    // Suffix/Version original name
    const getNextVersionTitle = (title: string): string => {
      const versionRegex = / \(v(\d+)\)$/;
      const match = title.match(versionRegex);
      if (match) {
        const currentVersion = parseInt(match[1], 10);
        return title.replace(versionRegex, ` (v${currentVersion + 1})`);
      }
      return `${title} (v2)`;
    };

    // Determine shared group info
    const sharedGroupInfo = sharedSession.sharedGroupData || (
      sharedSession.groupId ? sessionGroups.find(g => g.id === sharedSession.groupId) : null
    );

    let targetGroupId: string | null = null;
    let targetSharedGroupData: any = null;

    if (sharedGroupInfo) {
      const sharedSchema = sharedGroupInfo.settings?.annotationSchema;

      // Check if user already has an exactly identical group (exact schema match)
      // 1. First preference: group with matching name AND exact schema match
      let matchingGroup = sessionGroups.find(g => {
        return (
          g.name.toLowerCase().trim() === (sharedGroupInfo.name || '').toLowerCase().trim() &&
          areSchemasIdentical(g.settings?.annotationSchema, sharedSchema)
        );
      });

      // 2. Second preference: any group with exact schema match
      if (!matchingGroup) {
        matchingGroup = sessionGroups.find(g => {
          return areSchemasIdentical(g.settings?.annotationSchema, sharedSchema);
        });
      }

      if (matchingGroup) {
        // Exact schema match exists: add session to that existing group
        targetGroupId = matchingGroup.id;
        targetSharedGroupData = {
          id: matchingGroup.id,
          name: matchingGroup.name,
          settings: matchingGroup.settings || {}
        };
      } else {
        // No exact schema match: create a new group with the shared settings & schema
        const newGroupId = `group_${Date.now()}`;
        const newGroupName = sharedGroupInfo.name || 'Shared Annotations Group';
        const newGroupSettings: SessionGroupSettings = {
          description: sharedGroupInfo.settings?.description || '',
          encounterTemplate: sharedGroupInfo.settings?.encounterTemplate || 'standard',
          preferredModel: sharedGroupInfo.settings?.preferredModel || 'gemini-3.5-flash',
          clinicalTaxonomy: sharedGroupInfo.settings?.clinicalTaxonomy || 'all',
          annotationSchema: normalizeAnnotationSchema(sharedGroupInfo.settings?.annotationSchema || DEFAULT_ANNOTATION_SCHEMA)
        };

        const newGroup: SessionGroup = {
          id: newGroupId,
          name: newGroupName,
          createdAt: new Date().toISOString(),
          userId: currentUser.uid,
          settings: newGroupSettings
        };

        try {
          await setDoc(doc(db, 'session_groups', newGroupId), newGroup);
          targetGroupId = newGroupId;
          targetSharedGroupData = {
            id: newGroupId,
            name: newGroupName,
            settings: newGroupSettings
          };
        } catch (err) {
          console.error('Error creating group for cloned session:', err);
        }
      }
    }

    const newId = `session_${Date.now()}`;
    const clonedSession: Conversation = {
      ...sharedSession,
      id: newId,
      title: getNextVersionTitle(sharedSession.title),
      userId: currentUser.uid,
      isShared: false, // Clone of a shared session is private by default
      sharedFromId: sharedSession.id,
      groupId: targetGroupId || undefined,
      sharedGroupData: targetSharedGroupData || undefined,
      createdAt: new Date().toISOString()
    };

    try {
      await setDoc(doc(db, 'clinical_conversations', newId), clonedSession);
      // Remove share from URL
      window.history.replaceState({}, '', window.location.pathname);
      setSharedSession(null);
      setActiveId(newId);
    } catch (err) {
      console.error('Error cloning shared session:', err);
    }
  };

  // Update active conversation audio URL when selection changes
  useEffect(() => {
    if (!activeId) {
      setAudioUrl(undefined);
      return;
    }

    const activeConv = conversations.find((c) => c.id === activeId) || (sharedSession?.id === activeId ? sharedSession : null);
    if (!activeConv) return;

    if (activeConv.audioLocalId) {
      getAudioBlob(activeConv.audioLocalId).then((blob) => {
        if (blob) {
          setAudioUrl(URL.createObjectURL(blob));
        } else {
          setAudioUrl(undefined);
        }
      });
    } else if (activeConv.audioDataUrl) {
      setAudioUrl(activeConv.audioDataUrl);
    } else {
      setAudioUrl(undefined);
    }
  }, [activeId, conversations, sharedSession]);

  const activeConversationRaw = conversations.find((c) => c.id === activeId) || (sharedSession?.id === activeId ? sharedSession : null);

  const activeConversation = useMemo(() => {
    if (!activeConversationRaw) return null;
    if (!activeConversationRaw.annotation) return activeConversationRaw;

    const migrated = migrateToMentionsSchema(activeConversationRaw.annotation);
    return {
      ...activeConversationRaw,
      annotation: migrated
    };
  }, [activeConversationRaw]);

  const activeGroup = useMemo(() => {
    if (!activeConversation) return null;
    const userGroup = sessionGroups.find(g => g.id === activeConversation.groupId);
    if (userGroup) return userGroup;
    if (activeConversation.sharedGroupData) {
      return {
        id: activeConversation.sharedGroupData.id || activeConversation.groupId || 'shared_group',
        name: activeConversation.sharedGroupData.name,
        createdAt: '',
        userId: activeConversation.userId || '',
        settings: activeConversation.sharedGroupData.settings
      } as SessionGroup;
    }
    return null;
  }, [activeConversation, sessionGroups]);

  const isReadOnly = !currentUser || activeConversation?.userId !== currentUser.uid;

  // Create a new blank draft clinical session
  const handleCreateNew = async (title?: string, type: 'dialogue' | 'note' = 'dialogue', groupId?: string) => {
    if (!currentUser) return;
    const newId = `session_${Date.now()}`;
    const defaultTitle = (title && title.trim()) || (type === 'note' ? 'Draft Clinical Note' : 'Draft Dialogue Encounter');
    const newSession: Conversation = {
      id: newId,
      title: defaultTitle,
      createdAt: new Date().toISOString(),
      rawTranscript: '',
      transcriptSegments: [],
      hasAudio: false,
      status: 'draft',
      encounterType: type,
      userId: currentUser.uid,
      groupId: groupId || null
    };

    try {
      await setDoc(doc(db, 'clinical_conversations', newId), newSession);
      setActiveId(newId);
    } catch (err) {
      console.error('Error creating session in Firestore:', err);
    }
  };

  // Delete clinical session
  const handleDelete = async (id: string) => {
    try {
      const conv = conversations.find((c) => c.id === id);
      if (conv?.audioLocalId) {
        await deleteAudioBlob(conv.audioLocalId);
      }
      await deleteDoc(doc(db, 'clinical_conversations', id));
      if (activeId === id) {
        setActiveId(null);
      }
    } catch (err) {
      console.error('Error deleting session:', err);
    }
  };

  const parseNoteTextToSegments = (text: string): { id: string; speaker: string; text: string }[] => {
    if (!text) return [];

    const trimmed = text.trim();
    
    // 1. Check if it's a JSON object (e.g. SOAP fields)
    if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
      try {
        const obj = JSON.parse(trimmed);
        if (typeof obj === 'object' && obj !== null && !Array.isArray(obj)) {
          return Object.entries(obj).map(([key, val], idx) => {
            let textVal = "";
            if (typeof val === 'string') {
              textVal = val;
            } else {
              textVal = JSON.stringify(val, null, 2);
            }
            return {
              id: `seg_${idx + 1}`,
              speaker: key,
              text: textVal
            };
          });
        }
      } catch (e) {
        // Fallback to plain text if JSON parsing fails
      }
    }

    // 2. Treat as plain text, split by double newlines to find paragraphs.
    const paragraphs = trimmed.split(/\n\s*\n/).map(p => p.trim()).filter(Boolean);
    
    return paragraphs.map((para, idx) => {
      // Check if paragraph starts with a header like "Subjective:" or "Assessment:"
      const headerMatch = para.match(/^([A-Za-z0-9\s\-\.\#\:\(\)]+?)\:\s*\n?([\s\S]*)$/);
      if (headerMatch && headerMatch[1] && headerMatch[1].length < 40 && !headerMatch[1].includes('\n')) {
        const header = headerMatch[1].trim();
        const content = headerMatch[2].trim();
        if (content.length > 0) {
          return {
            id: `seg_${idx + 1}`,
            speaker: header,
            text: content
          };
        }
      }
      
      return {
        id: `seg_${idx + 1}`,
        speaker: "Document",
        text: para
      };
    });
  };

  // Update raw transcript text
  const handleTranscriptChange = async (text: string) => {
    if (!activeId) return;
    try {
      const isNote = activeConversation?.encounterType === 'note';
      let segments: any[] = [];
      let shouldUpdateSegments = false;

      if (isNote) {
        segments = parseNoteTextToSegments(text);
        shouldUpdateSegments = true;
      } else {
        // Dialogue JSONL parsing
        try {
          const lines = text.trim().split("\n");
          if (lines.length > 0 && lines[0].trim().startsWith("{") && lines[0].trim().endsWith("}")) {
            segments = lines.map((line, idx) => {
              const parsed = JSON.parse(line);
              return {
                id: `seg_${idx + 1}`,
                speaker: parsed.speaker || "Unknown",
                text: parsed.text || ""
              };
            });
            shouldUpdateSegments = true;
          }
        } catch (e) {
          // Not fully valid JSONL or syntax error while typing, which is fine
        }
      }

      const updateData: any = { rawTranscript: text };
      if (shouldUpdateSegments && segments.length > 0) {
        updateData.transcriptSegments = segments;
      }

      await setDoc(doc(db, 'clinical_conversations', activeId), updateData, { merge: true });
    } catch (err) {
      console.error('Error updating transcript:', err);
    }
  };

  // Save raw recorded audio to IndexedDB and update Firestore session
  const handleAudioRecorded = async (blob: Blob, mimeType: string, speechToText?: string) => {
    if (!activeId) return;

    const audioLocalId = `audio_${Date.now()}`;
    try {
      await saveAudioBlob(audioLocalId, blob);

      // Create object URL for immediate local preview
      setAudioUrl(URL.createObjectURL(blob));

      // Update Firestore document with audio metadata and Speech dictation if any
      const textToAppend = speechToText
        ? (activeConversation?.rawTranscript ? `${activeConversation.rawTranscript}\n${speechToText}` : speechToText)
        : activeConversation?.rawTranscript || '';

      await setDoc(doc(db, 'clinical_conversations', activeId), {
        hasAudio: true,
        audioLocalId,
        rawTranscript: textToAppend
      }, { merge: true });
    } catch (err) {
      console.error('Error saving audio record:', err);
    }
  };

  // Reset/Clear audio for active session
  const handleClearAudio = async () => {
    if (!activeId || !activeConversation) return;

    try {
      if (activeConversation.audioLocalId) {
        await deleteAudioBlob(activeConversation.audioLocalId);
      }

      await setDoc(doc(db, 'clinical_conversations', activeId), {
        hasAudio: false,
        audioLocalId: null,
        audioDataUrl: null
      }, { merge: true });

      setAudioUrl(undefined);
    } catch (err) {
      console.error('Error clearing audio:', err);
    }
  };

  // Robust helper to extract detailed server diagnostics (JSON or HTML trace/Nginx block)
  const safelyParseResponse = async (response: Response): Promise<any> => {
    const contentType = response.headers.get('content-type') || '';
    
    if (response.ok) {
      if (contentType.includes('application/json')) {
        try {
          return await response.json();
        } catch (jsonErr: any) {
          throw new Error(`Failed to parse successful JSON response: ${jsonErr.message}`);
        }
      } else {
        const rawText = await response.text();
        if (rawText.includes('<title>Cookie check</title>') || rawText.includes('Cookie check')) {
          throw new Error(`Third-Party Cookies Blocked: The browser blocked the security sandbox session cookie.\n\n👉 ACTION REQUIRED: Please click the "Open in new tab" button at the top-right of your AI Studio interface to bypass third-party cookie restrictions and run the clinical audio processors safely in a dedicated tab.`);
        }
        if (rawText.includes('Starting Server...') || rawText.includes('Starting Server') || rawText.includes('starting-screen')) {
          setServerStatus('loading');
          throw new Error(`The backend server is still initializing. Please wait a few seconds and try again.`);
        }
        throw new Error(`Server returned status 200 but content is not JSON:\n${rawText.slice(0, 500)}`);
      }
    } else {
      if (response.status === 413) {
        throw new Error(`HTTP Error 413: Request Entity Too Large.\n\n👉 MITIGATION: The uploaded file exceeds the secure gateway limit. Please record your session directly through our "Record Audio" interface (which uses our high-performance client-side compressor to shrink audio up to 90%), or select a shorter/more compressed audio file.`);
      }
      
      let errorMsg = `HTTP Error ${response.status}: ${response.statusText}`;
      if (contentType.includes('application/json')) {
        try {
          const jsonError = await response.json();
          return jsonError;
        } catch {
          // fallback
        }
      }
      
      try {
        const rawText = await response.text();
        if (rawText.includes('<title>Cookie check</title>') || rawText.includes('Cookie check')) {
          throw new Error(`Third-Party Cookies Blocked: The browser blocked the security sandbox session cookie.\n\n👉 ACTION REQUIRED: Please click the "Open in new tab" button at the top-right of your AI Studio interface to bypass third-party cookie restrictions and run the clinical audio processors safely in a dedicated tab.`);
        }
        const titleMatch = rawText.match(/<title>(.*?)<\/title>/i);
        const bodyMatch = rawText.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
        const title = titleMatch ? titleMatch[1] : '';
        let extractedBody = '';
        if (bodyMatch) {
          extractedBody = bodyMatch[1]
            .replace(/<style[^>]*>([\s\S]*?)<\/style>/gi, '')
            .replace(/<script[^>]*>([\s\S]*?)<\/script>/gi, '')
            .replace(/<[^>]+>/g, ' ')
            .replace(/\s+/g, ' ')
            .trim();
        } else {
          extractedBody = rawText.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
        }
        
        const previewText = extractedBody.slice(0, 800);
        errorMsg = `Server error HTML [${response.status} ${response.statusText}]${title ? ` - ${title}` : ''}:\n${previewText}${extractedBody.length > 800 ? '...' : ''}`;
      } catch (textErr: any) {
        if (textErr.message && textErr.message.includes('Third-Party Cookies Blocked')) {
          throw textErr;
        }
      }
      
      throw new Error(errorMsg);
    }
  };

  // Generate AI Annotations & Transcriptions using server-side Gemini API
  const handleAnnotate = async () => {
    if (!activeId || !activeConversation) return;

    // Set processing status
    await setDoc(doc(db, 'clinical_conversations', activeId), {
      status: 'processing'
    }, { merge: true });

    setWarningMessage(null);

    try {
      let response;
      const schemaToPass = normalizeAnnotationSchema(activeGroup?.settings?.annotationSchema || DEFAULT_ANNOTATION_SCHEMA);
      if (activeConversation.audioLocalId) {
        const blob = await getAudioBlob(activeConversation.audioLocalId);
        if (blob) {
          const formData = new FormData();
          formData.append('audio', blob, `audio.${blob.type.split('/')[1] || 'webm'}`);
          formData.append('audioMimeType', blob.type);
          formData.append('transcript', activeConversation.rawTranscript || '');
          formData.append('transcriptSegments', JSON.stringify(activeConversation.transcriptSegments || []));
          formData.append('annotationSchema', JSON.stringify(schemaToPass));
          formData.append('encounterType', activeConversation.encounterType || 'dialogue');
          if (userAiConfig) {
            formData.append('aiConfig', JSON.stringify(userAiConfig));
          }

          response = await fetch('/api/annotate', {
            method: 'POST',
            body: formData
          });
        }
      }

      if (!response) {
        response = await fetch('/api/annotate', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            transcript: activeConversation.rawTranscript,
            transcriptSegments: activeConversation.transcriptSegments || [],
            audioBase64: '',
            audioMimeType: '',
            annotationSchema: schemaToPass,
            aiConfig: userAiConfig ? JSON.stringify(userAiConfig) : null,
            encounterType: activeConversation.encounterType || 'dialogue'
          })
        });
      }

      const result = await safelyParseResponse(response);

      if (!result.success) {
        throw new Error(result.error || 'Server processing failed');
      }

      // If using fallback mock, display warning banner
      if (result.isMock && result.warning) {
        setWarningMessage(result.warning);
      }

      const { title, rawTranscript, transcriptSegments, entities, relations, clinicalNotes, mentions } = result.data;

      // Check if original transcript was in JSONL format to avoid scrambling it
      const isOriginalJsonl = activeConversation.rawTranscript && 
        (() => {
          const firstLine = activeConversation.rawTranscript.trim().split('\n')[0];
          return firstLine.startsWith('{') && firstLine.endsWith('}');
        })();

      let finalRawTranscript = rawTranscript || activeConversation.rawTranscript;
      let finalSegments = (transcriptSegments || []).map((seg: any, idx: number) => ({
        id: seg.id || `seg_${idx + 1}`,
        speaker: seg.speaker || "Unknown",
        text: seg.text || ""
      }));

      if (isOriginalJsonl) {
        // If original was JSONL, preserve original text and segments exactly
        finalRawTranscript = activeConversation.rawTranscript;
        finalSegments = activeConversation.transcriptSegments || [];
      } else if (finalSegments.length > 0) {
        // Automatically output in clean JSONL format to maintain consistent schema structure
        finalRawTranscript = finalSegments.map((seg: any) => JSON.stringify({
          speaker: seg.speaker,
          text: seg.text
        })).join("\n");
      }

      // Clean up any undefined values in the payload before passing to Firestore
      const updatePayload = JSON.parse(JSON.stringify({
        title: title || activeConversation.title || 'Annotated Clinical Session',
        rawTranscript: finalRawTranscript,
        transcriptSegments: finalSegments,
        annotation: {
          entities: entities || [],
          relations: relations || [],
          clinicalNotes: clinicalNotes || { symptoms: [], conditions: [], medications: [], followUps: [], measurements: [] },
          mentions: mentions || []
        },
        status: 'annotated'
      }));

      // Update Firestore with the structured annotations returned by Gemini
      await setDoc(doc(db, 'clinical_conversations', activeId), updatePayload, { merge: true });

    } catch (err: any) {
      console.error('Medical Annotation Failure:', err);
      await setDoc(doc(db, 'clinical_conversations', activeId), {
        status: 'failed'
      }, { merge: true });
      setWarningMessage(err.message || 'Annotation failed. Please confirm connection or try again.');
    }
  };

  // Generate Diarized Transcript using server-side Gemini API
  const handleDiarize = async () => {
    if (!activeId || !activeConversation) return;

    setIsDiarizing(true);
    setWarningMessage(null);

    try {
      if (!activeConversation.audioLocalId) {
        throw new Error('No audio found to transcribe. Please record or upload an audio encounter first.');
      }

      const blob = await getAudioBlob(activeConversation.audioLocalId);
      if (!blob) {
        throw new Error('Failed to retrieve audio data. Please record or upload the audio again.');
      }

      const formData = new FormData();
      formData.append('audio', blob, `audio.${blob.type.split('/')[1] || 'webm'}`);
      formData.append('audioMimeType', blob.type);
      if (userAiConfig) {
        formData.append('aiConfig', JSON.stringify(userAiConfig));
      }

      const response = await fetch('/api/diarize', {
        method: 'POST',
        body: formData
      });

      const result = await safelyParseResponse(response);

      if (!result.success) {
        throw new Error(result.error || 'Diarization processing failed');
      }

      if (result.isMock && result.warning) {
        setWarningMessage(result.warning);
      }

      const { jsonlText, segments } = result.data;

      // Update Firestore document with the diarized transcript text and segmented list
      await setDoc(doc(db, 'clinical_conversations', activeId), {
        rawTranscript: jsonlText,
        transcriptSegments: segments || []
      }, { merge: true });

    } catch (err: any) {
      console.error('Audio Diarization Failure:', err);
      setWarningMessage(err.message || 'Diarization failed. Please check your connection or try again.');
    } finally {
      setIsDiarizing(false);
    }
  };

  // Instantly initializes manual clinical curation and switches view to the workspace
  const handleManualAnnotate = async () => {
    if (!activeId || !activeConversation) return;

    try {
      // If we don't have existing annotations, create empty structures
      const emptyAnnotation = {
        entities: [],
        relations: [],
        clinicalNotes: { symptoms: [], conditions: [], medications: [], followUps: [], measurements: [] }
      };

      await setDoc(doc(db, 'clinical_conversations', activeId), {
        annotation: activeConversation.annotation || emptyAnnotation,
        status: 'annotated'
      }, { merge: true });
    } catch (err) {
      console.error('Error initializing manual annotation:', err);
    }
  };

  // Called when user makes manual edits to annotations in ClinicalNotesView
  const handleUpdateNotes = async (
    updatedNotes: ClinicalCategory, 
    updatedEntities: Entity[], 
    updatedRelations?: any[], 
    updatedMentions?: Mention[]
  ) => {
    if (!activeId || !activeConversation || !activeConversation.annotation) return;

    try {
      // Find matching relations and filter out any that point to deleted entities
      const validEntityIds = new Set(updatedEntities.map(e => e.id));
      const sourceRelations = updatedRelations || activeConversation.annotation.relations || [];
      const filteredRelations = sourceRelations.filter(
        (rel: any) => validEntityIds.has(rel.source) && validEntityIds.has(rel.target)
      );

      // Filter mentions to only keep ones pointing to valid entity IDs
      const inputMentions = updatedMentions !== undefined 
        ? updatedMentions 
        : (activeConversation.annotation.mentions || []);

      // If mentions list is empty and we had entities with textSpan, bootstrap from them
      let baseMentions = inputMentions;
      if (baseMentions.length === 0 && updatedEntities.some(e => e.textSpan && e.textSpan.lineIndex >= 0)) {
        baseMentions = updatedEntities
          .filter(e => e.textSpan && e.textSpan.lineIndex >= 0)
          .map(e => ({
            id: `m_${e.id}`,
            textSpan: e.textSpan!,
            entityType: e.type,
            entityId: e.id
          }));
      }

      const filteredMentions = baseMentions.filter((m: any) => validEntityIds.has(m.entityId));

      // Deep copy and strip undefined values for Firestore compatibility
      const cleanAnnotation = JSON.parse(JSON.stringify({
        entities: updatedEntities,
        relations: filteredRelations,
        clinicalNotes: updatedNotes,
        mentions: filteredMentions
      }));

      await setDoc(doc(db, 'clinical_conversations', activeId), {
        annotation: cleanAnnotation
      }, { merge: true });
    } catch (err) {
      console.error('Error updating curated annotations:', err);
    }
  };

  if (authLoading) {
    return (
      <div className="min-h-screen bg-slate-50 flex flex-col items-center justify-center font-sans">
        <div className="w-12 h-12 rounded-full border-4 border-blue-600/30 border-t-blue-600 animate-spin mb-4" />
        <p className="text-xs text-slate-500 font-medium tracking-tight">Securing clinical workspace...</p>
      </div>
    );
  }

  if (shareError) {
    return (
      <div className="min-h-screen bg-slate-50 flex flex-col items-center justify-center px-4 font-sans">
        <div className="w-full max-w-md bg-white border border-rose-100 shadow-xl rounded-2xl p-8 text-center space-y-4">
          <ShieldAlert className="w-12 h-12 text-rose-500 mx-auto" />
          <h2 className="text-lg font-bold text-slate-900 font-sans">Sharing Authorization Failed</h2>
          <p className="text-xs text-slate-500">{shareError}</p>
          <button
            onClick={() => {
              setShareError(null);
              window.history.replaceState({}, '', window.location.pathname);
            }}
            className="px-5 py-2.5 bg-slate-900 hover:bg-slate-800 text-white font-semibold text-xs rounded-lg shadow cursor-pointer"
          >
            Return to Workspace
          </button>
        </div>
      </div>
    );
  }

  if (!currentUser && !sharedSession && !loadingShared) {
    return (
      <div className="min-h-screen bg-slate-50 flex flex-col items-center justify-center px-4 font-sans antialiased">
        <div className="w-full max-w-md bg-white border border-slate-200/80 shadow-xl rounded-2xl p-8 space-y-6">
          <div className="flex flex-col items-center text-center space-y-2">
            <div className="w-12 h-12 bg-blue-600 rounded-xl flex items-center justify-center text-white text-2xl font-black shadow-lg shadow-blue-500/10">
              C
            </div>
            <h1 className="text-xl font-bold tracking-tight text-slate-900 mt-3 font-sans">
              ClinGraph Annotator
            </h1>
            <p className="text-xs text-slate-500 leading-normal max-w-xs">
              Convert doctor-patient conversations and medical documents into structured knowledge graphs and standardized UMLS annotations.
            </p>
          </div>

          <div className="border-t border-slate-100 pt-5 space-y-3">
            <div className="text-[10px] font-bold text-slate-400 uppercase tracking-wider text-center">
              Features
            </div>
            <ul className="space-y-2 text-xs text-slate-600">
              <li className="flex items-start gap-2">
                <Check className="w-4 h-4 text-emerald-500 shrink-0 mt-0.5" />
                <span>Secure user-specific clinical session tracking</span>
              </li>
              <li className="flex items-start gap-2">
                <Check className="w-4 h-4 text-emerald-500 shrink-0 mt-0.5" />
                <span>Google-backed sign-in and HIPAA-compliant architecture</span>
              </li>
              <li className="flex items-start gap-2">
                <Check className="w-4 h-4 text-emerald-500 shrink-0 mt-0.5" />
                <span>Instant link-based session cloning & versioning</span>
              </li>
              <li className="flex items-start gap-2">
                <Check className="w-4 h-4 text-emerald-500 shrink-0 mt-0.5" />
                <span>Automated concept mapping (RxNorm, SNOMED, ICD-10)</span>
              </li>
            </ul>
          </div>

          <button
            onClick={handleGoogleSignIn}
            className="w-full h-11 bg-slate-900 hover:bg-slate-800 text-white font-semibold text-xs rounded-xl shadow-md transition-all cursor-pointer flex items-center justify-center gap-2"
          >
            <LogIn className="w-4 h-4" />
            <span>Sign In with Google</span>
          </button>

          <div className="text-center">
            <span className="text-[10px] text-slate-400 font-medium">
              HIPAA compliant data transmission. Saved locally to your private workspace.
            </span>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-slate-50 font-sans text-slate-800 flex flex-col antialiased">
      {/* Header Navigation */}
      <nav className="h-14 bg-white border-b border-slate-200 flex items-center justify-between px-6 shrink-0 shadow-sm sticky top-0 z-40">
        <div className="flex items-center gap-4">
          <button
            onClick={() => setIsSidebarOpen(!isSidebarOpen)}
            className="p-1.5 hover:bg-slate-100 text-slate-600 hover:text-slate-900 rounded-lg transition-colors cursor-pointer mr-1"
            title={isSidebarOpen ? "Hide session sidebar" : "Show session sidebar"}
          >
            {isSidebarOpen ? <PanelLeftClose className="w-5 h-5" /> : <PanelLeftOpen className="w-5 h-5" />}
          </button>
          <div className="w-8 h-8 bg-blue-600 rounded flex items-center justify-center text-white font-bold">C</div>
          <h1 className="text-sm md:text-base font-semibold tracking-tight text-slate-900">
            ClinGraph <span className="text-slate-400 font-normal">/ Annotator v2.4</span>
          </h1>

          {/* Server Status Indicator */}
          <div className="flex items-center gap-1.5 ml-3 md:ml-4 px-2 py-0.5 rounded-full bg-slate-50 border border-slate-200/60 font-mono text-[10px] shadow-sm select-none">
            {serverStatus === 'ready' && (
              <>
                <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" />
                <span className="text-emerald-700 font-bold hidden sm:inline">Server Ready</span>
                <span className="text-emerald-700 font-bold sm:hidden">Ready</span>
              </>
            )}
            {(serverStatus === 'loading' || serverStatus === 'checking') && (
              <>
                <span className="w-1.5 h-1.5 rounded-full bg-amber-500 animate-ping" />
                <span className="text-amber-700 font-semibold animate-pulse">Initializing...</span>
              </>
            )}
            {serverStatus === 'error' && (
              <>
                <span className="w-1.5 h-1.5 rounded-full bg-rose-500" />
                <span className="text-rose-700 font-bold">Offline</span>
              </>
            )}
          </div>
        </div>
        <div className="flex items-center gap-3">
          {currentUser ? (
            <div className="flex items-center gap-2 md:gap-3">
              <div className="hidden md:flex flex-col text-right">
                <span className="text-xs font-semibold text-slate-800 leading-none">
                  {currentUser.displayName || 'Clinician'}
                </span>
                <span className="text-[10px] text-slate-400 leading-none mt-0.5 font-mono">
                  {currentUser.email}
                </span>
              </div>
              {currentUser.photoURL ? (
                <img
                  src={currentUser.photoURL}
                  alt={currentUser.displayName || 'User'}
                  className="w-8 h-8 rounded-full border border-slate-200 shadow-sm"
                  referrerPolicy="no-referrer"
                />
              ) : (
                <div className="w-8 h-8 rounded-full bg-blue-100 text-blue-700 flex items-center justify-center text-xs font-bold border border-blue-200">
                  {currentUser.email?.charAt(0).toUpperCase() || 'C'}
                </div>
              )}
              <button
                onClick={openSettingsModal}
                className="p-1.5 hover:bg-slate-100 text-slate-500 hover:text-slate-800 rounded-lg transition-all cursor-pointer flex items-center gap-1.5 border border-slate-100 hover:border-slate-200"
                title="Customize Transcription & Annotation AI models (Bring Your Own Model)"
              >
                <Key className="w-4 h-4 text-blue-600" />
                <span className="hidden sm:inline text-xs font-semibold text-slate-700">AI Models</span>
              </button>
              <button
                onClick={handleSignOut}
                className="p-1.5 hover:bg-slate-100 text-slate-500 hover:text-slate-800 rounded-lg transition-all cursor-pointer"
                title="Sign Out"
              >
                <LogOut className="w-4 h-4" />
              </button>
            </div>
          ) : (
            <button
              onClick={handleGoogleSignIn}
              className="h-9 px-3 bg-slate-900 hover:bg-slate-800 text-white font-semibold text-xs rounded-xl flex items-center gap-2 cursor-pointer transition-all shadow-sm"
            >
              <LogIn className="w-4 h-4" />
              <span className="hidden sm:inline">Sign In with Google</span>
            </button>
          )}
        </div>
      </nav>

      {/* Main Layout Workspace */}
      <main className="flex-1 w-full max-w-none px-4 md:px-6 py-4 md:py-6 flex flex-col lg:flex-row overflow-hidden gap-6">
        {/* Animated Desktop Sidebar */}
        <AnimatePresence initial={false}>
          {isSidebarOpen && (
            <motion.div
              initial={{ width: 0, opacity: 0, marginRight: 0 }}
              animate={{ width: 320, opacity: 1, marginRight: 24 }}
              exit={{ width: 0, opacity: 0, marginRight: 0 }}
              transition={{ type: 'spring', stiffness: 350, damping: 35 }}
              className="hidden lg:flex flex-col h-full shrink-0 overflow-hidden"
            >
              <div className="w-[320px] h-full">
                <ConversationList
                  conversations={conversations}
                  selectedId={activeId}
                  onSelect={setActiveId}
                  onDelete={handleDelete}
                  onCreateNew={(groupId) => {
                    setNewSessionTitle('');
                    setNewSessionType('dialogue');
                    setSelectedGroupIdForCreation(groupId || null);
                    setIsCreateModalOpen(true);
                  }}
                  sessionGroups={sessionGroups}
                  activeGroupId={activeGroupId}
                  onSelectGroup={setActiveGroupId}
                  onCreateGroup={handleCreateGroup}
                  onUpdateGroup={handleUpdateGroup}
                  onDeleteGroup={handleDeleteGroup}
                />
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        {/* Mobile sidebar (no desktop spring animation, simple conditional layout) */}
        {isSidebarOpen && (
          <div className="lg:hidden w-full flex flex-col shrink-0 mb-4">
            <ConversationList
              conversations={conversations}
              selectedId={activeId}
              onSelect={setActiveId}
              onDelete={handleDelete}
              onCreateNew={(groupId) => {
                setNewSessionTitle('');
                setNewSessionType('dialogue');
                setSelectedGroupIdForCreation(groupId || null);
                setIsCreateModalOpen(true);
              }}
              sessionGroups={sessionGroups}
              activeGroupId={activeGroupId}
              onSelectGroup={setActiveGroupId}
              onCreateGroup={handleCreateGroup}
              onUpdateGroup={handleUpdateGroup}
              onDeleteGroup={handleDeleteGroup}
            />
          </div>
        )}

        {/* Content Panel */}
        <div className="flex-1 flex flex-col gap-6 h-full overflow-y-auto">
          {activeConversation ? (
            <div className="space-y-6">
              {/* Encounter Header Banner */}
              <div className="bg-white border border-slate-100 rounded-2xl p-5 shadow-sm">
                <div className="flex flex-col md:flex-row md:items-center justify-between gap-3.5">
                  <div>
                    <h2 className="text-lg font-bold text-slate-900">
                      {activeConversation.title || 'Untitled Session'}
                    </h2>
                    <div className="flex flex-wrap items-center gap-y-1.5 gap-x-4 mt-1">
                      <p className="text-xs text-slate-400 flex items-center gap-1">
                        <span>Status:</span>
                        <span className={`font-semibold capitalize ${
                          activeConversation.status === 'annotated' ? 'text-green-500' :
                          activeConversation.status === 'processing' ? 'text-amber-500' : 'text-slate-500'
                        }`}>
                          {activeConversation.status}
                        </span>
                      </p>

                      {/* Group Assignment Dropdown */}
                      {!isReadOnly ? (
                        <div className="flex items-center gap-1.5 text-xs text-slate-400">
                          <Folder className="w-3.5 h-3.5 text-amber-500" />
                          <span>Group:</span>
                          <select
                            value={activeConversation.groupId || ''}
                            onChange={async (e) => {
                              const selectedVal = e.target.value;
                              const targetGroupId = selectedVal === '' ? null : selectedVal;
                              const targetGroup = sessionGroups.find(g => g.id === targetGroupId);
                              try {
                                const updateData: any = { groupId: targetGroupId };
                                if (activeConversation.isShared) {
                                  updateData.sharedGroupData = targetGroup ? {
                                    id: targetGroup.id,
                                    name: targetGroup.name,
                                    settings: targetGroup.settings || {}
                                  } : null;
                                }
                                await setDoc(doc(db, 'clinical_conversations', activeConversation.id), updateData, { merge: true });
                              } catch (err) {
                                console.error('Error assigning group:', err);
                              }
                            }}
                            className="bg-slate-100 hover:bg-slate-200 border border-slate-200/60 rounded px-2 py-0.5 font-bold text-slate-700 focus:outline-none cursor-pointer text-[11px] transition-colors"
                          >
                            <option value="">No Group / Unassigned</option>
                            {sessionGroups.map(g => (
                              <option key={g.id} value={g.id}>{g.name}</option>
                            ))}
                          </select>
                        </div>
                      ) : (
                        (activeGroup || activeConversation.groupId || activeConversation.sharedGroupData) && (
                          <div className="flex items-center gap-1 text-xs text-slate-400">
                            <Folder className="w-3.5 h-3.5 text-amber-500" />
                            <span>Group:</span>
                            <span className="font-semibold text-slate-600">
                              {activeGroup?.name || activeConversation.sharedGroupData?.name || 'Annotations Group'}
                            </span>
                          </div>
                        )
                      )}
                    </div>
                  </div>

                  <div className="flex items-center gap-2">
                    {/* Read-only cloning buttons versus share buttons */}
                    {isReadOnly ? (
                      <div className="flex items-center gap-2">
                        {currentUser ? (
                          <button
                            onClick={handleCloneShared}
                            className="h-9 px-4 bg-indigo-600 hover:bg-indigo-700 text-white font-semibold text-xs rounded-xl shadow-md flex items-center gap-2 cursor-pointer transition-all hover:scale-[1.02]"
                          >
                            <Copy className="w-4 h-4" />
                            <span>Clone to My Account</span>
                          </button>
                        ) : (
                          <button
                            onClick={handleGoogleSignIn}
                            className="h-9 px-4 bg-slate-900 hover:bg-slate-800 text-white font-semibold text-xs rounded-xl shadow-md flex items-center gap-2 cursor-pointer transition-all"
                          >
                            <LogIn className="w-4 h-4" />
                            <span>Sign In to Clone</span>
                          </button>
                        )}
                      </div>
                    ) : (
                      <button
                        onClick={async () => {
                          const groupForSession = sessionGroups.find(g => g.id === activeConversation.groupId) || activeGroup;
                          const sharedGroupData = groupForSession ? {
                            id: groupForSession.id,
                            name: groupForSession.name,
                            settings: groupForSession.settings || {}
                          } : null;

                          try {
                            await setDoc(doc(db, 'clinical_conversations', activeConversation.id), {
                              isShared: true,
                              sharedGroupData: sharedGroupData
                            }, { merge: true });
                            
                            // Generate link
                            const link = `${window.location.origin}${window.location.pathname}?share=${activeConversation.id}`;
                            setSharedLinkUrl(link);
                            setIsShareModalOpen(true);
                          } catch (err) {
                            console.error('Error sharing session:', err);
                          }
                        }}
                        className="h-9 px-4 bg-slate-100 hover:bg-slate-200 text-slate-700 font-semibold text-xs rounded-xl border border-slate-200/80 flex items-center gap-2 cursor-pointer transition-all"
                      >
                        <Share2 className="w-4 h-4 text-slate-500" />
                        <span>Share Session</span>
                      </button>
                    )}
                  </div>
                </div>

                <div className="mt-4 border-t border-slate-50 pt-4.5 space-y-4">
                  {/* Audio Recorder Input - only for dialogue sessions */}
                  {activeConversation.encounterType !== 'note' && (
                    <AudioRecorder
                      onAudioRecorded={handleAudioRecorded}
                      onClearAudio={handleClearAudio}
                      hasAudio={activeConversation.hasAudio}
                      audioUrl={audioUrl}
                    />
                  )}

                  {/* Transcript Text Input Area */}
                  <ConversationEditor
                    rawTranscript={activeConversation.rawTranscript}
                    onTranscriptChange={handleTranscriptChange}
                    onAnnotate={handleAnnotate}
                    onDiarize={handleDiarize}
                    onManualAnnotate={handleManualAnnotate}
                    isDiarizing={isDiarizing}
                    hasAudio={activeConversation.hasAudio}
                    status={activeConversation.status}
                    warningMessage={warningMessage}
                    encounterType={activeConversation.encounterType || 'dialogue'}
                    isReadOnly={isReadOnly}
                    isServerReady={serverStatus === 'ready'}
                  />
                </div>
              </div>

              {/* Annotation & Knowledge Graph Dashboard */}
              {activeConversation.status === 'annotated' && activeConversation.annotation && (
                <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
                  {/* Left Column (Interactive Visualization - 7 Cols) */}
                  <div className="lg:col-span-7 relative">
                    <div className="space-y-6">
                      {/* View Switch tabs */}
                    <div className="bg-white border border-slate-100 rounded-2xl p-4 shadow-sm flex flex-col gap-4">
                      <div className="flex items-center justify-between border-b border-slate-50 pb-3">
                        <h3 className="text-xs font-bold uppercase tracking-wider text-slate-400 font-mono">
                          Structured Graph Exploration
                        </h3>
                        <div className="flex bg-slate-100 p-0.5 rounded-lg">
                          <button
                            onClick={() => setActiveTab('dialogue')}
                            className={`flex items-center gap-1.5 text-xs font-semibold px-3 py-1.5 rounded-md cursor-pointer transition-colors ${
                              activeTab === 'dialogue'
                                ? 'bg-white text-blue-600 shadow-sm'
                                : 'text-slate-500 hover:text-slate-800'
                            }`}
                          >
                            {activeConversation.encounterType === 'note' ? (
                              <FileText className="w-4 h-4 text-indigo-500" />
                            ) : (
                              <MessageSquare className="w-4 h-4 text-blue-500" />
                            )}
                            <span>{activeConversation.encounterType === 'note' ? 'Document Text' : 'Dialogue'}</span>
                          </button>
                          <button
                            onClick={() => setActiveTab('graph')}
                            className={`flex items-center gap-1.5 text-xs font-semibold px-3 py-1.5 rounded-md cursor-pointer transition-colors ${
                              activeTab === 'graph'
                                ? 'bg-white text-blue-600 shadow-sm'
                                : 'text-slate-500 hover:text-slate-800'
                            }`}
                          >
                            <Brain className="w-4 h-4 text-blue-500" />
                            <span>Knowledge Graph</span>
                          </button>
                        </div>
                      </div>

                      {activeTab === 'dialogue' ? (
                        <RawTranscriptView
                          segments={activeConversation.transcriptSegments}
                          entities={activeConversation.annotation.entities}
                          mentions={activeConversation.annotation.mentions || []}
                          selectedEntityId={selectedEntityId}
                          onSelectEntity={handleSelectEntity}
                          selectedMentionId={selectedMentionId}
                          onSelectMention={setSelectedMentionId}
                          onUpdateNotes={handleUpdateNotes}
                          clinicalNotes={activeConversation.annotation.clinicalNotes}
                          encounterType={activeConversation.encounterType || 'dialogue'}
                        />
                      ) : (
                        <KnowledgeGraph
                          entities={activeConversation.annotation.entities}
                          relations={activeConversation.annotation.relations}
                          selectedEntityId={selectedEntityId}
                          onSelectEntity={handleSelectEntity}
                        />
                      )}
                    </div>
                  </div>
                  </div>

                  {/* Right Column (Clinical Categorization list - 5 Cols) */}
                  <div className="lg:col-span-5 relative min-h-[400px] lg:min-h-0">
                    <div className="lg:absolute lg:inset-0 overflow-y-auto lg:pr-2 pb-6">
                      <ClinicalNotesView
                        clinicalNotes={activeConversation.annotation.clinicalNotes}
                        entities={activeConversation.annotation.entities}
                        relations={activeConversation.annotation.relations || []}
                        mentions={activeConversation.annotation.mentions || []}
                        onUpdateNotes={handleUpdateNotes}
                        selectedEntityId={selectedEntityId}
                        onSelectEntity={handleSelectEntity}
                        selectedMentionId={selectedMentionId}
                        onSelectMention={setSelectedMentionId}
                        isReadOnly={isReadOnly}
                        segments={activeConversation.transcriptSegments || []}
                        annotationSchema={activeGroup?.settings?.annotationSchema}
                        encounterType={activeConversation.encounterType || 'dialogue'}
                      />
                    </div>
                  </div>
                </div>
              )}
            </div>
          ) : (
            <div className="bg-white border border-slate-200 rounded-2xl p-10 text-center shadow-sm flex-1 flex flex-col items-center justify-center min-h-[400px]">
              <div className="p-4 bg-blue-50 text-blue-600 rounded-2xl mb-4">
                <Brain className="w-10 h-10 animate-pulse" />
              </div>
              <h3 className="text-base font-semibold tracking-tight text-slate-800">Welcome to the Clinical Annotator</h3>
              <p className="text-xs text-slate-500 max-w-md mt-2 leading-relaxed">
                Start by choosing an existing session from the collection panel or click "New Session" to transcribe a new audio encounter and generate an entity-relation clinical graph.
              </p>
              <button
                onClick={() => {
                  setNewSessionTitle('');
                  setNewSessionType('dialogue');
                  setIsCreateModalOpen(true);
                }}
                className="mt-6 bg-blue-600 hover:bg-blue-700 text-white text-xs font-medium px-4 py-2 rounded-lg shadow-sm transition-colors cursor-pointer"
              >
                Create New Session
              </button>
            </div>
          )}
        </div>
      </main>

      {/* Bottom Status Bar */}
      <footer className="h-8 bg-slate-800 text-white flex items-center px-4 justify-between text-[10px] shrink-0 font-mono relative z-10">
        <div className="flex gap-4">
          <span className="flex items-center gap-1.5">
            <span className={`w-1.5 h-1.5 rounded-full ${
              activeConversation?.status === 'processing' ? 'bg-amber-400 animate-pulse' : 'bg-green-400'
            }`}></span>
            <span>NLP Engine Active</span>
          </span>
        </div>
        <div className="flex gap-4">
           <span>Encounter Length: {activeConversation?.rawTranscript?.length || 0} chars</span>
           <span>Entities: {activeConversation?.annotation?.entities?.length || 0}</span>
         </div>
      </footer>

      {/* Session Creation Modal */}
      <AnimatePresence>
        {isCreateModalOpen && (
          <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
            {/* Backdrop */}
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={() => setIsCreateModalOpen(false)}
              className="absolute inset-0 bg-slate-900/45 backdrop-blur-xs"
            />

            {/* Modal Card */}
            <motion.div
              initial={{ scale: 0.95, opacity: 0, y: 15 }}
              animate={{ scale: 1, opacity: 1, y: 0 }}
              exit={{ scale: 0.95, opacity: 0, y: 15 }}
              transition={{ type: 'spring', duration: 0.35 }}
              className="relative bg-white rounded-2xl shadow-xl border border-slate-100 max-w-md w-full p-6 space-y-5 overflow-hidden"
            >
              <div className="flex items-center justify-between pb-3 border-b border-slate-100">
                <div className="flex items-center gap-2">
                  <Sparkles className="w-4.5 h-4.5 text-blue-600" />
                  <h3 className="text-sm font-semibold text-slate-800">New Clinical Session</h3>
                </div>
                <button
                  onClick={() => setIsCreateModalOpen(false)}
                  className="text-slate-400 hover:text-slate-600 transition-colors p-1 rounded-lg hover:bg-slate-50 cursor-pointer"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>

              <div className="space-y-4.5">
                {/* Title Input */}
                <div className="space-y-1.5">
                  <label htmlFor="title-input" className="text-xs font-medium text-slate-500">
                    Session Title (Optional)
                  </label>
                  <input
                    id="title-input"
                    type="text"
                    placeholder={newSessionType === 'note' ? 'e.g. Cardiopulmonary Referral, SOAP Note' : 'e.g. Dr. Evans follow-up, Sarah Review'}
                    value={newSessionTitle}
                    onChange={(e) => setNewSessionTitle(e.target.value)}
                    className="w-full text-xs border border-slate-200 rounded-lg px-3 py-2 bg-white focus:outline-none focus:ring-1 focus:ring-blue-500 focus:border-blue-500"
                  />
                </div>

                {/* Session Type Grid Selectors */}
                <div className="space-y-2">
                  <label className="text-xs font-medium text-slate-500">Select Encounter Format</label>
                  <div className="grid grid-cols-1 gap-3">
                    {/* Option 1: Dialogue */}
                    <button
                      type="button"
                      onClick={() => setNewSessionType('dialogue')}
                      className={`text-left border p-3.5 rounded-xl transition-all flex items-start gap-3 cursor-pointer ${
                        newSessionType === 'dialogue'
                          ? 'border-blue-600 bg-blue-50/20 shadow-sm'
                          : 'border-slate-100 hover:border-slate-200 bg-white'
                      }`}
                    >
                      <div className={`p-2 rounded-lg shrink-0 ${
                        newSessionType === 'dialogue' ? 'bg-blue-100 text-blue-600' : 'bg-slate-50 text-slate-500'
                      }`}>
                        <MessageSquare className="w-4 h-4" />
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-1.5">
                          <span className="text-xs font-semibold text-slate-800">Diarized Audio / Dialogue</span>
                          {newSessionType === 'dialogue' && (
                            <Check className="w-3.5 h-3.5 text-blue-600 shrink-0" />
                          )}
                        </div>
                        <p className="text-[10.5px] text-slate-400 mt-1 leading-normal">
                          For verbal encounters (patient & clinician discussions). Supports recording or uploading medical audio and extracting transcripts.
                        </p>
                      </div>
                    </button>

                    {/* Option 2: Note */}
                    <button
                      type="button"
                      onClick={() => setNewSessionType('note')}
                      className={`text-left border p-3.5 rounded-xl transition-all flex items-start gap-3 cursor-pointer ${
                        newSessionType === 'note'
                          ? 'border-indigo-600 bg-indigo-50/20 shadow-sm'
                          : 'border-slate-100 hover:border-slate-200 bg-white'
                      }`}
                    >
                      <div className={`p-2 rounded-lg shrink-0 ${
                        newSessionType === 'note' ? 'bg-indigo-100 text-indigo-600' : 'bg-slate-50 text-slate-500'
                      }`}>
                        <FileText className="w-4 h-4" />
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-1.5">
                          <span className="text-xs font-semibold text-slate-800">Clinical Note / Unstructured Document</span>
                          {newSessionType === 'note' && (
                            <Check className="w-3.5 h-3.5 text-indigo-600 shrink-0" />
                          )}
                        </div>
                        <p className="text-[10.5px] text-slate-400 mt-1 leading-normal">
                          For typed documents, SOAP notes, discharge summaries, or referral letters. Skips the audio requirement and parses text layout directly.
                        </p>
                      </div>
                    </button>
                  </div>
                </div>
              </div>

              {/* Action Buttons */}
              <div className="flex items-center justify-end gap-2.5 pt-2">
                <button
                  type="button"
                  onClick={() => setIsCreateModalOpen(false)}
                  className="px-3.5 py-2 text-xs font-semibold text-slate-600 hover:text-slate-800 bg-white border border-slate-200 rounded-lg hover:bg-slate-50 cursor-pointer"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={() => {
                    handleCreateNew(newSessionTitle, newSessionType, selectedGroupIdForCreation || undefined);
                    setIsCreateModalOpen(false);
                    setSelectedGroupIdForCreation(null);
                  }}
                  className={`px-4 py-2 text-xs font-semibold text-white rounded-lg shadow-sm cursor-pointer transition-colors ${
                    newSessionType === 'note'
                      ? 'bg-indigo-600 hover:bg-indigo-700'
                      : 'bg-blue-600 hover:bg-blue-700'
                  }`}
                >
                  Create Session
                </button>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      {/* Share Session Modal */}
      <AnimatePresence>
        {isShareModalOpen && (
          <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
            {/* Backdrop */}
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={() => setIsShareModalOpen(false)}
              className="absolute inset-0 bg-slate-900/45 backdrop-blur-xs"
            />

            {/* Modal Card */}
            <motion.div
              initial={{ scale: 0.95, opacity: 0, y: 15 }}
              animate={{ scale: 1, opacity: 1, y: 0 }}
              exit={{ scale: 0.95, opacity: 0, y: 15 }}
              transition={{ type: 'spring', duration: 0.35 }}
              className="relative bg-white rounded-2xl shadow-xl border border-slate-100 max-w-md w-full p-6 space-y-4 overflow-hidden text-left"
            >
              <div className="flex items-center justify-between pb-3 border-b border-slate-100">
                <div className="flex items-center gap-2">
                  <Share2 className="w-4.5 h-4.5 text-blue-600" />
                  <h3 className="text-sm font-semibold text-slate-800 font-sans">Share Clinical Session</h3>
                </div>
                <button
                  onClick={() => setIsShareModalOpen(false)}
                  className="text-slate-400 hover:text-slate-600 transition-colors p-1 rounded-lg hover:bg-slate-50 cursor-pointer"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>

              <div className="space-y-3">
                <p className="text-xs text-slate-500 leading-relaxed font-sans">
                  Anyone with this link will be able to view a read-only preview of this clinical session, its interactive graph, and standardized UMLS annotations. They can also clone it into their private workspace to modify it.
                </p>

                <div className="flex items-center gap-2 bg-slate-50 border border-slate-200/80 rounded-xl p-2 min-w-0">
                  <input
                    type="text"
                    readOnly
                    value={sharedLinkUrl}
                    className="flex-1 text-[11px] font-mono bg-transparent outline-none text-slate-600 select-all min-w-0"
                  />
                  <button
                    onClick={() => {
                      navigator.clipboard.writeText(sharedLinkUrl);
                      setCopiedShareLink(true);
                      setTimeout(() => setCopiedShareLink(false), 2000);
                    }}
                    className="p-2 bg-white hover:bg-slate-50 border border-slate-200 rounded-lg text-slate-500 hover:text-slate-800 transition-all cursor-pointer shadow-sm shrink-0 flex items-center gap-1.5 text-xs font-semibold"
                  >
                    {copiedShareLink ? (
                      <>
                        <Check className="w-3.5 h-3.5 text-emerald-500" />
                        <span className="text-emerald-600 text-[11px]">Copied!</span>
                      </>
                    ) : (
                      <>
                        <Copy className="w-3.5 h-3.5" />
                        <span className="text-[11px]">Copy Link</span>
                      </>
                    )}
                  </button>
                </div>
              </div>

              <div className="flex justify-end pt-2 border-t border-slate-100">
                <button
                  onClick={() => setIsShareModalOpen(false)}
                  className="px-4 py-2 text-xs font-semibold text-slate-700 bg-slate-50 hover:bg-slate-100 border border-slate-200 rounded-lg cursor-pointer"
                >
                  Close
                </button>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      {/* Bring Your Own Model (BYOM) Custom AI Settings Modal */}
      <AnimatePresence>
        {isSettingsOpen && localConfig && (
          <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
            {/* Backdrop */}
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={() => setIsSettingsOpen(false)}
              className="absolute inset-0 bg-slate-900/45 backdrop-blur-xs"
            />

            {/* Modal Card */}
            <motion.div
              initial={{ scale: 0.95, opacity: 0, y: 15 }}
              animate={{ scale: 1, opacity: 1, y: 0 }}
              exit={{ scale: 0.95, opacity: 0, y: 15 }}
              transition={{ type: 'spring', duration: 0.35 }}
              className="relative bg-white rounded-2xl shadow-2xl border border-slate-200/80 max-w-xl w-full p-6 space-y-4 overflow-hidden text-left"
            >
              <div className="flex items-center justify-between pb-3 border-b border-slate-100">
                <div className="flex items-center gap-2">
                  <Key className="w-5 h-5 text-blue-600 animate-pulse" />
                  <div>
                    <h3 className="text-sm font-bold text-slate-900 font-sans">Bring Your Own Model (BYOM)</h3>
                    <p className="text-[10px] text-slate-400 font-medium">Customize your transcription & clinical entity recognition on the go</p>
                  </div>
                </div>
                <button
                  onClick={() => setIsSettingsOpen(false)}
                  className="text-slate-400 hover:text-slate-600 transition-colors p-1.5 rounded-lg hover:bg-slate-50 cursor-pointer"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>

              <div className="space-y-4 max-h-[440px] overflow-y-auto pr-1">
                {/* Section 1: Speech Transcription */}
                <div className="p-4 bg-slate-50/50 border border-slate-200/60 rounded-xl space-y-3">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-bold text-slate-800 uppercase tracking-wider">1. Audio Transcription & Diarization</span>
                    <span className="text-[10px] text-blue-600 font-medium bg-blue-50 px-2 py-0.5 rounded-full border border-blue-100">Speech-to-Text</span>
                  </div>
                  <p className="text-[10.5px] text-slate-400 leading-normal">
                    Specify the model used when you record clinical dialogues or upload raw files.
                  </p>

                  <div className="grid grid-cols-2 gap-3.5">
                    <div>
                      <label className="block text-[11px] font-bold text-slate-500 mb-1">Provider</label>
                      <select
                        value={localConfig.transcription.provider}
                        onChange={(e) => {
                          const updated = { ...localConfig.transcription, provider: e.target.value };
                          if (e.target.value === 'gemini') {
                            updated.model = 'gemini-3.1-flash-lite';
                            updated.baseUrl = '';
                          } else {
                            updated.model = 'whisper-1';
                            updated.baseUrl = 'https://api.openai.com/v1';
                          }
                          setLocalConfig({ ...localConfig, transcription: updated });
                        }}
                        className="w-full h-9 bg-white border border-slate-200 rounded-lg px-2.5 text-xs text-slate-700 focus:border-blue-500 outline-none transition-all cursor-pointer font-medium"
                      >
                        <option value="gemini">Google Gemini (Standard)</option>
                        <option value="openai">OpenAI / Custom API (Whisper)</option>
                      </select>
                    </div>

                    <div>
                      <label className="block text-[11px] font-bold text-slate-500 mb-1">Model Name</label>
                      <input
                        type="text"
                        value={localConfig.transcription.model}
                        onChange={(e) => setLocalConfig({
                          ...localConfig,
                          transcription: { ...localConfig.transcription, model: e.target.value }
                        })}
                        placeholder={localConfig.transcription.provider === 'gemini' ? 'gemini-3.1-flash-lite' : 'whisper-1'}
                        className="w-full h-9 bg-white border border-slate-200 rounded-lg px-2.5 text-xs text-slate-700 focus:border-blue-500 outline-none transition-all font-medium"
                      />
                    </div>
                  </div>

                  {localConfig.transcription.provider === 'openai' && (
                    <div className="space-y-3 pt-1">
                      <div>
                        <label className="block text-[11px] font-bold text-slate-500 mb-1">API Base URL</label>
                        <input
                          type="text"
                          value={localConfig.transcription.baseUrl}
                          onChange={(e) => setLocalConfig({
                            ...localConfig,
                            transcription: { ...localConfig.transcription, baseUrl: e.target.value }
                          })}
                          placeholder="https://api.openai.com/v1"
                          className="w-full h-9 bg-white border border-slate-200 rounded-lg px-2.5 text-xs text-slate-600 font-mono outline-none focus:border-blue-500 transition-all"
                        />
                      </div>
                    </div>
                  )}

                  <div>
                    <label className="block text-[11px] font-bold text-slate-500 mb-1">
                      API Key {localConfig.transcription.provider === 'gemini' ? '(Optional override)' : '(Required)'}
                    </label>
                    <input
                      type="password"
                      value={localConfig.transcription.apiKey || ''}
                      onChange={(e) => setLocalConfig({
                        ...localConfig,
                        transcription: { ...localConfig.transcription, apiKey: e.target.value }
                      })}
                      placeholder={localConfig.transcription.provider === 'gemini' ? 'Leave empty to use system default' : 'sk-...'}
                      className="w-full h-9 bg-white border border-slate-200 rounded-lg px-2.5 text-xs text-slate-600 font-mono outline-none focus:border-blue-500 transition-all"
                    />
                  </div>
                </div>

                {/* Section 2: Clinical Annotation */}
                <div className="p-4 bg-slate-50/50 border border-slate-200/60 rounded-xl space-y-3">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-bold text-slate-800 uppercase tracking-wider">2. Entity Recognition & UMLS Annotation</span>
                    <span className="text-[10px] text-indigo-600 font-medium bg-indigo-50 px-2 py-0.5 rounded-full border border-indigo-100">Reasoning LLM</span>
                  </div>
                  <p className="text-[10.5px] text-slate-400 leading-normal">
                    Specify the model used to extract clinical entities, SNOMED/RxNorm/ICD-10 nodes, and construct knowledge graphs.
                  </p>

                  <div className="grid grid-cols-2 gap-3.5">
                    <div>
                      <label className="block text-[11px] font-bold text-slate-500 mb-1">Provider</label>
                      <select
                        value={localConfig.annotation.provider}
                        onChange={(e) => {
                          const updated = { ...localConfig.annotation, provider: e.target.value };
                          if (e.target.value === 'gemini') {
                            updated.model = 'gemini-3.1-flash-lite';
                            updated.baseUrl = '';
                          } else {
                            updated.model = 'gpt-4o';
                            updated.baseUrl = 'https://api.openai.com/v1';
                          }
                          setLocalConfig({ ...localConfig, annotation: updated });
                        }}
                        className="w-full h-9 bg-white border border-slate-200 rounded-lg px-2.5 text-xs text-slate-700 focus:border-blue-500 outline-none transition-all cursor-pointer font-medium"
                      >
                        <option value="gemini">Google Gemini (Standard)</option>
                        <option value="openai">OpenAI / Custom API (GPT-4o/Llama)</option>
                      </select>
                    </div>

                    <div>
                      <label className="block text-[11px] font-bold text-slate-500 mb-1">Model Name</label>
                      <input
                        type="text"
                        value={localConfig.annotation.model}
                        onChange={(e) => setLocalConfig({
                          ...localConfig,
                          annotation: { ...localConfig.annotation, model: e.target.value }
                        })}
                        placeholder={localConfig.annotation.provider === 'gemini' ? 'gemini-3.1-flash-lite' : 'gpt-4o'}
                        className="w-full h-9 bg-white border border-slate-200 rounded-lg px-2.5 text-xs text-slate-700 focus:border-blue-500 outline-none transition-all font-medium"
                      />
                    </div>
                  </div>

                  {localConfig.annotation.provider === 'openai' && (
                    <div className="space-y-3 pt-1">
                      <div>
                        <label className="block text-[11px] font-bold text-slate-500 mb-1">API Base URL</label>
                        <input
                          type="text"
                          value={localConfig.annotation.baseUrl}
                          onChange={(e) => setLocalConfig({
                            ...localConfig,
                            annotation: { ...localConfig.annotation, baseUrl: e.target.value }
                          })}
                          placeholder="https://api.openai.com/v1"
                          className="w-full h-9 bg-white border border-slate-200 rounded-lg px-2.5 text-xs text-slate-600 font-mono outline-none focus:border-blue-500 transition-all"
                        />
                      </div>
                    </div>
                  )}

                  <div>
                    <label className="block text-[11px] font-bold text-slate-500 mb-1">
                      API Key {localConfig.annotation.provider === 'gemini' ? '(Optional override)' : '(Required)'}
                    </label>
                    <input
                      type="password"
                      value={localConfig.annotation.apiKey || ''}
                      onChange={(e) => setLocalConfig({
                        ...localConfig,
                        annotation: { ...localConfig.annotation, apiKey: e.target.value }
                      })}
                      placeholder={localConfig.annotation.provider === 'gemini' ? 'Leave empty to use system default' : 'sk-...'}
                      className="w-full h-9 bg-white border border-slate-200 rounded-lg px-2.5 text-xs text-slate-600 font-mono outline-none focus:border-blue-500 transition-all"
                    />
                  </div>
                </div>
              </div>

              <div className="flex justify-end gap-2.5 pt-3 border-t border-slate-100">
                <button
                  type="button"
                  onClick={() => setIsSettingsOpen(false)}
                  className="px-4 py-2 text-xs font-semibold text-slate-600 bg-white border border-slate-200 hover:bg-slate-50 rounded-xl cursor-pointer transition-colors"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={handleSaveSettings}
                  className="px-4.5 py-2 text-xs font-semibold text-white bg-blue-600 hover:bg-blue-700 rounded-xl shadow-md shadow-blue-500/10 cursor-pointer transition-all flex items-center gap-1.5"
                >
                  <Check className="w-4 h-4" />
                  <span>Save Configuration</span>
                </button>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>
    </div>
  );
}
