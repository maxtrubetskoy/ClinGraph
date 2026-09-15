import { useState, useEffect, useRef } from 'react';
import { Play, ClipboardCopy, FileText, Sparkles, AlertCircle, Info, Download, Edit, Key } from 'lucide-react';
import { isJsonOrJsonlFormat } from '../utils/transcriptParser';
import AnnotationProgress from './AnnotationProgress';
import type { AnnotationProgress as Progress } from '../types';

interface ConversationEditorProps {
  rawTranscript: string;
  onTranscriptChange: (text: string) => void;
  onFocusEditor?: () => void;
  onAnnotate: (text: string) => void;
  onDiarize: () => void;
  onManualAnnotate: () => void;
  isDiarizing: boolean;
  hasAudio: boolean;
  status: 'draft' | 'processing' | 'annotated' | 'failed';
  annotationProgress?: Progress | null;
  warningMessage?: string | null;
  encounterType?: 'dialogue' | 'note';
  isReadOnly?: boolean;
  isServerReady?: boolean;
  onOpenSettings?: () => void;
  hasApiKey?: boolean;
}

const DIALOGUE_TEMPLATES = [
  {
    title: 'Hypertension Follow-up',
    text: `Doctor: Good morning! How have you been feeling since your last visit?
Patient: Hi doctor. Mostly okay, but I have had some mild headaches in the afternoon.
Doctor: I see. Let's look at your blood pressure log. It looks like your readings are averaging around 148/92. That is a bit high.
Patient: Yeah, I measured 150/94 yesterday.
Doctor: Your current prescription is Lisinopril 10mg once daily. To bring that blood pressure down and help with those headaches, let's increase your Lisinopril to 20mg once daily.
Patient: Okay, I will start taking the higher dose. Any side effects?
Doctor: You might feel a little dizzy initially, so take it in the morning. Also, please keep logging your blood pressure daily. Let's schedule a follow-up visit in two weeks to review your progress.`
  },
  {
    title: 'Asthma Review & Prescription',
    text: `Doctor: Hello Sarah, let's discuss your asthma symptoms.
Patient: Hi Dr. Evans. My wheezing has been getting worse, especially when I exercise. I had to use my Albuterol inhaler four times this week.
Doctor: That suggests your asthma is not fully controlled. Are you still taking your daily Flovent?
Patient: I ran out of Flovent two weeks ago and haven't refilled it.
Doctor: Ah, that explains the flare-up. It's critical to take your Flovent 110mcg daily as a controller medication, not just the Albuterol rescue. Let's issue a refill for Flovent. Please start using it twice daily.
Patient: I understand. I will get the refill today.
Doctor: Excellent. If the exercise-induced wheezing continues even with daily Flovent, let's do a lung function test. Please schedule a follow-up spirometry check in 4 weeks.`
  },
  {
    title: 'Diabetic Foot Review',
    text: `Doctor: Good afternoon Mr. Miller. How are your feet looking?
Patient: Hello doctor. I noticed a small red blister on my left big toe yesterday. It doesn't hurt, but it looks inflamed.
Doctor: Let me examine that. Yes, there is some mild redness, though no active drainage. This is a potential diabetic ulcer. We need to prevent infection. Are you tracking your morning blood sugars?
Patient: They have been high, around 180.
Doctor: Okay, we need to adjust your Metformin. Let's increase Metformin from 500mg twice daily to 1000mg twice daily with meals. For the blister, please clean it daily and apply Neosporin ointment.
Patient: I will do that.
Doctor: I will also refer you to Podiatry. Please follow up with the podiatrist within 1 week and come back to see me in 10 days if the blister doesn't heal.`
  }
];

