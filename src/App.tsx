import EncounterTimeEditor from './components/EncounterTimeEditor';
import { useState, useEffect, useMemo, useRef } from 'react';
import { useWorkspace } from './lib/useWorkspace';
import { Conversation, ClinicalCategory, Entity, Mention, SessionGroup, DEFAULT_ANNOTATION_SCHEMA, normalizeAnnotationSchema } from './types';
import type { AnnotationProgress } from './types';
import { readAnnotationResponse } from './lib/annotationStream';
import { apiFetch } from './firebase';
import { ANNOTATION_CONCURRENCY_ERROR, DEFAULT_ANNOTATION_CONCURRENCY, MAX_ANNOTATION_CONCURRENCY, isValidAnnotationConcurrency } from './utils/annotationConcurrency';
import { getAudioBlob } from './lib/audioDb';
import { normalizeEvidence, reconcileEvidenceWithNotes } from './utils/evidence';
import { getProcedureRelations, unlinkDeletedProcedures } from './utils/procedureReferences';
import EvidenceGraph from './components/EvidenceGraph';
import AnnotationHistory from './components/AnnotationHistory';
import LegacyArchive from './components/LegacyArchive';
import { parseTranscriptToSegments, isJsonOrJsonlFormat } from './utils/transcriptParser';
import { reconcileSegmentsWithExisting, realignMentionsWithSegments, splitSegmentAtOffset, changeSegmentSpeaker } from './utils/segmentRealignment';
import { motion, AnimatePresence } from 'motion/react';

// Components
import ConversationList from './components/ConversationList';
import ConversationEditor from './components/ConversationEditor';
import AudioRecorder from './components/AudioRecorder';
import KnowledgeGraph from './components/KnowledgeGraph';
import ClinicalNotesView from './components/ClinicalNotesView';
import RawTranscriptView from './components/RawTranscriptView';

// Icons
import { Sparkles, Brain, MessageSquare, Shield, HelpCircle, PanelLeftClose, PanelLeftOpen, X, FileText, Check, Edit2, Share2, Copy, ExternalLink, ShieldAlert, Key, Folder, FolderPlus, FileCode, Info, History, Network, ArrowRight, Plus, Settings2 } from 'lucide-react';
import ExportJsonlModal from './components/ExportJsonlModal';

