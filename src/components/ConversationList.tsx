import { useState } from 'react';
import { Conversation } from '../types';
import { Search, Calendar, FolderOpen, AlertCircle, Plus, Trash2, Tag } from 'lucide-react';

interface ConversationListProps {
  conversations: Conversation[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onDelete: (id: string) => void;
  onCreateNew: () => void;
}

export default function ConversationList({
  conversations,
  selectedId,
  onSelect,
  onDelete,
  onCreateNew
}: ConversationListProps) {
  const [searchQuery, setSearchQuery] = useState('');

  // Filter conversations based on search
  const filtered = conversations.filter(conv => {
    const query = searchQuery.toLowerCase();
    
    const titleMatch = conv.title.toLowerCase().includes(query);
    const transcriptMatch = conv.rawTranscript.toLowerCase().includes(query);
    
    // Check if symptoms or medications match the query
    const symptomMatch = conv.annotation?.clinicalNotes.symptoms.some(sym =>
      sym.name.toLowerCase().includes(query)
    ) || false;
    
    const medMatch = conv.annotation?.clinicalNotes.medications.some(med =>
      med.name.toLowerCase().includes(query)
    ) || false;

    return titleMatch || transcriptMatch || symptomMatch || medMatch;
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
    <div className="bg-white border border-slate-200 rounded-2xl p-4 flex flex-col h-full max-h-[800px] shadow-sm">
      {/* List Header */}
      <div className="flex items-center justify-between pb-4 mb-4 border-b border-slate-100">
        <div className="flex items-center gap-2">
          <FolderOpen className="w-4 h-4 text-blue-500" />
          <h3 className="text-sm font-semibold text-slate-800">Clinical Sessions</h3>
        </div>
        <button
          onClick={onCreateNew}
          className="flex items-center gap-1 text-[11px] font-semibold text-blue-600 hover:text-blue-700 bg-blue-50/50 px-2.5 py-1.5 rounded-lg transition-all cursor-pointer"
        >
          <Plus className="w-3.5 h-3.5" /> New Session
        </button>
      </div>

      {/* Search Input */}
      <div className="relative mb-4">
        <Search className="w-3.5 h-3.5 text-slate-400 absolute left-3 top-2.5" />
        <input
          type="text"
          placeholder="Search by title, drugs, symptoms..."
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          className="w-full text-xs border border-slate-200 rounded-lg pl-8 pr-3.5 py-1.5 focus:outline-none focus:ring-1 focus:ring-blue-500 focus:border-blue-500 bg-white"
        />
      </div>

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
            const relationCount = conv.annotation?.relations.length || 0;

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
    </div>
  );
}