const NOTE_TEMPLATES = [
  {
    title: 'SOAP Note',
    text: `Subjective:
Patient is a 54-year-old female presenting for a follow-up of her hypertension. She reports mild, episodic headaches in the late afternoon for the past 2 weeks. She has been compliant with her daily Lisinopril 10mg but has noticed her home BP readings are rising.

Objective:
Vitals: BP 148/92 mmHg, HR 72 bpm, Temp 98.6°F.
Heart: Regular rate and rhythm. Lungs clear to auscultation. No peripheral edema noted.

Assessment:
1. Essential Hypertension - currently uncontrolled on Lisinopril 10mg daily. Afternoon headaches are likely secondary to elevated blood pressure.

Plan:
1. Increase Lisinopril to 20mg orally once daily. Advised patient to take in the morning.
2. Patient to monitor and log blood pressure daily at home.
3. Schedule follow-up clinic visit in 2 weeks to evaluate response.`
  },
  {
    title: 'Referral Letter',
    text: `Date: July 9, 2026
From: Dr. Robert Evans, MD (Primary Care)
To: Department of Podiatry, Mercy Medical Center

Subject: Clinical Referral for Mr. Arthur Miller (DOB: 11/14/1968)

Dear Colleagues,

I am referring Mr. Miller, a 57-year-old male with a history of Type 2 Diabetes, for specialized podiatric evaluation and management of a foot lesion.

During a routine clinical exam today, Mr. Miller presented with a small, red, non-painful blister on his left big toe. It is mildly inflamed but currently has no active drainage. His fasting morning blood glucose levels have been elevated, averaging around 180 mg/dL.

To prevent progression to an active diabetic ulcer, we have adjusted his Metformin dosage from 500mg twice daily to 1000mg twice daily with meals. He has been instructed to clean the blister daily and apply Neosporin ointment.

I would appreciate your expert consultation. He will follow up with me in 10 days.

Sincerely,
Dr. Robert Evans, MD`
  },
  {
    title: 'Discharge Summary',
    text: `Patient Name: James Bennett
Admitting Diagnosis: Acute Asthma Exacerbation

History of Present Illness:
The patient is a 24-year-old male with a history of moderate persistent asthma who presented with severe wheezing after running out of his maintenance Flovent inhaler two weeks ago. He had been using Albuterol up to 6 times daily without adequate relief.

Hospital Course:
Successfully treated with nebulized Albuterol, intravenous methylprednisolone, and oxygen therapy.

Discharge Medications:
1. Flovent (Fluticasone) 110mcg inhaler: 1 puff twice daily (Controller medication - resumed).
2. Albuterol HFA inhaler: 2 puffs every 4-6 hours orally as needed (Rescue medication).

Follow-up Care:
Patient is instructed to schedule a follow-up spirometry check in 4 weeks with Dr. Sarah Evans.`
  }
];

