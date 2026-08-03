import { useState } from 'react';
import { Conversation, SessionGroup, AnnotationCategory, AnnotationAttribute, DEFAULT_ANNOTATION_SCHEMA, FHIR_ANNOTATION_SCHEMA, normalizeAnnotationSchema } from '../types';
import {
  Search,
  Calendar,
  FolderOpen,
  AlertCircle,
  Plus,
  Trash2,
  Tag,
  ChevronDown,
  ChevronRight,
  Folder,
  FolderPlus,
  Settings,
  X,
  Sliders,
  CheckCircle2,
  RefreshCw,
  PlusCircle,
  Wrench,
  Layers,
  ShieldCheck,
  Activity
} from 'lucide-react';

interface ConversationListProps {
  conversations: Conversation[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onDelete: (id: string) => void;
  onCreateNew: (groupId?: string) => void;
  sessionGroups: SessionGroup[];
  activeGroupId: string | null;
  onSelectGroup: (groupId: string | null) => void;
  onCreateGroup: (name: string) => Promise<void>;
  onUpdateGroup: (id: string, name: string, settings: any) => Promise<void>;
  onDeleteGroup: (id: string) => Promise<void>;
}

export default function ConversationList({
  conversations,
  selectedId,
  onSelect,
  onDelete,
  onCreateNew,
  sessionGroups,
  activeGroupId,
  onSelectGroup,
  onCreateGroup,
  onUpdateGroup,
  onDeleteGroup
}: ConversationListProps) {
  const [searchQuery, setSearchQuery] = useState('');
  const [isGroupsExpanded, setIsGroupsExpanded] = useState(true);
  const [isCreatingGroup, setIsCreatingGroup] = useState(false);
  const [newGroupName, setNewGroupName] = useState('');
  const [editingGroupName, setEditingGroupName] = useState('');
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [selectedGroupForSettings, setSelectedGroupForSettings] = useState<SessionGroup | null>(null);
  const [activeSettingsTab, setActiveSettingsTab] = useState<'general' | 'schema'>('general');
  const [newCatName, setNewCatName] = useState('');
  const [newCatEntityType, setNewCatEntityType] = useState('Other');
  const [newCatTypeHint, setNewCatTypeHint] = useState('');
  const [newAttrState, setNewAttrState] = useState<Record<string, { name: string, type: 'text' | 'select' | 'boolean', choices: string, hint: string }>>({});

  // Filter conversations based on active group
  const filteredByGroup = conversations.filter(conv => {
    if (activeGroupId === 'ungrouped') {
      return !conv.groupId;
    }
    if (activeGroupId) {
      return conv.groupId === activeGroupId;
    }
    return true; // null means 'All'
  });

  // Filter conversations based on search
  const filtered = filteredByGroup.filter(conv => {
    const query = searchQuery.toLowerCase();
    
    const titleMatch = conv.title.toLowerCase().includes(query);
    const transcriptMatch = conv.rawTranscript.toLowerCase().includes(query);
    
    // Check if any clinical note field value matches the query dynamically
    let clinicalNotesMatch = false;
    if (conv.annotation?.clinicalNotes) {
      clinicalNotesMatch = Object.values(conv.annotation.clinicalNotes).some(categoryItems => {
        if (!Array.isArray(categoryItems)) return false;
        return categoryItems.some((item: any) => {
          if (!item || typeof item !== 'object') return false;
          return Object.entries(item).some(([key, val]) => {
            if (key === 'entityId') return false; // skip internal IDs
            return typeof val === 'string' && val.toLowerCase().includes(query);
          });
        });
      });
    }

    return titleMatch || transcriptMatch || clinicalNotesMatch;
  });

  const formatDate = (isoString: string) => {
    try {
      const date = new Date(isoString);
      return date.toLocaleDateString('en-US', {
        month: 'short',
        day: 'numeric',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit'
      });
    } catch {
      return isoString;
    }
  };

  return (
    <div className="bg-white border border-slate-200 rounded-2xl p-4 flex flex-col h-full max-h-[850px] shadow-sm select-none">
      {/* List Header */}
      <div className="flex items-center justify-between pb-4 mb-3 border-b border-slate-100">
        <div className="flex items-center gap-2">
          <FolderOpen className="w-4 h-4 text-blue-500" />
          <h3 className="text-sm font-semibold text-slate-800">Clinical Workspace</h3>
        </div>
        <button
          onClick={() => onCreateNew(activeGroupId && activeGroupId !== 'ungrouped' ? activeGroupId : undefined)}
          className="flex items-center gap-1 text-[11px] font-semibold text-blue-600 hover:text-blue-700 bg-blue-50/50 px-2.5 py-1.5 rounded-lg transition-all cursor-pointer"
        >
          <Plus className="w-3.5 h-3.5" /> New Session
        </button>
      </div>

      {/* Groups / Folders Section */}
      <div className="mb-4 pb-3 border-b border-slate-100">
        <div className="flex items-center justify-between mb-2">
          <button 
            type="button"
            onClick={() => setIsGroupsExpanded(!isGroupsExpanded)}
            className="flex items-center gap-1.5 text-xs font-bold uppercase tracking-wider text-slate-400 font-mono hover:text-slate-600 transition-colors cursor-pointer"
          >
            {isGroupsExpanded ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
            <span>Session Groups</span>
          </button>
          <button
            type="button"
            onClick={() => setIsCreatingGroup(true)}
            className="p-1 hover:bg-slate-100 text-slate-400 hover:text-blue-600 rounded transition-colors cursor-pointer"
            title="Create New Group"
          >
            <FolderPlus className="w-3.5 h-3.5" />
          </button>
        </div>

        {isGroupsExpanded && (
          <div className="space-y-1 pl-1 max-h-[180px] overflow-y-auto pr-1">
            {/* All Sessions */}
            <button
              type="button"
              onClick={() => onSelectGroup(null)}
              className={`w-full flex items-center justify-between px-2.5 py-1.5 rounded-lg text-xs font-medium transition-all cursor-pointer ${
                activeGroupId === null
                  ? 'bg-blue-50 text-blue-700 font-semibold border-l-2 border-l-blue-600'
                  : 'text-slate-600 hover:bg-slate-50'
              }`}
            >
              <div className="flex items-center gap-2">
                <FolderOpen className="w-3.5 h-3.5 text-blue-500" />
                <span>All Sessions</span>
              </div>
              <span className="text-[10px] text-slate-400 font-mono">{conversations.length}</span>
            </button>

            {/* Ungrouped */}
            <button
              type="button"
              onClick={() => onSelectGroup('ungrouped')}
              className={`w-full flex items-center justify-between px-2.5 py-1.5 rounded-lg text-xs font-medium transition-all cursor-pointer ${
                activeGroupId === 'ungrouped'
                  ? 'bg-blue-50 text-blue-700 font-semibold border-l-2 border-l-blue-600'
                  : 'text-slate-600 hover:bg-slate-50'
              }`}
            >
              <div className="flex items-center gap-2">
                <FolderOpen className="w-3.5 h-3.5 text-slate-400" />
                <span>Unassigned</span>
              </div>
              <span className="text-[10px] text-slate-400 font-mono">
                {conversations.filter(c => !c.groupId).length}
              </span>
            </button>

            {/* User Custom Groups */}
            {sessionGroups.map(group => {
              const isSelected = activeGroupId === group.id;
              const groupSessionsCount = conversations.filter(c => c.groupId === group.id).length;
              
              return (
                <div
                  key={group.id}
                  className={`w-full flex items-center justify-between px-2.5 py-1.5 rounded-lg text-xs font-medium transition-all relative group/group-item ${
                    isSelected
                      ? 'bg-blue-50 text-blue-700 font-semibold border-l-2 border-l-blue-600'
                      : 'text-slate-600 hover:bg-slate-50'
                  }`}
                >
                  <button
                    type="button"
                    onClick={() => onSelectGroup(group.id)}
                    className="flex-1 text-left flex items-center gap-2 min-w-0 cursor-pointer"
                  >
                    <Folder className={`w-3.5 h-3.5 shrink-0 ${isSelected ? 'text-blue-500' : 'text-amber-500'}`} />
                    <span className="truncate pr-4">{group.name}</span>
                  </button>

                  <div className="flex items-center gap-1 shrink-0">
                    <span className="text-[10px] text-slate-400 font-mono group-hover/group-item:hidden">
                      {groupSessionsCount}
                    </span>
                    <div className="hidden group-hover/group-item:flex items-center gap-1">
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          setSelectedGroupForSettings(group);
                          setEditingGroupName(group.name);
                          setIsSettingsOpen(true);
                        }}
                        className="p-0.5 hover:bg-slate-200 rounded text-slate-500 hover:text-slate-800 transition-colors cursor-pointer"
                        title="Group Settings"
                      >
                        <Settings className="w-3 h-3" />
                      </button>
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          onDeleteGroup(group.id);
                        }}
                        className="p-0.5 hover:bg-rose-100 rounded text-slate-400 hover:text-rose-600 transition-colors cursor-pointer"
                        title="Delete Group"
                      >
                        <Trash2 className="w-3 h-3" />
                      </button>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {/* Create Group Form Inline */}
        {isCreatingGroup && (
          <div className="bg-slate-50/50 p-2 border border-slate-100 rounded-lg space-y-2 mt-1">
            <input
              type="text"
              placeholder="Group name..."
              value={newGroupName}
              onChange={(e) => setNewGroupName(e.target.value)}
              className="w-full text-xs border border-slate-200 rounded px-2 py-1 bg-white focus:ring-1 focus:ring-blue-500 focus:outline-none"
              autoFocus
            />
            <div className="flex justify-end gap-1.5">
              <button
                type="button"
                onClick={() => {
                  setIsCreatingGroup(false);
                  setNewGroupName('');
                }}
                className="px-2 py-0.5 text-[10px] font-semibold text-slate-500 hover:bg-slate-200 rounded cursor-pointer"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={async () => {
                  if (newGroupName.trim()) {
                    await onCreateGroup(newGroupName.trim());
                    setNewGroupName('');
                    setIsCreatingGroup(false);
                  }
                }}
                className="px-2.5 py-0.5 text-[10px] font-semibold text-white bg-blue-600 hover:bg-blue-700 rounded cursor-pointer"
              >
                Create
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Search Input */}
      <div className="relative mb-3">
        <Search className="w-3.5 h-3.5 text-slate-400 absolute left-3 top-2.5" />
        <input
          type="text"
          placeholder="Search within this view..."
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          className="w-full text-xs border border-slate-200 rounded-lg pl-8 pr-3.5 py-1.5 focus:outline-none focus:ring-1 focus:ring-blue-500 focus:border-blue-500 bg-white"
        />
      </div>

      {/* Active Group Filter Banner */}
      {activeGroupId && (
        <div className="flex items-center justify-between bg-slate-50 border border-slate-200/50 px-2.5 py-1.5 rounded-lg mb-3 text-[10px] font-medium text-slate-600">
          <span className="truncate">
            Showing: <strong>{activeGroupId === 'ungrouped' ? 'Unassigned' : sessionGroups.find(g => g.id === activeGroupId)?.name || 'Filtered Group'}</strong>
          </span>
          <button
            type="button"
            onClick={() => onSelectGroup(null)}
            className="text-slate-400 hover:text-slate-600 p-0.5"
            title="Clear group filter"
          >
            <X className="w-3 h-3" />
          </button>
        </div>
      )}

      {/* Session List */}
      <div className="flex-1 overflow-y-auto space-y-2 pr-1 select-none">
        {filtered.length === 0 ? (
          <div className="text-center py-10">
            <AlertCircle className="w-6 h-6 text-slate-300 mx-auto mb-2" />
            <p className="text-xs text-slate-400 italic">No clinical sessions found.</p>
          </div>
        ) : (
          filtered.map(conv => {
            const isSelected = conv.id === selectedId;
            const entityCount = conv.annotation?.entities.length || 0;
            const groupName = sessionGroups.find(g => g.id === conv.groupId)?.name;

            return (
              <div
                key={conv.id}
                onClick={() => onSelect(conv.id)}
                className={`border rounded-lg p-3.5 transition-all cursor-pointer relative group ${
                  isSelected
                    ? 'border-l-4 border-l-blue-600 border-y-slate-200 border-r-slate-200 bg-slate-50/80 shadow-sm'
                    : 'border-slate-100 hover:border-slate-200 hover:bg-slate-50/50 bg-white'
                }`}
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <h4 className="text-xs font-semibold text-slate-700 truncate pr-4">
                      {conv.title || 'Untitled Clinical Session'}
                    </h4>
                    
                    <div className="flex items-center gap-1.5 text-[10px] text-slate-400 mt-1">
                      <Calendar className="w-3 h-3" />
                      <span>{formatDate(conv.createdAt)}</span>
                    </div>

                    {/* Metadata tags */}
                    <div className="flex flex-wrap items-center gap-1.5 mt-2">
                      <span className={`text-[8.5px] font-bold px-1.5 py-0.5 rounded uppercase border ${
                        conv.encounterType === 'note'
                          ? 'bg-indigo-50 text-indigo-600 border-indigo-100/50'
                          : 'bg-blue-50 text-blue-600 border-blue-100/50'
                      }`}>
                        {conv.encounterType === 'note' ? 'Note' : 'Dialogue'}
                      </span>

                      <span className={`text-[8.5px] font-bold px-1.5 py-0.5 rounded uppercase ${
                        conv.status === 'annotated' ? 'bg-green-50 text-green-600' :
                        conv.status === 'processing' ? 'bg-amber-50 text-amber-600' :
                        conv.status === 'failed' ? 'bg-rose-50 text-rose-600' : 'bg-slate-50 text-slate-500'
                      }`}>
                        {conv.status}
                      </span>

                      {groupName && (
                        <span className="flex items-center gap-0.5 text-[8.5px] font-bold px-1.5 py-0.5 rounded bg-amber-50 text-amber-700 border border-amber-100/40">
                          <Folder className="w-2.5 h-2.5" />
                          {groupName}
                        </span>
                      )}

                      {entityCount > 0 && (
                        <span className="flex items-center gap-0.5 text-[9px] font-medium text-blue-600 bg-blue-50/50 px-1.5 py-0.5 rounded">
                          <Tag className="w-2.5 h-2.5" />
                          {entityCount} {entityCount === 1 ? 'entity' : 'entities'}
                        </span>
                      )}
                    </div>
                  </div>

                  {/* Actions (Delete icon) */}
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      onDelete(conv.id);
                    }}
                    className="p-1.5 text-slate-400 hover:text-rose-500 rounded bg-transparent opacity-0 group-hover:opacity-100 hover:bg-slate-100/50 transition-all cursor-pointer absolute top-3 right-3"
                    title="Delete Session"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>
            );
          })
        )}
      </div>

      {/* Group Settings Modal */}
      {isSettingsOpen && selectedGroupForSettings && (() => {
        const settings = selectedGroupForSettings.settings || {};
        const schema = normalizeAnnotationSchema(settings.annotationSchema || DEFAULT_ANNOTATION_SCHEMA);

        const updateSchema = (newSchema: AnnotationCategory[]) => {
          setSelectedGroupForSettings({
            ...selectedGroupForSettings,
            settings: {
              ...(selectedGroupForSettings.settings || {}),
              annotationSchema: normalizeAnnotationSchema(newSchema)
            }
          });
        };

        const handleResetSchema = () => {
          updateSchema(DEFAULT_ANNOTATION_SCHEMA);
        };

        const handleAddCategory = () => {
          if (!newCatName.trim()) return;
          const catId = `cat_${Date.now()}`;
          const newCat: AnnotationCategory = {
            id: catId,
            entityType: newCatEntityType,
            displayName: newCatName.trim(),
            typeHint: newCatTypeHint.trim() || undefined,
            attributes: [
              { name: 'name', type: 'text', hint: 'The name of the matched entity' }
            ]
          };
          updateSchema([...schema, newCat]);
          setNewCatName('');
          setNewCatTypeHint('');
        };

        const standardMissing = DEFAULT_ANNOTATION_SCHEMA.filter(
          def => !schema.some(s => s.id === def.id || s.displayName.toLowerCase() === def.displayName.toLowerCase())
        );

        const handleAddStandardCategory = (defCatId: string) => {
          const found = DEFAULT_ANNOTATION_SCHEMA.find(def => def.id === defCatId);
          if (found) {
            updateSchema([...schema, found]);
          }
        };

        const handleDeleteCategory = (catId: string) => {
          updateSchema(schema.filter(c => c.id !== catId));
        };

        const handleAddAttribute = (catId: string) => {
          const attrForm = newAttrState[catId] || { name: '', type: 'text', choices: '', hint: '' };
          if (!attrForm.name.trim()) return;
          const cleanChoices = attrForm.choices
            ? attrForm.choices.split(',').map(c => c.trim()).filter(Boolean)
            : undefined;
          const newAttr: AnnotationAttribute = {
            name: attrForm.name.trim().toLowerCase().replace(/[^a-z0-9]/gi, '_'),
            type: attrForm.type,
            choices: cleanChoices,
            hint: attrForm.hint.trim() || undefined
          };
          
          const updated = schema.map(cat => {
            if (cat.id === catId) {
              return {
                ...cat,
                attributes: [...cat.attributes, newAttr]
              };
            }
            return cat;
          });
          updateSchema(updated);
          
          setNewAttrState(prev => ({
            ...prev,
            [catId]: { name: '', type: 'text', choices: '', hint: '' }
          }));
        };

        const handleDeleteAttribute = (catId: string, attrName: string) => {
          const updated = schema.map(cat => {
            if (cat.id === catId) {
              return {
                ...cat,
                attributes: cat.attributes.filter(a => a.name !== attrName)
              };
            }
            return cat;
          });
          updateSchema(updated);
        };

        return (
          <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
            {/* Backdrop */}
            <div
              onClick={() => {
                setIsSettingsOpen(false);
                setEditingGroupName('');
                setActiveSettingsTab('general');
              }}
              className="absolute inset-0 bg-slate-900/45 backdrop-blur-xs"
            />

            {/* Modal Card */}
            <div className="relative bg-white rounded-2xl shadow-xl border border-slate-100 max-w-3xl w-full p-6 space-y-4 overflow-hidden text-left z-50 max-h-[90vh] flex flex-col">
              <div className="flex items-center justify-between pb-2 border-b border-slate-100 shrink-0">
                <div className="flex items-center gap-2">
                  <Settings className="w-4.5 h-4.5 text-blue-600" />
                  <h3 className="text-sm font-semibold text-slate-800">
                    Project Group: <span className="text-blue-600 font-mono font-bold">{selectedGroupForSettings.name}</span>
                  </h3>
                </div>
                <button
                  type="button"
                  onClick={() => {
                    setIsSettingsOpen(false);
                    setEditingGroupName('');
                    setActiveSettingsTab('general');
                  }}
                  className="text-slate-400 hover:text-slate-600 transition-colors p-1 rounded-lg hover:bg-slate-50 cursor-pointer"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>

              {/* Tab Switcher */}
              <div className="flex bg-slate-100 p-1 rounded-xl shrink-0 gap-1 w-fit">
                <button
                  type="button"
                  onClick={() => setActiveSettingsTab('general')}
                  className={`flex items-center gap-1.5 text-xs font-semibold px-4 py-1.5 rounded-lg cursor-pointer transition-colors ${
                    activeSettingsTab === 'general'
                      ? 'bg-white text-blue-700 shadow-xs'
                      : 'text-slate-500 hover:text-slate-800'
                  }`}
                >
                  <Wrench className="w-3.5 h-3.5" />
                  <span>General Parameters</span>
                </button>
                <button
                  type="button"
                  onClick={() => setActiveSettingsTab('schema')}
                  className={`flex items-center gap-1.5 text-xs font-semibold px-4 py-1.5 rounded-lg cursor-pointer transition-colors ${
                    activeSettingsTab === 'schema'
                      ? 'bg-white text-blue-700 shadow-xs'
                      : 'text-slate-500 hover:text-slate-800'
                  }`}
                >
                  <Sliders className="w-3.5 h-3.5" />
                  <span>Custom Annotation Variables</span>
                </button>
              </div>

              {/* Scrollable Modal Content */}
              <div className="flex-1 overflow-y-auto pr-1 space-y-4 text-xs">
                {activeSettingsTab === 'general' ? (
                  <div className="space-y-4">
                    {/* Rename Group */}
                    <div className="space-y-1.5">
                      <label className="font-semibold text-slate-600">Group Name</label>
                      <input
                        type="text"
                        value={editingGroupName}
                        onChange={(e) => setEditingGroupName(e.target.value)}
                        className="w-full border border-slate-200 rounded-lg px-3 py-1.5 bg-white focus:ring-1 focus:ring-blue-500 focus:outline-none"
                      />
                    </div>

                    {/* Description */}
                    <div className="space-y-1.5">
                      <label className="font-semibold text-slate-600">Description (Optional)</label>
                      <textarea
                        placeholder="e.g. Cardiology Referrals, Clinic A study case notes..."
                        value={selectedGroupForSettings.settings?.description || ''}
                        onChange={(e) => setSelectedGroupForSettings({
                          ...selectedGroupForSettings,
                          settings: {
                            ...selectedGroupForSettings.settings,
                            description: e.target.value
                          }
                        })}
                        className="w-full border border-slate-200 rounded-lg px-3 py-1.5 bg-white focus:ring-1 focus:ring-blue-500 focus:outline-none h-16 resize-none"
                      />
                    </div>

                    {/* Default Encounter Template */}
                    <div className="space-y-1.5">
                      <label className="font-semibold text-slate-600">Default Encounter Template</label>
                      <select
                        value={selectedGroupForSettings.settings?.encounterTemplate || 'standard'}
                        onChange={(e) => setSelectedGroupForSettings({
                          ...selectedGroupForSettings,
                          settings: {
                            ...selectedGroupForSettings.settings,
                            encounterTemplate: e.target.value
                          }
                        })}
                        className="w-full border border-slate-200 rounded-lg px-3 py-1.5 bg-white focus:ring-1 focus:ring-blue-500 focus:outline-none cursor-pointer"
                      >
                        <option value="standard">Standard SOAP Note</option>
                        <option value="soap">Comprehensive SOAP</option>
                        <option value="birp">BIRP Note (Behavior, Intervention, Response, Plan)</option>
                        <option value="dialogue">Dialogue Only</option>
                      </select>
                    </div>

                    {/* Preferred NLP Model */}
                    <div className="space-y-1.5">
                      <label className="font-semibold text-slate-600">Preferred AI Model</label>
                      <select
                        value={selectedGroupForSettings.settings?.preferredModel || 'gemini-3.5-flash'}
                        onChange={(e) => setSelectedGroupForSettings({
                          ...selectedGroupForSettings,
                          settings: {
                            ...selectedGroupForSettings.settings,
                            preferredModel: e.target.value
                          }
                        })}
                        className="w-full border border-slate-200 rounded-lg px-3 py-1.5 bg-white focus:ring-1 focus:ring-blue-500 focus:outline-none cursor-pointer"
                      >
                        <option value="gemini-3.5-flash">Gemini 3.5 Flash (Recommended)</option>
                        <option value="gemini-1.5-pro">Gemini 1.5 Pro (Advanced Clinical reasoning)</option>
                      </select>
                    </div>

                    {/* Clinical Taxonomy */}
                    <div className="space-y-1.5">
                      <label className="font-semibold text-slate-600">Preferred Clinical Taxonomy</label>
                      <select
                        value={selectedGroupForSettings.settings?.clinicalTaxonomy || 'all'}
                        onChange={(e) => setSelectedGroupForSettings({
                          ...selectedGroupForSettings,
                          settings: {
                            ...selectedGroupForSettings.settings,
                            clinicalTaxonomy: e.target.value
                          }
                        })}
                        className="w-full border border-slate-200 rounded-lg px-3 py-1.5 bg-white focus:ring-1 focus:ring-blue-500 focus:outline-none cursor-pointer"
                      >
                        <option value="all">Standard Clinical Graph Mapping (All taxonomies)</option>
                        <option value="snomed">SNOMED-CT Only</option>
                        <option value="icd10">ICD-10-CM Only</option>
                        <option value="rxnorm">RxNorm Only</option>
                      </select>
                    </div>
                  </div>
                ) : (
                  <div className="space-y-4 animate-in fade-in duration-150">
                    {/* Header Info */}
                    <div className="flex items-center justify-between bg-slate-50 p-3 rounded-xl border border-slate-200/50">
                      <div>
                        <h4 className="font-bold text-slate-700">Project-Specific Schema Builder</h4>
                        <p className="text-[10px] text-slate-500 leading-normal mt-0.5">
                          Specify which medical variables are documented during annotations. Deleting a category prevents it from cluttering the session's workspace.
                        </p>
                      </div>
                      <button
                        type="button"
                        onClick={handleResetSchema}
                        className="flex items-center gap-1 text-[10px] font-bold text-blue-600 hover:text-blue-700 bg-white border border-slate-200 px-2.5 py-1.5 rounded-lg shadow-2xs hover:bg-slate-50 shrink-0 cursor-pointer"
                      >
                        <RefreshCw className="w-3 h-3" />
                        <span>Reset System Defaults</span>
                      </button>
                    </div>

                    {/* Pre-configured Schema Templates */}
                    <div className="bg-slate-50 p-3.5 rounded-xl border border-slate-200/50 space-y-2.5">
                      <span className="font-bold text-slate-700 block text-[10px] uppercase tracking-wider font-mono">Load Pre-configured Schema Template</span>
                      <div className="flex flex-wrap gap-2">
                        <button
                          type="button"
                          onClick={() => updateSchema(DEFAULT_ANNOTATION_SCHEMA)}
                          className={`flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-semibold border cursor-pointer transition-all ${
                            JSON.stringify(schema) === JSON.stringify(DEFAULT_ANNOTATION_SCHEMA)
                              ? 'bg-blue-50 text-blue-700 border-blue-200 font-bold'
                              : 'bg-white text-slate-600 border-slate-200 hover:bg-slate-50 hover:border-slate-300'
                          }`}
                        >
                          <Activity className="w-3.5 h-3.5 text-blue-600" />
                          <span>Standard Clinical Default</span>
                        </button>
                        <button
                          type="button"
                          onClick={() => updateSchema(FHIR_ANNOTATION_SCHEMA)}
                          className={`flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-semibold border cursor-pointer transition-all ${
                            JSON.stringify(schema) === JSON.stringify(FHIR_ANNOTATION_SCHEMA)
                              ? 'bg-emerald-50 text-emerald-700 border-emerald-200 font-bold'
                              : 'bg-white text-slate-600 border-slate-200 hover:bg-slate-50 hover:border-slate-300'
                          }`}
                        >
                          <ShieldCheck className="w-3.5 h-3.5 text-emerald-600" />
                          <span>FHIR R4 Compliant Template</span>
                        </button>
                      </div>
                      <p className="text-[10px] text-slate-400 leading-normal">
                        💡 <strong>Template Switch:</strong> Choosing a template will configure the variables and standard validations (like <code>clinicalStatus</code>, <code>verificationStatus</code>, <code>interpretation</code>, or <code>priority</code>) for Condition, Observation, MedicationStatement, AllergyIntolerance, or ServiceRequest resources.
                      </p>
                    </div>

                    {/* Current Schema Variables */}
                    <div className="space-y-3">
                      {schema.length === 0 ? (
                        <div className="text-center py-6 bg-slate-50/50 border border-dashed rounded-xl border-slate-200 italic text-slate-400">
                          No variables configured. Click below to add standard or custom clinical categories.
                        </div>
                      ) : (
                        schema.map(cat => {
                          const attrForm = newAttrState[cat.id] || { name: '', type: 'text', choices: '', hint: '' };
                          
                          return (
                            <div key={cat.id} className="border border-slate-200 rounded-xl bg-white overflow-hidden shadow-2xs">
                              {/* Category Header */}
                              <div className="flex items-center justify-between bg-slate-50 px-4 py-2.5 border-b border-slate-200">
                                <div className="flex items-center gap-2">
                                  <span className="font-bold text-slate-800">{cat.displayName}</span>
                                  <span className="text-[9px] font-bold px-1.5 py-0.5 rounded uppercase bg-blue-100 text-blue-800 font-mono">
                                    ID: {cat.id}
                                  </span>
                                </div>
                                <button
                                  type="button"
                                  onClick={() => handleDeleteCategory(cat.id)}
                                  className="p-1 hover:bg-rose-100 text-slate-400 hover:text-rose-600 rounded transition-colors cursor-pointer"
                                  title="Delete entire category"
                                >
                                  <Trash2 className="w-3.5 h-3.5" />
                                </button>
                              </div>

                              {/* Model Type Hint Guidance */}
                              <div className="px-4 py-2.5 border-b border-slate-100 bg-amber-50/15 space-y-1">
                                <label className="text-[10px] font-bold text-amber-800/80 uppercase tracking-wider font-mono flex items-center gap-1">
                                  <span>🤖 LLM Annotation Type Hint (Model Guidance)</span>
                                </label>
                                <textarea
                                  placeholder="Provide instructions to tell the model directly when to map entities to this category (e.g. differentiate ServiceRequests vs. Procedures vs. Observations/DiagnosticReports)..."
                                  value={cat.typeHint || ''}
                                  onChange={(e) => {
                                    const updated = schema.map(c => {
                                      if (c.id === cat.id) {
                                        return { ...c, typeHint: e.target.value };
                                      }
                                      return c;
                                    });
                                    updateSchema(updated);
                                  }}
                                  className="w-full text-xs border border-slate-200 rounded-lg px-2.5 py-1.5 bg-white focus:ring-1 focus:ring-blue-500 focus:outline-none h-14 resize-none leading-normal font-sans text-slate-700"
                                />
                              </div>

                              {/* Attributes List */}
                              <div className="p-3.5 space-y-3">
                                <div className="space-y-1.5">
                                  <span className="text-[10px] font-bold text-slate-400 uppercase tracking-wider font-mono">Attributes & Validation Constraints</span>
                                  <div className="grid grid-cols-1 gap-1.5">
                                    {cat.attributes.map(attr => (
                                      <div key={attr.name} className="flex items-start justify-between bg-slate-50/50 px-2.5 py-2 rounded-lg border border-slate-100 text-[11px]">
                                        <div className="min-w-0 flex-1">
                                          <div className="flex items-center gap-1.5">
                                            <span className="font-bold text-slate-700 font-mono">{attr.name}</span>
                                            <span className="text-[9px] px-1 py-0.2 rounded bg-slate-200/60 font-medium text-slate-600">
                                              {attr.type}
                                            </span>
                                            {attr.choices && (
                                              <span className="text-[9px] font-mono text-blue-600 max-w-[200px] truncate" title={attr.choices.join(', ')}>
                                                [{attr.choices.join(', ')}]
                                              </span>
                                            )}
                                          </div>
                                          {attr.hint && (
                                            <p className="text-[10px] text-slate-400 italic mt-0.5">{attr.hint}</p>
                                          )}
                                        </div>
                                        {attr.name !== 'name' && attr.name !== 'task' && (
                                          <button
                                            type="button"
                                            onClick={() => handleDeleteAttribute(cat.id, attr.name)}
                                            className="text-slate-400 hover:text-rose-500 p-0.5 cursor-pointer rounded hover:bg-rose-50"
                                            title="Delete attribute"
                                          >
                                            <Trash2 className="w-3 h-3" />
                                          </button>
                                        )}
                                      </div>
                                    ))}
                                  </div>
                                </div>

                                {/* Add Attribute Form */}
                                <div className="bg-slate-50/30 p-2.5 border border-slate-200/50 rounded-lg space-y-2 text-[11px]">
                                  <span className="font-bold text-slate-500 font-mono block text-[9.5px] uppercase">Add Attribute to {cat.displayName}</span>
                                  <div className="grid grid-cols-1 sm:grid-cols-12 gap-2">
                                    <div className="sm:col-span-3">
                                      <input
                                        type="text"
                                        placeholder="Name (e.g. onset)"
                                        value={attrForm.name}
                                        onChange={e => setNewAttrState(prev => ({
                                          ...prev,
                                          [cat.id]: { ...attrForm, name: e.target.value }
                                        }))}
                                        className="w-full text-xs border border-slate-200 rounded px-2 py-1.5 bg-white focus:ring-1 focus:ring-blue-500 focus:outline-none"
                                      />
                                    </div>
                                    <div className="sm:col-span-3">
                                      <select
                                        value={attrForm.type}
                                        onChange={e => setNewAttrState(prev => ({
                                          ...prev,
                                          [cat.id]: { ...attrForm, type: e.target.value as any }
                                        }))}
                                        className="w-full text-xs border border-slate-200 rounded px-2 py-1.5 bg-white focus:ring-1 focus:ring-blue-500 focus:outline-none cursor-pointer"
                                      >
                                        <option value="text">Text Field</option>
                                        <option value="select">Select Dropdown</option>
                                        <option value="boolean">Yes/No Toggle</option>
                                      </select>
                                    </div>
                                    <div className="sm:col-span-6">
                                      <input
                                        type="text"
                                        placeholder={attrForm.type === 'select' ? "Choices (comma separated: e.g. Mild, Severe)" : "Hint or instructions for LLM/doctor"}
                                        value={attrForm.type === 'select' ? attrForm.choices : attrForm.hint}
                                        onChange={e => setNewAttrState(prev => ({
                                          ...prev,
                                          [cat.id]: { 
                                            ...attrForm, 
                                            choices: attrForm.type === 'select' ? e.target.value : attrForm.choices,
                                            hint: attrForm.type !== 'select' ? e.target.value : attrForm.hint
                                          }
                                        }))}
                                        className="w-full text-xs border border-slate-200 rounded px-2 py-1.5 bg-white focus:ring-1 focus:ring-blue-500 focus:outline-none"
                                      />
                                    </div>
                                  </div>
                                  {attrForm.type === 'select' && (
                                    <div className="mt-1">
                                      <input
                                        type="text"
                                        placeholder="Hint / instructions for the selector (Optional)"
                                        value={attrForm.hint}
                                        onChange={e => setNewAttrState(prev => ({
                                          ...prev,
                                          [cat.id]: { ...attrForm, hint: e.target.value }
                                        }))}
                                        className="w-full text-xs border border-slate-200 rounded px-2 py-1.5 bg-white focus:ring-1 focus:ring-blue-500 focus:outline-none"
                                      />
                                    </div>
                                  )}
                                  <div className="flex justify-end pt-1">
                                    <button
                                      type="button"
                                      onClick={() => handleAddAttribute(cat.id)}
                                      disabled={!attrForm.name.trim()}
                                      className="flex items-center gap-1 px-3 py-1 bg-slate-800 hover:bg-slate-700 text-white font-semibold rounded text-[10px] cursor-pointer disabled:opacity-50 transition-colors"
                                    >
                                      <Plus className="w-3 h-3" />
                                      <span>Add Attribute</span>
                                    </button>
                                  </div>
                                </div>
                              </div>
                            </div>
                          );
                        })
                      )}
                    </div>

                    {/* Add Category Builders */}
                    <div className="bg-slate-50 border border-slate-200 rounded-xl p-4 space-y-4 shadow-2xs">
                      <h4 className="font-bold text-slate-700 flex items-center gap-1.5">
                        <PlusCircle className="w-4 h-4 text-emerald-600" />
                        <span>Add Clinical Variables Category</span>
                      </h4>

                      {/* Part A: Standard Missing Categories (if any) */}
                      {standardMissing.length > 0 && (
                        <div className="space-y-1.5 p-2 bg-emerald-50/40 rounded-lg border border-emerald-100 text-[11px]">
                          <span className="font-bold text-emerald-800 block">Restore Pre-existing System Category:</span>
                          <div className="flex flex-wrap items-center gap-2">
                            {standardMissing.map(def => (
                              <button
                                key={def.id}
                                type="button"
                                onClick={() => handleAddStandardCategory(def.id)}
                                className="flex items-center gap-1 px-2.5 py-1.5 bg-white hover:bg-emerald-50 text-emerald-700 border border-emerald-200 rounded-lg font-semibold transition-all cursor-pointer text-[10px] shadow-3xs"
                              >
                                <Plus className="w-3 h-3 text-emerald-600" />
                                <span>{def.displayName}</span>
                              </button>
                            ))}
                          </div>
                        </div>
                      )}

                      {/* Part B: Completely Custom Category Builder */}
                      <div className="space-y-2.5 p-3 bg-slate-100/50 rounded-lg border border-slate-200/50">
                        <span className="font-bold text-slate-700 block text-[11px]">Create Completely Custom Variables Category:</span>
                        <div className="grid grid-cols-1 sm:grid-cols-12 gap-2 text-[11px]">
                          <div className="sm:col-span-6">
                            <input
                              type="text"
                              placeholder="Display Name (e.g. Social History)"
                              value={newCatName}
                              onChange={e => setNewCatName(e.target.value)}
                              className="w-full text-xs border border-slate-200 rounded px-2.5 py-1.5 bg-white focus:ring-1 focus:ring-blue-500 focus:outline-none"
                            />
                          </div>
                          <div className="sm:col-span-6">
                            <select
                              value={newCatEntityType}
                              onChange={e => setNewCatEntityType(e.target.value)}
                              className="w-full text-xs border border-slate-200 rounded px-2.5 py-1.5 bg-white focus:ring-1 focus:ring-blue-500 focus:outline-none cursor-pointer"
                            >
                              <option value="Condition">Condition matched graph</option>
                              <option value="Symptom">Symptom matched graph</option>
                              <option value="Medication">Medication matched graph</option>
                              <option value="FollowUp">Follow-up Task matched graph</option>
                              <option value="Measurement">Measurement matched graph</option>
                              <option value="Person">Person matched graph</option>
                              <option value="Patient">Patient matched graph</option>
                              <option value="Doctor">Doctor matched graph</option>
                              <option value="Other">Other / General matched graph</option>
                            </select>
                          </div>
                        </div>
                        <div className="grid grid-cols-1 sm:grid-cols-12 gap-2 text-[11px]">
                          <div className="sm:col-span-9">
                            <input
                              type="text"
                              placeholder="Optional Model Type Hint (e.g. Use for active job status or environmental exposures)"
                              value={newCatTypeHint}
                              onChange={e => setNewCatTypeHint(e.target.value)}
                              className="w-full text-xs border border-slate-200 rounded px-2.5 py-1.5 bg-white focus:ring-1 focus:ring-blue-500 focus:outline-none"
                            />
                          </div>
                          <div className="sm:col-span-3">
                            <button
                              type="button"
                              onClick={handleAddCategory}
                              disabled={!newCatName.trim()}
                              className="w-full h-full flex items-center justify-center gap-1 px-3 py-1.5 bg-blue-600 hover:bg-blue-700 text-white font-semibold rounded-lg text-xs cursor-pointer disabled:opacity-50 transition-colors"
                            >
                              <Plus className="w-3.5 h-3.5" />
                              <span>Create Category</span>
                            </button>
                          </div>
                        </div>
                      </div>
                    </div>
                  </div>
                )}

                {/* Preview Warning / Disclaimer */}
                <div className="bg-amber-50 border border-amber-100 p-3 rounded-lg flex gap-2 text-amber-800">
                  <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
                  <p className="text-[10px] leading-normal font-medium">
                    💡 <strong>Real-time Variable Annotation:</strong> Custom variables added to this project will be applied to all sessions in the group, restricting or extending the clinical fields rendered in active sessions.
                  </p>
                </div>
              </div>

              {/* Action Buttons */}
              <div className="flex items-center justify-end gap-2 pt-2 border-t border-slate-100 shrink-0">
                <button
                  type="button"
                  onClick={() => {
                    setIsSettingsOpen(false);
                    setEditingGroupName('');
                    setActiveSettingsTab('general');
                  }}
                  className="px-3.5 py-1.5 border border-slate-200 text-slate-600 rounded-lg hover:bg-slate-50 font-semibold cursor-pointer text-xs"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={async () => {
                    const nameToSave = editingGroupName.trim() || selectedGroupForSettings.name;
                    await onUpdateGroup(selectedGroupForSettings.id, nameToSave, selectedGroupForSettings.settings || {});
                    setEditingGroupName('');
                    setIsSettingsOpen(false);
                    setActiveSettingsTab('general');
                  }}
                  className="px-4 py-1.5 bg-blue-600 text-white rounded-lg hover:bg-blue-700 font-semibold cursor-pointer text-xs flex items-center gap-1 shadow-sm"
                >
                  <CheckCircle2 className="w-4 h-4" />
                  <span>Save Settings</span>
                </button>
              </div>
            </div>
          </div>
        );
      })()}
    </div>
  );
}