export default function App({ storageMode = 'sqlite', accountName, onSignOut }: {
  storageMode?: 'sqlite' | 'firebase'; accountName?: string; onSignOut?: () => void;
}) {
  const { conversations, sessionGroups, settings, loading, error: storageError, reload,
    saveConversation, deleteConversation, saveGroup, deleteGroup, saveSettings, saveAudio,
    listCheckpoints, getCheckpoint, createCheckpoint, restoreCheckpoint } = useWorkspace();
  const [activeId, setActiveId] = useState<string | null>(() => new URLSearchParams(window.location.search).get('session'));
  const [audioRevision, setAudioRevision] = useState(0);
  useEffect(() => {
    if (loading) return;
    setActiveId(previous => previous && conversations.some(c => c.id === previous) ? previous : conversations[0]?.id || null);
  }, [conversations, loading]);
  useEffect(() => {
    if (loading || !activeId || !conversations.some(c => c.id === activeId)) return;
    const url = new URL(window.location.href);
    if (url.searchParams.get('session') !== activeId) {
      url.searchParams.set('session', activeId);
      window.history.replaceState(null, '', url);
    }
  }, [activeId, loading, conversations]);
  const [activeGroupId, setActiveGroupId] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<'graph' | 'dialogue' | 'evidence'>('dialogue');
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
  const [annotationRuns, setAnnotationRuns] = useState<Record<string, AnnotationProgress>>({});
  const annotatingIds = useRef(new Set<string>());

  // Session Creation Dialog State
  const [isCreateModalOpen, setIsCreateModalOpen] = useState(false);
  const [newSessionTitle, setNewSessionTitle] = useState('');
  const [newSessionType, setNewSessionType] = useState<'dialogue' | 'note'>('dialogue');
  const [selectedGroupIdForCreation, setSelectedGroupIdForCreation] = useState<string | null>(null);

  // Session Renaming State
  const [isEditingTitle, setIsEditingTitle] = useState(false);
  const [editingTitleText, setEditingTitleText] = useState('');

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

  // Local session links and export
  const [isShareModalOpen, setIsShareModalOpen] = useState(false);
  const [isExportJsonlOpen, setIsExportJsonlOpen] = useState(false);
  const [isHistoryOpen, setIsHistoryOpen] = useState(false);
  const [isArchiveOpen, setIsArchiveOpen] = useState(false);
  const [copiedShareLink, setCopiedShareLink] = useState(false);
  const [sharedLinkUrl, setSharedLinkUrl] = useState('');

  // Custom AI Settings (Bring Your Own Model)
  const [userAiConfig, setUserAiConfig] = useState<any>({
    transcription: { provider: 'gemini', model: 'gemini-3.1-flash-lite', apiKey: '', baseUrl: '' },
    annotation: { provider: 'gemini', model: 'gemini-3.1-flash-lite', apiKey: '', baseUrl: '', concurrency: DEFAULT_ANNOTATION_CONCURRENCY }
  });
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [isDismissedKeyBanner, setIsDismissedKeyBanner] = useState(false);
  const [localConfig, setLocalConfig] = useState<any>({
    transcription: { provider: 'gemini', model: 'gemini-3.1-flash-lite', apiKey: '', baseUrl: '' },
    annotation: { provider: 'gemini', model: 'gemini-3.1-flash-lite', apiKey: '', baseUrl: '', concurrency: DEFAULT_ANNOTATION_CONCURRENCY }
  });
  const [settingsSaveError, setSettingsSaveError] = useState<string | null>(null);
  const annotationConcurrencyValid = isValidAnnotationConcurrency(localConfig.annotation.concurrency);

  // Check if visitor has configured any API keys
  const hasUserConfiguredKeys = Boolean(
    userAiConfig?.annotation?.apiKey?.trim() || userAiConfig?.transcription?.apiKey?.trim()
  );

  useEffect(() => {
    if (settings) setUserAiConfig({ ...settings, annotation: {
      ...settings.annotation, concurrency: settings.annotation.concurrency ?? DEFAULT_ANNOTATION_CONCURRENCY
    } });
  }, [settings]);

  const openSettingsModal = () => {
    setSettingsSaveError(null);
    setLocalConfig(JSON.parse(JSON.stringify(userAiConfig || {
      transcription: { provider: 'gemini', model: 'gemini-3.1-flash-lite', apiKey: '', baseUrl: '' },
      annotation: { provider: 'gemini', model: 'gemini-3.1-flash-lite', apiKey: '', baseUrl: '', concurrency: DEFAULT_ANNOTATION_CONCURRENCY }
    })));
    setIsSettingsOpen(true);
  };

  const handleSaveSettings = async () => {
    if (!annotationConcurrencyValid) return;
    setSettingsSaveError(null);
    try {
      await saveSettings(localConfig);
      setUserAiConfig(localConfig);
      setIsSettingsOpen(false);
    } catch (err) {
      console.error('Could not save AI settings:', err);
      setSettingsSaveError(err instanceof Error ? err.message : 'Could not save AI settings. Please try again.');
    }
  };

  // Session group CRUD handlers
  const handleCreateGroup = async (name: string) => {
    const newGroupId = `group_${crypto.randomUUID()}`;
    const newGroup: SessionGroup = {
      id: newGroupId,
      name,
      createdAt: new Date().toISOString(),
      settings: {
        description: '',
        encounterTemplate: 'standard',
        preferredModel: 'gemini-3.5-flash',
        clinicalTaxonomy: 'all'
      }
    };
    try {
      await saveGroup(newGroupId, newGroup);
    } catch (err) {
      console.error("Error creating session group:", err);
    }
  };

  const handleUpdateGroup = async (id: string, name: string, settings: any) => {
    try {
      await saveGroup(id, {
        name,
        settings
      }, { merge: true });

    } catch (err) {
      console.error("Error updating session group:", err);
    }
  };

  const handleDeleteGroup = async (id: string) => {
    try {
      await deleteGroup(id);
      
      if (activeGroupId === id) {
        setActiveGroupId(null);
      }
    } catch (err) {
      console.error("Error deleting session group:", err);
    }
  };

  const activeConversationRaw = conversations.find((c) => c.id === activeId);
  const activeGroup = sessionGroups.find(g => g.id === activeConversationRaw?.groupId) || null;
  const activeSchema = useMemo(() => normalizeAnnotationSchema(activeConversationRaw?.schemaSnapshot?.categories ||
    activeGroup?.settings?.annotationSchema || DEFAULT_ANNOTATION_SCHEMA), [activeConversationRaw?.schemaSnapshot, activeGroup?.settings?.annotationSchema]);
  const activeAudioId = activeConversationRaw?.audioLocalId;
  useEffect(() => {
    setIsEditingTitle(false);
    setEditingTitleText('');
    setAudioUrl(undefined);
    let cancelled = false;
    let objectUrl: string | undefined;
    if (activeAudioId) {
      getAudioBlob(activeAudioId).then(blob => {
        if (!cancelled && blob) {
          objectUrl = URL.createObjectURL(blob);
          setAudioUrl(objectUrl);
        }
      }).catch(err => { if (!cancelled) setWarningMessage(err.message); });
    }
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [activeId, activeAudioId, audioRevision]);

  const activeConversation = useMemo(() => {
    if (!activeConversationRaw) return null;
    if (!activeConversationRaw.annotation) return activeConversationRaw;

    const migrated = normalizeEvidence(activeConversationRaw.annotation, activeSchema);
    return {
      ...activeConversationRaw,
      annotation: migrated
    };
  }, [activeConversationRaw, activeSchema]);

  const isReadOnly = false;

  // Create a new blank draft clinical session
  const handleCreateNew = async (title?: string, type: 'dialogue' | 'note' = 'dialogue', groupId?: string) => {
    const newId = `session_${crypto.randomUUID()}`;
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
      groupId: groupId || null
    };

    try {
      await saveConversation(newId, newSession);
      setActiveId(newId);
    } catch (err) {
      console.error('Error creating session in local database:', err);
    }
  };

  // Delete clinical session
  const handleDelete = async (id: string) => {
    try {
      const checkpoints = await listCheckpoints(id);
      if (checkpoints.length && !window.confirm(`Delete this session and its ${checkpoints.length} saved checkpoint(s)? Download any checkpoints you want to keep first. This cannot be undone.`)) return;
      await deleteConversation(id);
      if (activeId === id) {
        setActiveId(null);
      }
    } catch (err) {
      console.error('Error deleting session:', err);
    }
  };

  // Rename clinical session
  const handleRenameSession = async (id: string, newTitle: string) => {
    const trimmed = newTitle.trim();
    if (!trimmed) return;
    try {
      await saveConversation(id, {
        title: trimmed
      }, { merge: true });
    } catch (err) {
      console.error('Error renaming session:', err);
    }
  };

  // Update raw transcript text with stable segment identity preservation and mention span realignment
  const handleTranscriptChange = async (text: string) => {
    if (!activeId) return;
    try {
      const isNote = activeConversation?.encounterType === 'note';
      const rawParsedSegments = parseTranscriptToSegments(text, isNote ? 'note' : 'dialogue');
      const oldSegments = activeConversation?.transcriptSegments || [];
      const reconciledSegments = reconcileSegmentsWithExisting(rawParsedSegments, oldSegments);

      const updateData: any = { rawTranscript: text, transcriptSegments: reconciledSegments };

      // Realign mentions and entities across the changed/split/inserted segments
      const currentMentions = activeConversation?.annotation?.mentions || [];
      const currentEntities = activeConversation?.annotation?.entities || [];

      if (currentMentions.length > 0 || currentEntities.length > 0) {
        const { realignedMentions, realignedEntities } = realignMentionsWithSegments(
          oldSegments,
          reconciledSegments,
          currentMentions,
          currentEntities
        );

        if (activeConversation?.annotation) {
          updateData.annotation = {
            ...activeConversation.annotation,
            mentions: realignedMentions,
            entities: realignedEntities
          };
        }
      }

      return await saveConversation(activeId, updateData, { merge: true });
    } catch (err) {
      console.error('Error updating transcript:', err);
    }
  };

  // Direct utterance split from transcript view
  const handleSplitUtterance = async (
    segmentIndex: number,
    splitCharOffset: number,
    newSpeaker: string
  ) => {
    if (!activeId || !activeConversation) return;
    try {
      const currentSegments = activeConversation.transcriptSegments || [];
      const currentMentions = activeConversation.annotation?.mentions || [];
      const currentEntities = activeConversation.annotation?.entities || [];

      const result = splitSegmentAtOffset(
        currentSegments,
        segmentIndex,
        splitCharOffset,
        newSpeaker,
        activeConversation.rawTranscript || '',
        currentMentions,
        currentEntities
      );

      const updateData: any = {
        rawTranscript: result.updatedTranscript,
        transcriptSegments: result.updatedSegments,
        annotation: {
          ...activeConversation.annotation,
          mentions: result.updatedMentions,
          entities: result.updatedEntities
        }
      };

      await saveConversation(activeId, updateData, { merge: true });
    } catch (err) {
      console.error('Error splitting utterance:', err);
    }
  };

  // Direct speaker change from transcript view
  const handleChangeSpeaker = async (segmentIndex: number, newSpeaker: string) => {
    if (!activeId || !activeConversation) return;
    try {
      const currentSegments = activeConversation.transcriptSegments || [];
      const currentMentions = activeConversation.annotation?.mentions || [];

      const result = changeSegmentSpeaker(
        currentSegments,
        segmentIndex,
        newSpeaker,
        activeConversation.rawTranscript || '',
        currentMentions
      );

      const updateData: any = {
        rawTranscript: result.updatedTranscript,
        transcriptSegments: result.updatedSegments,
        annotation: {
          ...activeConversation.annotation,
          mentions: result.updatedMentions
        }
      };

      await saveConversation(activeId, updateData, { merge: true });
    } catch (err) {
      console.error('Error changing speaker:', err);
    }
  };

  // Audio and its ownership metadata are committed together in SQLite.
  const handleAudioRecorded = async (blob: Blob, mimeType: string, speechToText?: string) => {
    if (!activeId) return;
    try {
      await saveAudio(activeId, blob);
      setAudioRevision(value => value + 1);
      if (speechToText) {
        const text = [activeConversation?.rawTranscript, speechToText].filter(Boolean).join('\n');
        await handleTranscriptChange(text);
      }
    } catch (err) {
      console.error('Error saving audio:', err);
    }
  };

  const handleClearAudio = async () => {
    if (!activeId) return;
    try {
      await saveAudio(activeId);
      setAudioUrl(undefined);
    } catch (err) {
      console.error('Error clearing audio:', err);
    }
  };

  const safelyParseResponse = async (response: Response): Promise<any> => {
    const result = await response.json().catch(() => {
      throw new Error('The server returned an invalid response. Please try again.');
    });
    if (!response.ok) throw new Error(result.error || `HTTP ${response.status}`);
    return result;
  };

  const handleAnnotate = async (text?: string) => {
    if (!activeId || !activeConversation || annotatingIds.current.has(activeId)) return;

    annotatingIds.current.add(activeId);
    let latestProgress: AnnotationProgress = { stage: 'preparing', utterances: [] };
    const updateProgress = (progress: AnnotationProgress) => {
      latestProgress = progress;
      setAnnotationRuns(previous => ({ ...previous, [activeId]: progress }));
    };
    updateProgress(latestProgress);
    setWarningMessage(null);
    try {
      const sourceConversation = text !== undefined && text !== activeConversation.rawTranscript
        ? await handleTranscriptChange(text)
        : activeConversation;
      if (!sourceConversation) return;
      if (sourceConversation.annotation) await createCheckpoint(activeId, 'Before AI regeneration', 'before-ai');
      await saveConversation(activeId, { status: 'processing', annotationProgress: null }, { merge: true });
      let response;
      const schemaToPass = activeSchema;
      if (sourceConversation.audioLocalId && !sourceConversation.rawTranscript.trim()) {
        const blob = await getAudioBlob(sourceConversation.audioLocalId);
        if (blob) {
          const formData = new FormData();
          formData.append('audio', blob, `audio.${blob.type.split('/')[1] || 'webm'}`);
          formData.append('audioMimeType', blob.type);
          formData.append('transcript', sourceConversation.rawTranscript || '');
          formData.append('transcriptSegments', JSON.stringify(sourceConversation.transcriptSegments || []));
          formData.append('annotationSchema', JSON.stringify(schemaToPass));
          formData.append('encounterType', sourceConversation.encounterType || 'dialogue');
          formData.append('encounterTime', JSON.stringify(sourceConversation.encounterTime || null));
          if (userAiConfig) {
            formData.append('aiConfig', JSON.stringify(userAiConfig));
          }

          response = await apiFetch('/api/annotate', {
            method: 'POST',
            headers: { Accept: 'application/x-ndjson' },
            body: formData
          });
        }
      }

      if (!response) {
        response = await apiFetch('/api/annotate', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Accept: 'application/x-ndjson'
          },
          body: JSON.stringify({
            transcript: sourceConversation.rawTranscript,
            transcriptSegments: sourceConversation.transcriptSegments || [],
            audioBase64: '',
            audioMimeType: '',
            annotationSchema: schemaToPass,
            aiConfig: userAiConfig ? JSON.stringify(userAiConfig) : null,
            encounterType: sourceConversation.encounterType || 'dialogue',
            encounterTime: sourceConversation.encounterTime || null
          })
        });
      }

      const result = await readAnnotationResponse(response, updateProgress);

      if (!result.success) {
        throw new Error(result.error || 'Server processing failed');
      }


      const { title, rawTranscript, transcriptSegments, entities, relations, clinicalNotes, mentions } = result.data;

      // Check if original transcript was in JSON / JSONL format to avoid scrambling it
      const isOriginalJson = sourceConversation.rawTranscript && isJsonOrJsonlFormat(sourceConversation.rawTranscript);

      let finalRawTranscript = rawTranscript || sourceConversation.rawTranscript;
      let finalSegments = (transcriptSegments || []).map((seg: any, idx: number) => ({
        id: seg.id || `seg_${idx + 1}`,
        speaker: seg.speaker || "Unknown",
        text: seg.text || "",
        ...(seg.timestamp ? { timestamp: seg.timestamp } : {})
      }));

      if (isOriginalJson) {
        // If original was JSON/JSONL, preserve original text and segments exactly
        finalRawTranscript = sourceConversation.rawTranscript;
        finalSegments = (sourceConversation.transcriptSegments && sourceConversation.transcriptSegments.length > 0)
          ? sourceConversation.transcriptSegments
          : parseTranscriptToSegments(sourceConversation.rawTranscript, sourceConversation.encounterType || 'dialogue');
      } else if (finalSegments.length === 0 && finalRawTranscript) {
        finalSegments = parseTranscriptToSegments(finalRawTranscript, sourceConversation.encounterType || 'dialogue');
      }

      // Preserve existing session title if already set rather than replacing with AI generated title
      const existingTitle = sourceConversation.title?.trim();
      const finalTitle = existingTitle || title || 'Annotated Clinical Session';

      const updatePayload: Partial<Conversation> = {
        title: finalTitle,
        rawTranscript: finalRawTranscript,
        transcriptSegments: finalSegments,
        annotation: {
          evidenceVersion: 2,
          entities: entities || [],
          relations: [], // Separated altogether from Generate AI Annotations
          clinicalNotes: clinicalNotes || { symptoms: [], conditions: [], medications: [], followUps: [], measurements: [] },
          mentions: mentions || []
        },
        status: 'annotated',
        annotationProgress: result.progress || null
      };

      // Update local database with the structured annotations returned by Gemini
      await saveConversation(activeId, updatePayload, { merge: true });

    } catch (err: any) {
      console.error('Medical Annotation Failure:', err);
      const failedProgress: AnnotationProgress = {
        ...latestProgress, stage: 'failed',
        error: err.message || 'Annotation failed. Please confirm connection or try again.',
        utterances: latestProgress.utterances.map(item => item.status === 'in_progress' ? { ...item, status: 'pending' } : item)
      };
      updateProgress(failedProgress);
      await saveConversation(activeId, { status: 'failed', annotationProgress: failedProgress }, { merge: true }).catch(() => {});
    } finally {
      annotatingIds.current.delete(activeId);
      setAnnotationRuns(previous => {
        const next = { ...previous };
        delete next[activeId];
        return next;
      });
    }
  };

  // Dedicated generator for Knowledge Graph Relations
  const [isGeneratingRelations, setIsGeneratingRelations] = useState(false);

  const handleGenerateRelations = async () => {
    if (!activeId || !activeConversation) return;

    const entities = activeConversation.annotation?.entities;
    if (!entities || entities.length === 0) {
      setWarningMessage('No clinical entities available. Please run "Generate AI Annotations" first to extract entities before generating relationships.');
      return;
    }

    setIsGeneratingRelations(true);
    setWarningMessage(null);

    try {
      const response = await apiFetch('/api/relations', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          transcript: activeConversation.rawTranscript,
          transcriptSegments: activeConversation.transcriptSegments || [],
          entities: entities,
          mentions: activeConversation.annotation?.mentions || [],
          aiConfig: userAiConfig ? JSON.stringify(userAiConfig) : null
        })
      });

      const result = await safelyParseResponse(response);

      if (!result.success) {
        throw new Error(result.error || 'Failed to generate knowledge graph relations');
      }


      const generatedRelations = result.data?.relations || [];

      // Update local database with the generated relations
      const updatedAnnotation = {
        ...activeConversation.annotation,
        relations: generatedRelations
      };

      await saveConversation(activeId, {
        annotation: updatedAnnotation
      }, { merge: true });

    } catch (err: any) {
      console.error('Knowledge Graph Relations Failure:', err);
      setWarningMessage(err.message || 'Failed to generate graph relations. Please try again.');
    } finally {
      setIsGeneratingRelations(false);
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

      const response = await apiFetch('/api/diarize', {
        method: 'POST',
        body: formData
      });

      const result = await safelyParseResponse(response);

      if (!result.success) {
        throw new Error(result.error || 'Diarization processing failed');
      }


      const { jsonlText, segments } = result.data;

      // Update local database document with the diarized transcript text and segmented list
      await saveConversation(activeId, {
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
        evidenceVersion: 2 as const,
        entities: [],
        relations: [],
        mentions: [],
        clinicalNotes: { symptoms: [], conditions: [], medications: [], followUps: [], measurements: [] }
      };

      await saveConversation(activeId, {
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

      const baseMentions = updatedMentions ?? activeConversation.annotation.mentions ?? [];
      // Delete evidence with its owner, but preserve deliberately unlinked legacy mentions.
      const filteredMentions = baseMentions.filter(m => !m.target || validEntityIds.has(m.target.entityId));

      const deletedIds = new Set(activeConversation.annotation.entities.filter(entity => !validEntityIds.has(entity.id)).map(entity => entity.id));
      const cleanAnnotation = reconcileEvidenceWithNotes(unlinkDeletedProcedures({
        evidenceVersion: 2,
        entities: updatedEntities,
        relations: filteredRelations,
        clinicalNotes: updatedNotes,
        mentions: filteredMentions
      }, deletedIds), activeSchema);

      await saveConversation(activeId, {
        annotation: cleanAnnotation
      }, { merge: true });
    } catch (err) {
      console.error('Error updating curated annotations:', err);
      setWarningMessage(err instanceof Error ? err.message : 'Could not save annotation changes.');
    }
  };

  if (loading) {
    return <div className="min-h-screen flex items-center justify-center text-slate-500">Loading workspace...</div>;
  }

  return (
    <div className="min-h-screen bg-slate-50 font-sans text-slate-800 flex flex-col antialiased">
      {/* Header Navigation */}
      <nav className="app-header" aria-label="Workspace navigation">
        <div className="flex items-center gap-3 min-w-0">
          <button
            onClick={() => setIsSidebarOpen(!isSidebarOpen)}
            className="icon-button"
            title={isSidebarOpen ? "Hide session sidebar" : "Show session sidebar"}
          >
            {isSidebarOpen ? <PanelLeftClose className="w-5 h-5" /> : <PanelLeftOpen className="w-5 h-5" />}
          </button>
          <div className="brand-mark"><Network className="w-5 h-5" strokeWidth={1.8} /></div>
          <div>
            <h1 className="text-lg font-semibold tracking-tight text-slate-900">ClinGraph</h1>
            <p className="text-2xs text-slate-500 hidden sm:block">Clinical annotation workspace</p>
          </div>

          {/* Server Status Indicator */}
          <div className="hidden md:flex items-center gap-2 ml-5 pl-5 border-l border-slate-200 text-xs select-none">
            {serverStatus === 'ready' && (
              <>
                <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" />
                <span className="text-emerald-700 font-semibold hidden sm:inline">Server Ready</span>
                <span className="text-emerald-700 font-semibold sm:hidden">Ready</span>
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
                <span className="text-rose-700 font-semibold">Offline</span>
              </>
            )}
          </div>
        </div>
        <div className="flex items-center gap-2 md:gap-3">
          {storageMode === 'firebase' && <button type="button" onClick={() => setIsArchiveOpen(true)} className="btn btn-secondary">Legacy archive</button>}
          {/* Universal API Key Button visible for everyone */}
          <button
            id="byok-settings-header-btn"
            onClick={openSettingsModal}
            className="btn btn-secondary"
            title="Configure your own Gemini or OpenAI API keys (Bring Your Own Model)"
          >
            <Settings2 className="w-4 h-4" />
            <span>AI Settings</span>
            {hasUserConfiguredKeys && <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" />}
          </button>

          <span className="hidden lg:inline text-xs text-slate-500">{storageMode === 'firebase' ? accountName : 'Local workspace · No login'}</span>
          {onSignOut && <button type="button" onClick={onSignOut} className="btn btn-secondary">Sign out</button>}
        </div>
      </nav>
      {isArchiveOpen && <LegacyArchive onClose={() => setIsArchiveOpen(false)} />}

      {storageError && (
        <div role="alert" className="bg-rose-50 border-b border-rose-200 px-6 py-3 text-sm text-rose-800">
          Workspace error: {storageError}. Your last action may not have been saved.
          <button className="ml-3 underline cursor-pointer" onClick={() => { void reload().catch(() => {}); }}>Reload saved data</button>
        </div>
      )}

      {/* Global dismissible hint banner when no keys are set */}
      {!hasUserConfiguredKeys && !isDismissedKeyBanner && (
        <div className="workspace-hint">
          <div className="flex items-center gap-2.5 min-w-0">
            <div className="text-brand-600 shrink-0">
              <Info className="w-4 h-4" />
            </div>
            <span>
              <strong className="font-medium text-slate-700">Ready for manual annotation.</strong> <span className="hidden sm:inline">Connect a model to enable AI annotation and transcription.</span>
            </span>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <button
              type="button"
              onClick={openSettingsModal}
              className="text-xs font-semibold text-brand-700 hover:underline whitespace-nowrap"
            >
              Configure AI
            </button>
            <button
              type="button"
              onClick={() => setIsDismissedKeyBanner(true)}
              className="icon-button"
              title="Dismiss banner"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>
      )}

      {/* Main Layout Workspace */}
      <main className="workspace-layout">
        {/* Animated Desktop Sidebar */}
        <AnimatePresence initial={false}>
          {isSidebarOpen && (
            <motion.div
              initial={{ width: 0, opacity: 0 }}
              animate={{ width: 272, opacity: 1 }}
              exit={{ width: 0, opacity: 0 }}
              transition={{ type: 'spring', stiffness: 350, damping: 35 }}
              className="hidden lg:flex flex-col shrink-0 sticky top-24"
            >
              <div className="w-[272px]">
                <ConversationList
                  conversations={conversations}
                  selectedId={activeId}
                  onSelect={setActiveId}
                  onDelete={handleDelete}
                  onRename={handleRenameSession}
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
          <div className="lg:hidden w-full flex flex-col shrink-0">
            <ConversationList
              conversations={conversations}
              selectedId={activeId}
              onSelect={setActiveId}
              onDelete={handleDelete}
              onRename={handleRenameSession}
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
        <div className="workspace-content">
          {activeConversation ? (
            <div className="space-y-6">
              {/* Encounter Header Banner */}
              <div className="panel session-panel">
                <div className="flex flex-col xl:flex-row xl:items-center justify-between gap-4">
                  <div className="flex-1 min-w-0">
                    <p className="eyebrow mb-2">{activeConversation.encounterType === 'note' ? 'Clinical document' : 'Clinical encounter'}</p>
                    {!isReadOnly && isEditingTitle ? (
                      <div className="flex items-center gap-2 max-w-lg mb-1">
                        <input
                          type="text"
                          value={editingTitleText}
                          onChange={(e) => setEditingTitleText(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') {
                              e.preventDefault();
                              if (editingTitleText.trim()) {
                                handleRenameSession(activeConversation.id, editingTitleText.trim());
                              }
                              setIsEditingTitle(false);
                            } else if (e.key === 'Escape') {
                              e.preventDefault();
                              setIsEditingTitle(false);
                            }
                          }}
                          className="text-base font-semibold text-slate-900 bg-white border border-brand-400 rounded-lg px-2.5 py-1 focus:ring-2 focus:ring-brand-500 focus:outline-none w-full shadow-xs"
                          placeholder="Session title..."
                          autoFocus
                        />
                        <button
                          type="button"
                          onClick={() => {
                            if (editingTitleText.trim()) {
                              handleRenameSession(activeConversation.id, editingTitleText.trim());
                            }
                            setIsEditingTitle(false);
                          }}
                          className="p-1.5 bg-brand-600 hover:bg-brand-700 text-white rounded-lg transition-colors cursor-pointer shrink-0 shadow-xs"
                          title="Save title"
                        >
                          <Check className="w-4 h-4" />
                        </button>
                        <button
                          type="button"
                          onClick={() => setIsEditingTitle(false)}
                          className="p-1.5 bg-slate-100 hover:bg-slate-200 text-slate-500 rounded-lg transition-colors cursor-pointer shrink-0"
                          title="Cancel"
                        >
                          <X className="w-4 h-4" />
                        </button>
                      </div>
                    ) : (
                      <div className="flex items-center gap-2 group/title">
                        <h2 className="text-2xl font-semibold tracking-tight text-slate-900 truncate">
                          {activeConversation.title || 'Untitled Session'}
                        </h2>
                        {!isReadOnly && (
                          <button
                            type="button"
                            onClick={() => {
                              setEditingTitleText(activeConversation.title || '');
                              setIsEditingTitle(true);
                            }}
                            className="p-1 text-slate-500 hover:text-brand-600 hover:bg-slate-100 rounded-md transition-all cursor-pointer opacity-70 group-hover/title:opacity-100"
                            title="Rename Session"
                          >
                            <Edit2 className="w-3.5 h-3.5" />
                          </button>
                        )}
                      </div>
                    )}
                    <div className="flex flex-wrap items-center gap-y-1.5 gap-x-4 mt-1">
                      <p className="text-xs text-slate-500 flex items-center gap-1">
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
                        <div className="flex items-center gap-1.5 text-xs text-slate-500">
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
                                await saveConversation(activeConversation.id, updateData, { merge: true });
                              } catch (err) {
                                console.error('Error assigning group:', err);
                              }
                            }}
                            className="bg-slate-100 hover:bg-slate-200 border border-slate-200/60 rounded px-2 py-0.5 font-semibold text-slate-700 focus:outline-none cursor-pointer text-2xs transition-colors"
                          >
                            <option value="">No Group / Unassigned</option>
                            {sessionGroups.map(g => (
                              <option key={g.id} value={g.id}>{g.name}</option>
                            ))}
                          </select>
                        </div>
                      ) : (
                        (activeGroup || activeConversation.groupId || activeConversation.sharedGroupData) && (
                          <div className="flex items-center gap-1 text-xs text-slate-500">
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

                  <div className="flex flex-wrap items-center gap-2">
                    <button onClick={() => setIsHistoryOpen(true)} disabled={activeConversation.status === 'processing' || isDiarizing}
                      className="btn btn-secondary">
                      <History className="w-4 h-4" /><span>Annotation history</span>
                    </button>
                    <button
                      onClick={() => setIsExportJsonlOpen(true)}
                      className="btn btn-secondary"
                      title="Export annotated dataset (JSONL)"
                    >
                      <FileCode className="w-4 h-4" />
                      <span>Export JSONL</span>
                    </button>

                    <button
                      onClick={() => {
                        setSharedLinkUrl(`${window.location.origin}${window.location.pathname}?session=${activeConversation.id}`);
                        setIsShareModalOpen(true);
                      }}
                      className="btn btn-secondary"
                    >
                      <Share2 className="w-4 h-4" />
                      <span>Session Link</span>
                    </button>
                  </div>
                </div>

                <div className="mt-5 border-t border-slate-100 pt-5 space-y-5">
                  {activeConversation.schemaSnapshot && <div className="text-xs bg-brand-50 border border-brand-200 rounded-lg p-3 space-y-2">
                    <p>This restored session uses its captured schema ({activeConversation.schemaSnapshot.version.slice(7, 19)}), independent of group settings.</p>
                    <button disabled={activeConversation.status === 'processing'} className="underline disabled:opacity-40" onClick={async () => {
                      if (!window.confirm('Switch this working session to the current group/default schema? A checkpoint will preserve the current version first.')) return;
                      try {
                        await createCheckpoint(activeConversation.id, 'Before switching to group/default schema');
                        await saveConversation(activeConversation.id, { schemaSnapshot: null }, { merge: true });
                      } catch (err) { setWarningMessage(err instanceof Error ? err.message : 'Could not switch schema'); }
                    }}>Use current group/default schema</button>
                  </div>}
                  <EncounterTimeEditor key={`encounter-time:${activeConversation.id}`} value={activeConversation.encounterTime}
                    onSave={async encounterTime => { await saveConversation(activeConversation.id, { encounterTime }, { merge: true }); }} />
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
                    key={`transcript:${activeConversation.id}`}
                    rawTranscript={activeConversation.rawTranscript}
                    onTranscriptChange={handleTranscriptChange}
                    onFocusEditor={() => {
                      if (selectedEntityId) setSelectedEntityId(null);
                      if (selectedMentionId) setSelectedMentionId(null);
                    }}
                    onAnnotate={handleAnnotate}
                    onDiarize={handleDiarize}
                    onManualAnnotate={handleManualAnnotate}
                    isDiarizing={isDiarizing}
                    hasAudio={activeConversation.hasAudio}
                    status={annotationRuns[activeConversation.id] ? 'processing' : activeConversation.status}
                    annotationProgress={annotationRuns[activeConversation.id] || activeConversation.annotationProgress}
                    warningMessage={warningMessage}
                    encounterType={activeConversation.encounterType || 'dialogue'}
                    isReadOnly={isReadOnly}
                    isServerReady={serverStatus === 'ready'}
                    onOpenSettings={openSettingsModal}
                    hasApiKey={hasUserConfiguredKeys}
                  />
                </div>
              </div>

              {/* Annotation & Knowledge Graph Dashboard */}
              {activeConversation.status === 'annotated' && activeConversation.annotation && (
                <div className="grid grid-cols-1 xl:grid-cols-12 gap-6">
                  {/* Left Column (Interactive Visualization - 7 Cols) */}
                  <div className="xl:col-span-7 min-w-0 relative">
                    <div className="space-y-6">
                      {/* View Switch tabs */}
                    <div className="panel p-5 flex flex-col gap-4">
                      <div className="annotation-toolbar">
                        <div className="flex items-center gap-3">
                          <h3 className="section-heading">
                            Explore annotations
                          </h3>
                          {activeTab === 'graph' && activeConversation.annotation && (
                            <span className="text-2xs font-medium text-slate-500">
                              ({activeConversation.annotation.entities?.length || 0} entities, {(activeConversation.annotation.relations?.length || 0) + getProcedureRelations(activeConversation.annotation.entities).length} relations)
                            </span>
                          )}
                        </div>
                        <div className="flex flex-wrap items-center gap-2 w-full">
                          <div className="view-switcher" role="group" aria-label="Annotation view">
                            <button
                              onClick={() => setActiveTab('dialogue')}
                              className="view-tab"
                              aria-pressed={activeTab === 'dialogue'}
                            >
                              {activeConversation.encounterType === 'note' ? (
                                <FileText className="w-4 h-4" />
                              ) : (
                                <MessageSquare className="w-4 h-4" />
                              )}
                              <span>{activeConversation.encounterType === 'note' ? 'Document Text' : 'Dialogue'}</span>
                            </button>
                            <button
                              onClick={() => setActiveTab('evidence')}
                              className="view-tab"
                              aria-pressed={activeTab === 'evidence'}
                            >
                              <Network className="w-4 h-4" /> Evidence Graph
                            </button>
                            <button
                              onClick={() => setActiveTab('graph')}
                              className="view-tab"
                              aria-pressed={activeTab === 'graph'}
                            >
                              <Share2 className="w-4 h-4" />
                              <span>Entity Relations</span>
                            </button>
                          </div>
                        </div>
                      </div>

                      {activeTab === 'dialogue' ? (
                        <RawTranscriptView
                          key={activeConversation.id}
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
                          annotationSchema={activeSchema}
                          onSplitUtterance={handleSplitUtterance}
                          onChangeSpeaker={handleChangeSpeaker}
                        />
                      ) : activeTab === 'evidence' ? (
                        <EvidenceGraph
                          sessionId={activeConversation.id}
                          title={activeConversation.title}
                          annotation={activeConversation.annotation}
                          encounterTime={activeConversation.encounterTime}
                          onSelectEvidence={(entityId, mentionId) => {
                            setSelectedEntityId(entityId);
                            setSelectedMentionId(mentionId);
                            setActiveTab('dialogue');
                          }}
                        />
                      ) : (
                        <KnowledgeGraph
                          entities={activeConversation.annotation.entities}
                          relations={activeConversation.annotation.relations || []}
                          mentions={activeConversation.annotation.mentions || []}
                          selectedEntityId={selectedEntityId}
                          onSelectEntity={handleSelectEntity}
                          onGenerateRelations={handleGenerateRelations}
                          isGeneratingRelations={isGeneratingRelations}
                          isReadOnly={isReadOnly}
                        />
                      )}
                    </div>
                  </div>
                  </div>

                  {/* Right Column (Clinical Categorization list - 5 Cols) */}
                  <div className="xl:col-span-5 relative min-w-0 min-h-[400px] xl:min-h-0">
                    <div className="xl:absolute xl:inset-0 overflow-y-auto xl:pr-1 pb-6">
                      <ClinicalNotesView
                        key={activeConversation.id}
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
                        annotationSchema={activeSchema}
                        encounterType={activeConversation.encounterType || 'dialogue'}
                        encounterTime={activeConversation.encounterTime}
                      />
                    </div>
                  </div>
                </div>
              )}
            </div>
          ) : (
            <div className="panel welcome-panel">
              <div className="p-5 bg-brand-50 text-brand-600 rounded-2xl mb-6 border border-brand-100">
                <Network className="w-10 h-10" strokeWidth={1.5} />
              </div>
              <p className="eyebrow mb-3">From conversation to connected evidence</p>
              <h2 className="text-3xl font-semibold tracking-tight text-slate-900">A clearer picture of every encounter.</h2>
              <p className="text-sm text-slate-500 max-w-md mt-4 leading-relaxed">
                Bring your clinical notes and conversations together. Annotate the details, connect the evidence, and explore the relationships.
              </p>
              <button
                onClick={() => {
                  setNewSessionTitle('');
                  setNewSessionType('dialogue');
                  setIsCreateModalOpen(true);
                }}
                className="btn btn-primary mt-7 px-5"
              >
                <Plus className="w-4 h-4" /> Create New Session <ArrowRight className="w-4 h-4 ml-2" />
              </button>
              <div className="welcome-steps">
                {[
                  { icon: FileText, title: '01  Add a source', description: 'Paste a note, upload audio, or record a conversation.' },
                  { icon: Edit2, title: '02  Annotate details', description: 'Mark clinical entities and link them to their evidence.' },
                  { icon: Network, title: '03  Connect the picture', description: 'Explore relationships and export your annotations.' },
                ].map(({ icon: Icon, title, description }) => <div key={title}>
                  <Icon className="w-5 h-5 text-brand-600 mb-3" strokeWidth={1.7} />
                  <h3 className="text-xs font-semibold text-slate-800">{title}</h3>
                  <p className="text-xs text-slate-500 leading-relaxed mt-2">{description}</p>
                </div>)}
              </div>
            </div>
          )}
        </div>
      </main>

      {/* Bottom Status Bar */}
      <footer className="app-footer">
        <div className="flex gap-4">
          <span className="flex items-center gap-1.5">
            <span className={`w-1.5 h-1.5 rounded-full ${
              activeConversation?.status === 'processing' ? 'bg-amber-500 animate-pulse' : serverStatus === 'error' ? 'bg-rose-500' : 'bg-brand-500'
            }`}></span>
            <span>{serverStatus === 'error' ? 'Server offline' : activeConversation?.status === 'processing' ? 'Processing encounter' : storageMode === 'firebase' ? 'Firebase workspace' : 'Local workspace'}</span>
          </span>
        </div>
        <div className="flex gap-4">
           <span>{(activeConversation?.rawTranscript?.length || 0).toLocaleString()} characters</span>
           <span>{activeConversation?.annotation?.entities?.length || 0} entities</span>
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
              className="absolute inset-0 bg-slate-900/40 backdrop-blur-xs"
            />

            {/* Modal Card */}
            <motion.div
              initial={{ scale: 0.95, opacity: 0, y: 15 }}
              animate={{ scale: 1, opacity: 1, y: 0 }}
              exit={{ scale: 0.95, opacity: 0, y: 15 }}
              transition={{ type: 'spring', duration: 0.35 }}
              role="dialog" aria-modal="true" aria-labelledby="new-session-title"
              className="dialog-surface relative bg-white border border-slate-200 max-w-md w-full p-6 space-y-5"
            >
              <div className="flex items-center justify-between pb-3 border-b border-slate-100">
                <div className="flex items-center gap-2">
                  <Sparkles className="w-4.5 h-4.5 text-brand-600" />
                  <h3 id="new-session-title" className="text-base font-semibold text-slate-800">New Clinical Session</h3>
                </div>
                <button
                  onClick={() => setIsCreateModalOpen(false)}
                  className="icon-button" aria-label="Close new session"
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
                    className="w-full text-xs border border-slate-200 rounded-lg px-3 py-2 bg-white focus:outline-none focus:ring-1 focus:ring-brand-500 focus:border-brand-500"
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
                      aria-pressed={newSessionType === 'dialogue'}
                      className={`text-left border p-3.5 rounded-xl transition-all flex items-start gap-3 cursor-pointer ${
                        newSessionType === 'dialogue'
                          ? 'border-brand-600 bg-brand-50/20 shadow-sm'
                          : 'border-slate-100 hover:border-slate-200 bg-white'
                      }`}
                    >
                      <div className={`p-2 rounded-lg shrink-0 ${
                        newSessionType === 'dialogue' ? 'bg-brand-100 text-brand-600' : 'bg-slate-50 text-slate-500'
                      }`}>
                        <MessageSquare className="w-4 h-4" />
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-1.5">
                          <span className="text-xs font-semibold text-slate-800">Diarized Audio / Dialogue</span>
                          {newSessionType === 'dialogue' && (
                            <Check className="w-3.5 h-3.5 text-brand-600 shrink-0" />
                          )}
                        </div>
                        <p className="text-2xs text-slate-500 mt-1 leading-normal">
                          For verbal encounters (patient & clinician discussions). Supports recording or uploading medical audio and extracting transcripts.
                        </p>
                      </div>
                    </button>

                    {/* Option 2: Note */}
                    <button
                      type="button"
                      onClick={() => setNewSessionType('note')}
                      aria-pressed={newSessionType === 'note'}
                      className={`text-left border p-3.5 rounded-xl transition-all flex items-start gap-3 cursor-pointer ${
                        newSessionType === 'note'
                          ? 'border-brand-600 bg-brand-50/20 shadow-sm'
                          : 'border-slate-100 hover:border-slate-200 bg-white'
                      }`}
                    >
                      <div className={`p-2 rounded-lg shrink-0 ${
                        newSessionType === 'note' ? 'bg-brand-100 text-brand-600' : 'bg-slate-50 text-slate-500'
                      }`}>
                        <FileText className="w-4 h-4" />
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-1.5">
                          <span className="text-xs font-semibold text-slate-800">Clinical Note / Unstructured Document</span>
                          {newSessionType === 'note' && (
                            <Check className="w-3.5 h-3.5 text-brand-600 shrink-0" />
                          )}
                        </div>
                        <p className="text-2xs text-slate-500 mt-1 leading-normal">
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
                  className="btn btn-secondary"
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
                  className="btn btn-primary"
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
              className="absolute inset-0 bg-slate-900/40 backdrop-blur-xs"
            />

            {/* Modal Card */}
            <motion.div
              initial={{ scale: 0.95, opacity: 0, y: 15 }}
              animate={{ scale: 1, opacity: 1, y: 0 }}
              exit={{ scale: 0.95, opacity: 0, y: 15 }}
              transition={{ type: 'spring', duration: 0.35 }}
              role="dialog" aria-modal="true" aria-labelledby="session-link-title"
              className="dialog-surface relative bg-white border border-slate-200 max-w-md w-full p-6 space-y-4 text-left"
            >
              <div className="flex items-center justify-between pb-3 border-b border-slate-100">
                <div className="flex items-center gap-2">
                  <Share2 className="w-4.5 h-4.5 text-brand-600" />
                  <h3 id="session-link-title" className="text-base font-semibold text-slate-800">{storageMode === 'firebase' ? 'Session Link' : 'Local Session Link'}</h3>
                </div>
                <button
                  onClick={() => setIsShareModalOpen(false)}
                  className="icon-button" aria-label="Close session link"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>

              <div className="space-y-3">
                <p className="text-xs text-slate-500 leading-relaxed font-sans">
                  {storageMode === 'firebase'
                    ? 'This link opens the session when you are signed in to your account.'
                    : 'This link reopens the session on this computer while ClinGraph is running. To transfer annotations to another computer, use Export JSONL.'}
                </p>

                <div className="flex items-center gap-2 bg-slate-50 border border-slate-200/80 rounded-xl p-2 min-w-0">
                  <input
                    type="text"
                    readOnly
                    value={sharedLinkUrl}
                    className="flex-1 text-2xs font-mono bg-transparent outline-none text-slate-600 select-all min-w-0"
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
                        <span className="text-emerald-600 text-2xs">Copied!</span>
                      </>
                    ) : (
                      <>
                        <Copy className="w-3.5 h-3.5" />
                        <span className="text-2xs">Copy Link</span>
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
              className="absolute inset-0 bg-slate-900/40 backdrop-blur-xs"
            />

            {/* Modal Card */}
            <motion.div
              initial={{ scale: 0.95, opacity: 0, y: 15 }}
              animate={{ scale: 1, opacity: 1, y: 0 }}
              exit={{ scale: 0.95, opacity: 0, y: 15 }}
              transition={{ type: 'spring', duration: 0.35 }}
              role="dialog" aria-modal="true" aria-labelledby="ai-settings-title"
              className="dialog-surface relative bg-white border border-slate-200 max-w-2xl w-full p-6 space-y-4 text-left flex flex-col"
            >
              <div className="flex items-center justify-between gap-3 pb-4 border-b border-slate-100 shrink-0">
                <div className="flex items-center gap-2">
                  <Settings2 className="w-5 h-5 text-brand-600 shrink-0" />
                  <div>
                    <h3 id="ai-settings-title" className="text-base font-semibold text-slate-900">AI Settings</h3>
                    <p className="text-xs text-slate-500 mt-1">Connect a model for transcription and clinical annotation.</p>
                  </div>
                </div>
                <button
                  onClick={() => setIsSettingsOpen(false)}
                  className="icon-button" aria-label="Close AI settings"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>

              <div className="space-y-4 min-h-0 max-h-[60dvh] overflow-y-auto pr-1">
                {/* Information Callout Banner */}
                <div className="p-3.5 bg-brand-50/80 border border-brand-200/70 rounded-xl text-xs text-brand-900 space-y-1.5">
                  <div className="flex items-center gap-1.5 font-semibold text-brand-950">
                    <Info className="w-4 h-4 text-brand-600 shrink-0" />
                    <span>Your model, your API key</span>
                  </div>
                  <p className="text-xs text-brand-800 leading-relaxed">
                    Configure Gemini or an OpenAI-compatible endpoint for optional AI features. Settings and keys are saved {storageMode === 'firebase' ? 'privately to your account' : 'in your local database'}. The selected provider receives the text or audio you submit for processing.
                  </p>
                  <div className="pt-0.5 flex flex-wrap items-center gap-3 text-2xs">
                    <a
                      href="https://aistudio.google.com/apikey"
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-1 text-brand-700 hover:text-brand-900 font-semibold underline decoration-brand-300"
                    >
                      <span>Get a free Gemini API key from Google AI Studio</span>
                      <ExternalLink className="w-3 h-3" />
                    </a>
                  </div>
                </div>

                {/* Quick 1-click key sync helper */}
                {((localConfig.annotation.apiKey && !localConfig.transcription.apiKey) ||
                  (localConfig.transcription.apiKey && !localConfig.annotation.apiKey) ||
                  (localConfig.annotation.apiKey && localConfig.transcription.apiKey && localConfig.annotation.apiKey !== localConfig.transcription.apiKey)) && (
                  <div className="flex items-center justify-between p-2.5 bg-slate-50 border border-slate-200/80 rounded-xl text-xs">
                    <span className="text-2xs text-slate-600 font-medium">Have a single Gemini key for both?</span>
                    <button
                      type="button"
                      onClick={() => {
                        const keyToCopy = localConfig.annotation.apiKey || localConfig.transcription.apiKey;
                        setLocalConfig({
                          ...localConfig,
                          transcription: { ...localConfig.transcription, apiKey: keyToCopy },
                          annotation: { ...localConfig.annotation, apiKey: keyToCopy }
                        });
                      }}
                      className="px-2.5 py-1 bg-white hover:bg-brand-50 text-brand-700 border border-brand-200 rounded-lg font-semibold text-2xs flex items-center gap-1 cursor-pointer transition-colors shadow-2xs"
                    >
                      <Copy className="w-3 h-3 text-brand-600" />
                      <span>Sync Key to Both</span>
                    </button>
                  </div>
                )}

                {/* Section 1: Speech Transcription */}
                <div className="p-4 bg-slate-50/50 border border-slate-200 rounded-lg space-y-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="section-heading">Audio transcription</span>
                    <span className="text-2xs text-brand-600 font-medium bg-brand-50 px-2 py-0.5 rounded-full border border-brand-100">Speech-to-Text</span>
                  </div>
                  <p className="text-2xs text-slate-500 leading-normal">
                    Specify the model used when you record clinical dialogues or upload raw files.
                  </p>

                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3.5">
                    <div>
                      <label className="block text-2xs font-semibold text-slate-500 mb-1">Provider</label>
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
                        className="w-full h-9 bg-white border border-slate-200 rounded-lg px-2.5 text-xs text-slate-700 focus:border-brand-500 outline-none transition-all cursor-pointer font-medium"
                      >
                        <option value="gemini">Google Gemini (Standard)</option>
                        <option value="openai">OpenAI / Custom API (Whisper)</option>
                      </select>
                    </div>

                    <div>
                      <label className="block text-2xs font-semibold text-slate-500 mb-1">Model Name</label>
                      <input
                        type="text"
                        value={localConfig.transcription.model}
                        onChange={(e) => setLocalConfig({
                          ...localConfig,
                          transcription: { ...localConfig.transcription, model: e.target.value }
                        })}
                        placeholder={localConfig.transcription.provider === 'gemini' ? 'gemini-3.1-flash-lite' : 'whisper-1'}
                        className="w-full h-9 bg-white border border-slate-200 rounded-lg px-2.5 text-xs text-slate-700 focus:border-brand-500 outline-none transition-all font-medium"
                      />
                    </div>
                  </div>

                  {localConfig.transcription.provider === 'openai' && (
                    <div className="space-y-3 pt-1">
                      <div>
                        <label className="block text-2xs font-semibold text-slate-500 mb-1">API Base URL</label>
                        <input
                          type="text"
                          value={localConfig.transcription.baseUrl}
                          onChange={(e) => setLocalConfig({
                            ...localConfig,
                            transcription: { ...localConfig.transcription, baseUrl: e.target.value }
                          })}
                          placeholder="https://api.openai.com/v1"
                          className="w-full h-9 bg-white border border-slate-200 rounded-lg px-2.5 text-xs text-slate-600 font-mono outline-none focus:border-brand-500 transition-all"
                        />
                      </div>
                    </div>
                  )}

                  <div>
                    <label className="block text-2xs font-semibold text-slate-700 mb-1">
                      {localConfig.transcription.provider === 'gemini' ? 'Gemini API Key' : 'OpenAI / Custom API Key'}
                      <span className="font-normal text-slate-500 ml-1.5 text-2xs">
                        {localConfig.transcription.provider === 'gemini' ? '(Or set GEMINI_API_KEY in .env)' : '(Optional for local endpoints)'}
                      </span>
                    </label>
                    <input
                      type="password"
                      value={localConfig.transcription.apiKey || ''}
                      onChange={(e) => setLocalConfig({
                        ...localConfig,
                        transcription: { ...localConfig.transcription, apiKey: e.target.value }
                      })}
                      placeholder={localConfig.transcription.provider === 'gemini' ? 'AIzaSy...' : 'sk-...'}
                      className="w-full h-9 bg-white border border-slate-200 rounded-lg px-2.5 text-xs text-slate-700 font-mono outline-none focus:border-brand-500 transition-all"
                    />
                  </div>
                </div>

                {/* Section 2: Clinical Annotation */}
                <div className="p-4 bg-slate-50/50 border border-slate-200 rounded-lg space-y-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="section-heading">Clinical annotation</span>
                    <span className="text-2xs text-brand-600 font-medium bg-brand-50 px-2 py-0.5 rounded-full border border-brand-100">Reasoning LLM</span>
                  </div>
                  <p className="text-2xs text-slate-500 leading-normal">
                    Specify the model used to extract clinical entities, SNOMED/RxNorm/ICD-10 nodes, and construct knowledge graphs.
                  </p>

                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3.5">
                    <div>
                      <label className="block text-2xs font-semibold text-slate-500 mb-1">Provider</label>
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
                        className="w-full h-9 bg-white border border-slate-200 rounded-lg px-2.5 text-xs text-slate-700 focus:border-brand-500 outline-none transition-all cursor-pointer font-medium"
                      >
                        <option value="gemini">Google Gemini (Standard)</option>
                        <option value="openai">OpenAI / Custom API (GPT-4o/Llama)</option>
                      </select>
                    </div>

                    <div>
                      <label className="block text-2xs font-semibold text-slate-500 mb-1">Model Name</label>
                      <input
                        type="text"
                        value={localConfig.annotation.model}
                        onChange={(e) => setLocalConfig({
                          ...localConfig,
                          annotation: { ...localConfig.annotation, model: e.target.value }
                        })}
                        placeholder={localConfig.annotation.provider === 'gemini' ? 'gemini-3.1-flash-lite' : 'gpt-4o'}
                        className="w-full h-9 bg-white border border-slate-200 rounded-lg px-2.5 text-xs text-slate-700 focus:border-brand-500 outline-none transition-all font-medium"
                      />
                    </div>
                  </div>

                  <div className="rounded-lg border border-slate-200 bg-white p-3 space-y-2">
                    <div className="flex items-center justify-between gap-3">
                      <label htmlFor="annotation-concurrency" className="text-xs font-semibold text-slate-700">Parallel utterances</label>
                      <input
                        id="annotation-concurrency"
                        type="number"
                        min={1}
                        max={MAX_ANNOTATION_CONCURRENCY}
                        step={1}
                        value={localConfig.annotation.concurrency}
                        aria-invalid={!annotationConcurrencyValid}
                        aria-describedby={`annotation-concurrency-help${annotationConcurrencyValid ? '' : ' annotation-concurrency-error'}`}
                        onChange={event => setLocalConfig({ ...localConfig, annotation: {
                          ...localConfig.annotation, concurrency: event.target.value === '' ? '' : Number(event.target.value)
                        } })}
                        className="h-9 w-20 shrink-0 rounded-lg border border-slate-200 px-2.5 text-xs text-slate-700 outline-none focus:border-brand-500"
                      />
                    </div>
                    <p id="annotation-concurrency-help" className="text-2xs text-slate-500 leading-normal">
                      Utterances processed at once (1–32). Higher values may reach your provider’s rate limits. Changes apply to new annotation runs.
                    </p>
                    {!annotationConcurrencyValid && <p id="annotation-concurrency-error" role="alert" className="text-xs text-rose-700">{ANNOTATION_CONCURRENCY_ERROR}</p>}
                  </div>

                  {localConfig.annotation.provider === 'openai' && (
                    <div className="space-y-3 pt-1">
                      <div>
                        <label className="block text-2xs font-semibold text-slate-500 mb-1">API Base URL</label>
                        <input
                          type="text"
                          value={localConfig.annotation.baseUrl}
                          onChange={(e) => setLocalConfig({
                            ...localConfig,
                            annotation: { ...localConfig.annotation, baseUrl: e.target.value }
                          })}
                          placeholder="https://api.openai.com/v1"
                          className="w-full h-9 bg-white border border-slate-200 rounded-lg px-2.5 text-xs text-slate-600 font-mono outline-none focus:border-brand-500 transition-all"
                        />
                      </div>
                    </div>
                  )}

                  <div>
                    <label className="block text-2xs font-semibold text-slate-700 mb-1">
                      {localConfig.annotation.provider === 'gemini' ? 'Gemini API Key' : 'OpenAI / Custom API Key'}
                      <span className="font-normal text-slate-500 ml-1.5 text-2xs">
                        {localConfig.annotation.provider === 'gemini' ? '(Or set GEMINI_API_KEY in .env)' : '(Optional for local endpoints)'}
                      </span>
                    </label>
                    <input
                      type="password"
                      value={localConfig.annotation.apiKey || ''}
                      onChange={(e) => setLocalConfig({
                        ...localConfig,
                        annotation: { ...localConfig.annotation, apiKey: e.target.value }
                      })}
                      placeholder={localConfig.annotation.provider === 'gemini' ? 'AIzaSy...' : 'sk-...'}
                      className="w-full h-9 bg-white border border-slate-200 rounded-lg px-2.5 text-xs text-slate-700 font-mono outline-none focus:border-brand-500 transition-all"
                    />
                  </div>
                </div>
              </div>

              {settingsSaveError && <p role="alert" className="text-xs text-rose-700">{settingsSaveError}</p>}
              <div className="flex flex-wrap items-center justify-between gap-3 pt-4 border-t border-slate-100 shrink-0">
                <div className="text-2xs">
                  {(localConfig.annotation?.apiKey || localConfig.transcription?.apiKey) ? (
                    <span className="text-emerald-700 font-semibold flex items-center gap-1">
                      <Check className="w-3.5 h-3.5" />
                      <span>Custom API key configured</span>
                    </span>
                  ) : (
                    <span className="text-slate-500 font-medium">
                      No keys set — manual annotation is available
                    </span>
                  )}
                </div>
                <div className="flex items-center gap-2 ml-auto">
                  <button
                    type="button"
                    onClick={() => setIsSettingsOpen(false)}
                    className="btn btn-secondary"
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    onClick={handleSaveSettings}
                    disabled={!annotationConcurrencyValid}
                    className="btn btn-primary"
                  >
                    <Check className="w-4 h-4" />
                    <span>Save Configuration</span>
                  </button>
                </div>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      {isHistoryOpen && activeConversation && <AnnotationHistory key={activeConversation.id}
        conversation={activeConversation} onClose={() => setIsHistoryOpen(false)}
        listCheckpoints={listCheckpoints} getCheckpoint={getCheckpoint} createCheckpoint={createCheckpoint} restoreCheckpoint={restoreCheckpoint}
        onRestored={restored => {
          setIsHistoryOpen(false); setSelectedEntityId(null); setSelectedMentionId(null);
          setActiveGroupId(restored.groupId || null); setActiveId(restored.id); setActiveTab('dialogue');
        }} />}

      <ExportJsonlModal
        isOpen={isExportJsonlOpen}
        onClose={() => setIsExportJsonlOpen(false)}
        session={activeConversation}
        entities={activeConversation?.annotation?.entities || []}
        mentions={activeConversation?.annotation?.mentions || []}
        relations={activeConversation?.annotation?.relations || []}
        clinicalNotes={activeConversation?.annotation?.clinicalNotes}
      />
    </div>
  );
}
