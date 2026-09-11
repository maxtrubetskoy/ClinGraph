import React, { useState, useMemo } from 'react';
import { X, Download, Copy, Check, FileCode, Layers, MessageSquare, Share2, Sparkles } from 'lucide-react';
import { Entity, Mention, Relation, Conversation, ClinicalCategory } from '../types';
import { generateJsonlContent, downloadJsonlFile, JsonlExportType } from '../utils/exportJsonl';

interface ExportJsonlModalProps {
  isOpen: boolean;
  onClose: () => void;
  session?: Partial<Conversation> | null;
  entities?: Entity[];
  mentions?: Mention[];
  relations?: Relation[];
  clinicalNotes?: ClinicalCategory;
}

export default function ExportJsonlModal({
  isOpen,
  onClose,
  session,
  entities = [],
  mentions = [],
  relations = [],
  clinicalNotes
}: ExportJsonlModalProps) {
  const [exportType, setExportType] = useState<JsonlExportType>('entities_mentions');
  const [copied, setCopied] = useState(false);

  const jsonlContent = useMemo(() => {
    return generateJsonlContent(
      exportType,
      session,
      entities,
      mentions,
      relations,
      clinicalNotes
    );
  }, [exportType, session, entities, mentions, relations, clinicalNotes]);

  const lineCount = useMemo(() => {
    if (!jsonlContent) return 0;
    return jsonlContent.split('\n').filter(Boolean).length;
  }, [jsonlContent]);

  if (!isOpen) return null;

  const handleCopy = () => {
    navigator.clipboard.writeText(jsonlContent);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleDownload = () => {
    const rawTitle = session?.title || 'clinical_annotations';
    const cleanTitle = rawTitle.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
    const filename = `${cleanTitle}_${exportType}.jsonl`;
    downloadJsonlFile(jsonlContent, filename);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/60 backdrop-blur-sm animate-in fade-in duration-200">
      <div className="bg-white border border-slate-200 rounded-2xl shadow-2xl w-full max-w-3xl max-h-[90vh] flex flex-col overflow-hidden">
        {/* Header */}
        <div className="px-6 py-4 border-b border-slate-100 flex items-center justify-between bg-slate-50/50">
          <div className="flex items-center gap-2.5">
            <div className="p-2 bg-indigo-50 text-indigo-600 rounded-xl">
              <FileCode className="w-5 h-5" />
            </div>
            <div>
              <h2 className="text-sm font-bold text-slate-800 flex items-center gap-2">
                Export Annotated Dataset (JSONL)
              </h2>
              <p className="text-xs text-slate-500">
                Extract clinical entities, text spans, UMLS mappings, and mentions as JSON Lines
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 text-slate-400 hover:text-slate-600 hover:bg-slate-100 rounded-lg transition-colors cursor-pointer"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Body */}
        <div className="p-6 overflow-y-auto space-y-5 flex-1">
          {/* Export Type Selector Cards */}
          <div>
            <label className="block text-xs font-semibold text-slate-600 uppercase tracking-wider mb-2 font-mono">
              Select Export Schema / Format
            </label>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
              <button
                onClick={() => setExportType('entities_mentions')}
                className={`p-3.5 rounded-xl border text-left transition-all cursor-pointer flex flex-col justify-between ${
                  exportType === 'entities_mentions'
                    ? 'border-indigo-500 bg-indigo-50/40 text-indigo-950 shadow-sm ring-1 ring-indigo-500/30'
                    : 'border-slate-200 hover:border-slate-300 bg-white text-slate-700'
                }`}
              >
                <div className="flex items-center justify-between mb-1">
                  <span className="font-bold text-xs flex items-center gap-1.5">
                    <Layers className="w-4 h-4 text-indigo-600" /> Entities & Mentions
                  </span>
                  <span className="text-[10px] px-1.5 py-0.5 rounded-md font-mono font-semibold bg-indigo-100 text-indigo-700">
                    {entities.length} items
                  </span>
                </div>
                <p className="text-[11px] text-slate-500 leading-normal">
                  Each line is an annotated entity enriched with UMLS codes and linked mention spans.
                </p>
              </button>

              <button
                onClick={() => setExportType('mentions')}
                className={`p-3.5 rounded-xl border text-left transition-all cursor-pointer flex flex-col justify-between ${
                  exportType === 'mentions'
                    ? 'border-indigo-500 bg-indigo-50/40 text-indigo-950 shadow-sm ring-1 ring-indigo-500/30'
                    : 'border-slate-200 hover:border-slate-300 bg-white text-slate-700'
                }`}
              >
                <div className="flex items-center justify-between mb-1">
                  <span className="font-bold text-xs flex items-center gap-1.5">
                    <MessageSquare className="w-4 h-4 text-emerald-600" /> Mentions Spans
                  </span>
                  <span className="text-[10px] px-1.5 py-0.5 rounded-md font-mono font-semibold bg-emerald-100 text-emerald-700">
                    {mentions.length} spans
                  </span>
                </div>
                <p className="text-[11px] text-slate-500 leading-normal">
                  Each line is a transcript text mention span with line index, char offsets, speaker, and entity ID.
                </p>
              </button>

              <button
                onClick={() => setExportType('relations')}
                className={`p-3.5 rounded-xl border text-left transition-all cursor-pointer flex flex-col justify-between ${
                  exportType === 'relations'
                    ? 'border-indigo-500 bg-indigo-50/40 text-indigo-950 shadow-sm ring-1 ring-indigo-500/30'
                    : 'border-slate-200 hover:border-slate-300 bg-white text-slate-700'
                }`}
              >
                <div className="flex items-center justify-between mb-1">
                  <span className="font-bold text-xs flex items-center gap-1.5">
                    <Share2 className="w-4 h-4 text-purple-600" /> Knowledge Relations
                  </span>
                  <span className="text-[10px] px-1.5 py-0.5 rounded-md font-mono font-semibold bg-purple-100 text-purple-700">
                    {relations.length} relations
                  </span>
                </div>
                <p className="text-[11px] text-slate-500 leading-normal">
                  Each line is a directed knowledge relation edge connecting source and target clinical concepts.
                </p>
              </button>

              <button
                onClick={() => setExportType('full_dataset')}
                className={`p-3.5 rounded-xl border text-left transition-all cursor-pointer flex flex-col justify-between ${
                  exportType === 'full_dataset'
                    ? 'border-indigo-500 bg-indigo-50/40 text-indigo-950 shadow-sm ring-1 ring-indigo-500/30'
                    : 'border-slate-200 hover:border-slate-300 bg-white text-slate-700'
                }`}
              >
                <div className="flex items-center justify-between mb-1">
                  <span className="font-bold text-xs flex items-center gap-1.5">
                    <Sparkles className="w-4 h-4 text-amber-600" /> Full Session Record
                  </span>
                  <span className="text-[10px] px-1.5 py-0.5 rounded-md font-mono font-semibold bg-amber-100 text-amber-800">
                    1 record
                  </span>
                </div>
                <p className="text-[11px] text-slate-500 leading-normal">
                  Single document line containing transcript, segments, entities, mentions, relations, and notes.
                </p>
              </button>
            </div>
          </div>

          {/* Code Preview Header & Box */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-xs font-semibold text-slate-600 uppercase tracking-wider font-mono">
                JSONL Output Preview ({lineCount} {lineCount === 1 ? 'line' : 'lines'})
              </span>
              <button
                onClick={handleCopy}
                disabled={!jsonlContent}
                className="text-xs font-medium text-slate-600 hover:text-indigo-600 flex items-center gap-1 transition-colors cursor-pointer disabled:opacity-50"
              >
                {copied ? <Check className="w-3.5 h-3.5 text-emerald-600" /> : <Copy className="w-3.5 h-3.5" />}
                <span>{copied ? 'Copied to Clipboard!' : 'Copy Preview'}</span>
              </button>
            </div>

            <div className="bg-slate-950 text-slate-200 p-4 rounded-xl border border-slate-800 font-mono text-xs overflow-x-auto max-h-56 leading-relaxed select-all">
              {jsonlContent ? (
                jsonlContent.split('\n').map((line, idx) => (
                  <div key={idx} className="py-0.5 hover:bg-slate-900 border-b border-slate-900/50 last:border-none whitespace-pre font-mono">
                    <span className="text-slate-600 select-none mr-3 inline-block w-6 text-right text-[10px]">{idx + 1}</span>
                    <span className="text-indigo-300">{line}</span>
                  </div>
                ))
              ) : (
                <div className="text-slate-500 italic py-6 text-center font-sans text-xs">
                  No records available for this export mode in the current session.
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="px-6 py-4 bg-slate-50 border-t border-slate-200 flex flex-wrap items-center justify-between gap-3">
          <div className="text-xs text-slate-500 font-mono">
            Format: Standard JSON Lines (.jsonl)
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={onClose}
              className="px-4 py-2 text-xs font-semibold text-slate-600 hover:bg-slate-200/70 rounded-xl transition-all cursor-pointer"
            >
              Close
            </button>
            <button
              onClick={handleCopy}
              disabled={!jsonlContent}
              className="px-4 py-2 bg-white hover:bg-slate-100 text-slate-700 font-semibold text-xs border border-slate-300 rounded-xl shadow-sm transition-all cursor-pointer flex items-center gap-1.5 disabled:opacity-50"
            >
              {copied ? <Check className="w-4 h-4 text-emerald-600" /> : <Copy className="w-4 h-4" />}
              <span>{copied ? 'Copied!' : 'Copy JSONL'}</span>
            </button>
            <button
              onClick={handleDownload}
              disabled={!jsonlContent}
              className="px-4.5 py-2 bg-indigo-600 hover:bg-indigo-700 text-white font-semibold text-xs rounded-xl shadow-md transition-all cursor-pointer flex items-center gap-1.5 disabled:opacity-50"
            >
              <Download className="w-4 h-4" />
              <span>Download .jsonl</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