export default function ConversationEditor({
  rawTranscript,
  onTranscriptChange,
  onFocusEditor,
  onAnnotate,
  onDiarize,
  onManualAnnotate,
  isDiarizing,
  hasAudio,
  status,
  annotationProgress,
  warningMessage,
  encounterType = 'dialogue',
  isReadOnly = false,
  isServerReady = true,
  onOpenSettings,
  hasApiKey = false
}: ConversationEditorProps) {
  const [localText, setLocalText] = useState(rawTranscript);
  const [selectedTemplateIdx, setSelectedTemplateIdx] = useState<number | null>(null);
  const [copied, setCopied] = useState(false);
  const isTypingRef = useRef(false);
  const debounceTimerRef = useRef<NodeJS.Timeout | null>(null);

  // Sync external rawTranscript changes when user is not actively typing
  useEffect(() => {
    if (!isTypingRef.current) {
      setLocalText(rawTranscript);
    }
  }, [rawTranscript]);

  // Clean up timer on unmount
  useEffect(() => {
    return () => {
      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current);
      }
    };
  }, []);

  // Reset template index if encounter type changes
  useEffect(() => {
    setSelectedTemplateIdx(null);
  }, [encounterType]);

  const templates = encounterType === 'note' ? NOTE_TEMPLATES : DIALOGUE_TEMPLATES;

  const handleTextChange = (newText: string) => {
    setLocalText(newText);
    isTypingRef.current = true;

    if (debounceTimerRef.current) {
      clearTimeout(debounceTimerRef.current);
    }

    debounceTimerRef.current = setTimeout(() => {
      onTranscriptChange(newText);
      isTypingRef.current = false;
    }, 450);
  };

  const handleBlur = () => {
    if (debounceTimerRef.current) {
      clearTimeout(debounceTimerRef.current);
      debounceTimerRef.current = null;
    }
    if (localText !== rawTranscript) {
      onTranscriptChange(localText);
    }
    isTypingRef.current = false;
  };

  const applyTemplate = (idx: number) => {
    setSelectedTemplateIdx(idx);
    const templateText = templates[idx].text;
    setLocalText(templateText);
    if (debounceTimerRef.current) {
      clearTimeout(debounceTimerRef.current);
      debounceTimerRef.current = null;
    }
    isTypingRef.current = false;
    onTranscriptChange(templateText);
  };

  const isJsonl = isJsonOrJsonlFormat(localText);

  const copyToClipboard = () => {
    navigator.clipboard.writeText(localText);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const downloadTranscript = () => {
    const blob = new Blob([localText], { type: isJsonl ? 'application/jsonl+json' : 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `diarized_transcript_${Date.now()}.${isJsonl ? 'jsonl' : 'txt'}`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const handleAnnotateClick = () => {
    // Flush any pending text before annotating
    if (debounceTimerRef.current) {
      clearTimeout(debounceTimerRef.current);
      debounceTimerRef.current = null;
    }
    isTypingRef.current = false;
    onAnnotate(localText);
  };

  return (
    <div className="transcript-editor space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-1.5">
          <FileText className="w-4 h-4 text-slate-500" />
          <h3 className="text-sm font-semibold text-slate-800">
            {encounterType === 'note' ? 'Clinical document' : 'Conversation transcript'}
          </h3>
        </div>
        {!isReadOnly && (
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-2xs text-slate-500 mr-1">Try an example</span>
            {templates.map((tpl, idx) => (
              <button
                key={idx}
                onClick={() => applyTemplate(idx)}
                disabled={status === 'processing' || isDiarizing}
                className={`text-2xs font-medium px-2.5 py-1.5 rounded-md border transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed ${
                  selectedTemplateIdx === idx
                    ? 'bg-brand-50 text-brand-700 border-brand-200'
                    : 'bg-white text-slate-600 border-slate-200 hover:bg-slate-50'
                }`}
              >
                {tpl.title}
              </button>
            ))}
          </div>
        )}
      </div>

      {warningMessage && (() => {
        const isError = warningMessage.toLowerCase().includes('failed') || 
                        warningMessage.toLowerCase().includes('error') || 
                        warningMessage.toLowerCase().includes('status 4') || 
                        warningMessage.toLowerCase().includes('status 5') ||
                        warningMessage.toLowerCase().includes('too large');
        
        return (
          <div className={`${
            isError ? 'bg-rose-50 border-rose-100 text-rose-800' : 'bg-amber-50 border-amber-100 text-amber-800'
          } border rounded-xl p-4 space-y-2.5 shadow-sm transition-all`}>
            <div className="flex items-start gap-2.5">
              <AlertCircle className={`w-4 h-4 shrink-0 mt-0.5 ${isError ? 'text-rose-600' : 'text-amber-600'}`} />
              <div className="text-xs leading-normal flex-1">
                <span className="font-semibold">{isError ? 'System Error / Diagnosis Trace:' : 'Notice / Info:'}</span>{' '}
                {warningMessage.split('\n')[0]}
                {onOpenSettings && (warningMessage.toLowerCase().includes('api key') || warningMessage.toLowerCase().includes('popup')) && (
                  <div className="mt-2.5">
                    <button
                      type="button"
                      onClick={onOpenSettings}
                      className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-amber-600 hover:bg-amber-700 text-white rounded-lg text-xs font-semibold shadow-xs transition-colors cursor-pointer"
                    >
                      <Key className="w-3.5 h-3.5" />
                      <span>Set Your API Key in Popup</span>
                    </button>
                  </div>
                )}
              </div>
            </div>
            
            {warningMessage.includes('\n') && (
              <details className={`text-2xs font-mono border rounded-lg p-3 cursor-pointer select-text overflow-hidden ${
                isError ? 'bg-rose-100/40 border-rose-200/50 text-rose-950' : 'bg-amber-100/40 border-amber-200/50 text-amber-950'
              }`}>
                <summary className="font-sans font-semibold text-xs mb-1.5 focus:outline-none cursor-pointer hover:underline flex items-center gap-1">
                  <span>Show Detailed System Diagnostics & Full Stack Trace</span>
                </summary>
                <pre className="whitespace-pre-wrap break-all text-2xs mt-2 font-mono leading-relaxed bg-black/5 p-2.5 rounded select-all max-h-52 overflow-y-auto">
                  {warningMessage}
                </pre>
              </details>
            )}
          </div>
        );
      })()}

      {localText.trim() && (
        <div className="flex items-center justify-between bg-slate-50/80 border border-slate-100 rounded-xl px-3 py-2 text-xs">
          <div className="flex items-center gap-1.5">
            {isJsonl ? (
              <span className="bg-brand-100 text-brand-800 text-2xs font-semibold px-2 py-0.5 rounded font-mono">
                JSONL Format
              </span>
            ) : (
              <span className="bg-slate-200 text-slate-700 text-2xs font-semibold px-2 py-0.5 rounded font-mono">
                Standard Text
              </span>
            )}
            <span className="text-slate-500 text-2xs hidden sm:inline">Source transcript</span>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={copyToClipboard}
              className="flex items-center gap-1 text-2xs font-medium text-slate-600 hover:text-slate-900 bg-white hover:bg-slate-100 border border-slate-200 px-2.5 py-1 rounded shadow-sm transition-colors cursor-pointer"
              title="Copy to Clipboard"
            >
              <ClipboardCopy className="w-3.5 h-3.5 text-slate-500" />
              <span>{copied ? 'Copied!' : 'Copy'}</span>
            </button>
            <button
              onClick={downloadTranscript}
              className="flex items-center gap-1 text-2xs font-medium text-slate-600 hover:text-slate-900 bg-white hover:bg-slate-100 border border-slate-200 px-2.5 py-1 rounded shadow-sm transition-colors cursor-pointer"
              title="Download File"
            >
              <Download className="w-3.5 h-3.5 text-slate-500" />
              <span>Download {isJsonl ? '.jsonl' : '.txt'}</span>
            </button>
          </div>
        </div>
      )}

      <div className="relative">
        <textarea
          aria-label={encounterType === 'note' ? 'Clinical document text' : 'Conversation transcript'}
          value={localText}
          onChange={(e) => handleTextChange(e.target.value)}
          onBlur={handleBlur}
          onFocus={onFocusEditor}
          placeholder={
            encounterType === 'note'
              ? "Type or paste the unstructured clinical note, referral letter, or SOAP summary here..."
              : "Type or paste the clinical conversation transcript here (e.g., in JSONL format, or 'Speaker: text'), or use a template, or record/upload audio and click 'Diarize Audio'..."
          }
          className={`transcript-input w-full h-[220px] border border-slate-200 rounded-lg focus:outline-none focus:ring-1 focus:ring-brand-500 focus:border-brand-500 ${
            isReadOnly ? 'bg-slate-50 text-slate-600' : 'bg-slate-50/50 text-slate-800'
          }`}
          disabled={status === 'processing' || isDiarizing}
          readOnly={isReadOnly}
        />
        <div className="absolute bottom-3 right-3 text-2xs text-slate-500 bg-slate-50/90 px-1.5 rounded select-none pointer-events-none">
          {localText.length} characters
        </div>
      </div>

      {annotationProgress && <AnnotationProgress progress={annotationProgress} encounterType={encounterType} />}

      {/* API Key hint if unset */}
      {!hasApiKey && !isReadOnly && (
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-slate-500">
          <Sparkles className="w-3.5 h-3.5 text-brand-600" />
          <span>Want a head start with AI?</span>
          {onOpenSettings && (
            <button
              type="button"
              onClick={onOpenSettings}
              className="font-medium text-brand-700 hover:underline"
            >
              Connect your model in settings
            </button>
          )}
        </div>
      )}

      <div className="flex flex-col 2xl:flex-row 2xl:items-center justify-between gap-4 pt-4 border-t border-slate-100">
        <div className="flex items-start gap-1.5 text-2xs text-slate-500">
          <Info className="w-3.5 h-3.5 text-slate-500 shrink-0 mt-0.5" />
          <span>
            {encounterType === 'note'
              ? "Clinical text documents are automatically parsed by paragraph block headings (e.g. Subjective:, Objective:, Plan:)."
              : "Format can be 'Speaker: text' or JSONL ({\"speaker\": \"Doctor\", \"text\": \"...\"})"}
          </span>
        </div>
        
        <div className="flex flex-wrap items-center gap-2 sm:self-end">
          {isReadOnly ? (
            <div className="text-xs text-brand-700 bg-brand-50 border border-brand-100 rounded-lg px-4.5 py-2 font-medium flex items-center gap-1.5 shadow-sm">
              <Info className="w-4 h-4 text-brand-500 shrink-0" />
              <span>Read-Only Session. Clone it to make edits.</span>
            </div>
          ) : (
            <>
              {hasAudio && (
                <button
                  onClick={onDiarize}
                  disabled={isDiarizing || status === 'processing' || !isServerReady}
                  className={`flex items-center gap-1.5 text-xs font-semibold px-4 py-2.5 rounded-lg shadow-sm border transition-all cursor-pointer ${
                    isDiarizing || !isServerReady
                      ? 'bg-slate-100 text-slate-500 border-slate-200 cursor-not-allowed shadow-none'
                      : 'bg-brand-50 hover:bg-brand-100 text-brand-700 border-brand-200 hover:shadow-md'
                  }`}
                >
                  {isDiarizing ? (
                    <>
                      <svg className="animate-spin h-4 w-4 text-brand-600" fill="none" viewBox="0 0 24 24">
                        <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                        <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                      </svg>
                      <span>Diarizing Audio...</span>
                    </>
                  ) : !isServerReady ? (
                    <>
                      <span className="w-1.5 h-1.5 rounded-full bg-amber-400 animate-pulse" />
                      <span>Server Starting...</span>
                    </>
                  ) : (
                    <>
                      <Sparkles className="w-4 h-4 text-brand-500" />
                      <span>Diarize Audio (JSONL)</span>
                    </>
                  )}
                </button>
              )}

              <button
                onClick={onManualAnnotate}
                disabled={status === 'processing' || isDiarizing}
                className={`btn ${hasApiKey ? 'btn-secondary' : 'btn-primary'}`}
              >
                <Edit className="w-3.5 h-3.5" />
                <span>Annotate Manually</span>
              </button>

              <button
                onClick={handleAnnotateClick}
                disabled={status === 'processing' || isDiarizing || !localText.trim() || !isServerReady}
                className={`btn ${hasApiKey ? 'btn-primary' : 'btn-secondary'}`}
              >
                {status === 'processing' ? (
                  <>
                    <svg className="animate-spin h-4 w-4 text-slate-500" fill="none" viewBox="0 0 24 24">
                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                    </svg>
                    <span>Analyzing Medical Encounters...</span>
                  </>
                ) : !isServerReady ? (
                  <>
                    <span className="w-1.5 h-1.5 rounded-full bg-amber-400 animate-pulse" />
                    <span>Server Starting...</span>
                  </>
                ) : (
                  <>
                    <Sparkles className="w-4 h-4 fill-white/20" />
                    <span>Generate AI Annotations</span>
                  </>
                )}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
