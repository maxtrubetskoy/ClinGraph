import { useState, useRef, useEffect, ChangeEvent } from 'react';
import { Mic, Square, Trash2, Upload, Volume2, AlertCircle, RefreshCw } from 'lucide-react';
import { compressAudioToMonoWav } from '../lib/audioCompressor';

interface AudioRecorderProps {
  onAudioRecorded: (blob: Blob, mimeType: string, speechToText?: string) => void | Promise<void>;
  onClearAudio: () => void;
  hasAudio: boolean;
  audioUrl?: string;
}

export default function AudioRecorder({
  onAudioRecorded,
  onClearAudio,
  hasAudio,
  audioUrl
}: AudioRecorderProps) {
  const [isRecording, setIsRecording] = useState(false);
  const [recordingTime, setRecordingTime] = useState(0);
  const [audioError, setAudioError] = useState<string | null>(null);
  const [isCompressing, setIsCompressing] = useState(false);
  const [compressionStatus, setCompressionStatus] = useState('');
  const [audioStats, setAudioStats] = useState<{ originalSize: number; compressedSize: number } | null>(null);
  
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  const timerRef = useRef<NodeJS.Timeout | null>(null);
  useEffect(() => () => {
    const recorder = mediaRecorderRef.current;
    if (recorder) {
      recorder.onstop = null;
      if (recorder.state !== 'inactive') recorder.stop();
      recorder.stream.getTracks().forEach(track => track.stop());
    }
  }, []);

  // Timer Effect
  useEffect(() => {
    if (isRecording) {
      timerRef.current = setInterval(() => {
        setRecordingTime(prev => prev + 1);
      }, 1000);
    } else {
      if (timerRef.current) {
        clearInterval(timerRef.current);
      }
      setRecordingTime(0);
    }

    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [isRecording]);

  const processAndSaveAudio = async (rawBlob: Blob, mimeType: string) => {
    setIsCompressing(true);
    setAudioError(null);
    setAudioStats(null);
    try {
      const maxBytes = 50 * 1024 * 1024;
      if (rawBlob.size <= maxBytes) {
        await onAudioRecorded(rawBlob, mimeType);
        return;
      }
      const compressed = await compressAudioToMonoWav(rawBlob, setCompressionStatus);
      if (compressed.blob.size > maxBytes) {
        throw new Error('Audio exceeds the 50 MB upload limit. Please use a shorter recording.');
      }
      await onAudioRecorded(compressed.blob, compressed.mimeType);
      setAudioStats({ originalSize: rawBlob.size, compressedSize: compressed.blob.size });
    } catch (err: any) {
      setAudioError(err.message || 'Could not save audio');
    } finally {
      setIsCompressing(false);
      setCompressionStatus('');
    }
  };

  const startRecording = async () => {
    audioChunksRef.current = [];
    setAudioError(null);

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      
      // Select appropriate MIME Type and add standard speech-optimized audio compression
      let options: MediaRecorderOptions = { mimeType: 'audio/webm', audioBitsPerSecond: 16000 };
      if (!MediaRecorder.isTypeSupported('audio/webm')) {
        options = { mimeType: 'audio/ogg', audioBitsPerSecond: 16000 };
      }
      if (!MediaRecorder.isTypeSupported('audio/ogg')) {
        options = { audioBitsPerSecond: 16000 }; // fallback with low bitrate
      }

      const mediaRecorder = new MediaRecorder(stream, options);
      mediaRecorderRef.current = mediaRecorder;

      mediaRecorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
          audioChunksRef.current.push(event.data);
        }
      };

      mediaRecorder.onstop = () => {
        const mimeType = mediaRecorder.mimeType || 'audio/webm';
        const audioBlob = new Blob(audioChunksRef.current, { type: mimeType });
        
        processAndSaveAudio(audioBlob, mimeType);
        
        // Stop all stream tracks to release microphone
        stream.getTracks().forEach(track => track.stop());
      };

      mediaRecorder.start(250); // Get chunks every 250ms
      setIsRecording(true);

    } catch (err: any) {
      console.error('Microphone access denied:', err);
      setAudioError('Unable to access microphone. Please enable microphone permissions.');
    }
  };

  const stopRecording = () => {
    if (mediaRecorderRef.current && isRecording) {
      mediaRecorderRef.current.stop();
      setIsRecording(false);
    }

  };

  // Drag and drop / Manual file selection handler
  const handleFileUpload = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (file) {
      setAudioError(null);
      if (!file.type.startsWith('audio/')) {
        setAudioError('Invalid file type. Please select an audio file (e.g. MP3, WAV, WebM).');
        return;
      }

      // Support large conversation audio files (up to 500MB) using backend stream-upload and Gemini File API
      if (file.size > 500 * 1024 * 1024) {
        setAudioError('Selected audio file is too large (above 500MB). Please select a smaller or compressed audio file.');
        return;
      }

      // Process and downsample the uploaded audio file
      const originalMime = file.type || 'audio/webm';
      processAndSaveAudio(file, originalMime);
    }
  };

  // Convert seconds to MM:SS format
  const formatTime = (secs: number) => {
    const minutes = Math.floor(secs / 60);
    const seconds = secs % 60;
    return `${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
  };

  return (
    <div className="bg-slate-50/60 border border-slate-200 rounded-lg p-4">
      <div className="flex items-center justify-between mb-3.5">
        <h3 className="section-heading">Conversation audio</h3>
        {hasAudio && (
          <button
            onClick={() => {
              setAudioStats(null);
              onClearAudio();
            }}
            className="flex items-center gap-1 text-2xs font-medium text-rose-500 hover:text-rose-600 bg-rose-50/55 px-2 py-1 rounded transition-colors cursor-pointer"
          >
            <Trash2 className="w-3 h-3" /> Reset Audio
          </button>
        )}
      </div>

      {audioError && (
        <div className="bg-red-50 border border-red-100 text-red-600 rounded-lg p-2.5 mb-3.5 flex items-start gap-2 text-xs">
          <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
          <span>{audioError}</span>
        </div>
      )}

      {isCompressing && (
        <div className="bg-brand-50 border border-brand-100 text-brand-700 rounded-lg p-3.5 mb-3.5 flex items-center gap-3 text-xs animate-pulse">
          <RefreshCw className="w-4 h-4 text-brand-600 animate-spin shrink-0" />
          <div>
            <span className="font-semibold">Optimizing Audio:</span> {compressionStatus || "Optimizing clinical audio..."}
          </div>
        </div>
      )}

      {isCompressing ? (
        <div className="flex flex-col items-center justify-center py-6 bg-slate-50 border border-slate-100 rounded-lg text-xs text-slate-500 font-medium space-y-2">
          <RefreshCw className="w-5 h-5 text-brand-500 animate-spin" />
          <span>Optimizing audio size to fit within secure pipeline limits...</span>
        </div>
      ) : !hasAudio ? (
        <div className="flex flex-col sm:flex-row sm:items-center gap-3">
          {/* Record Section */}
          <div className="flex items-center gap-3 w-full md:w-auto">
            {isRecording ? (
              <button
                onClick={stopRecording}
                className="flex items-center justify-center gap-2 bg-rose-500 hover:bg-rose-600 text-white font-medium px-4 py-2.5 rounded-lg shadow-sm hover:shadow transition-all w-full md:w-auto animate-pulse cursor-pointer"
              >
                <Square className="w-4 h-4 fill-white" />
                <span className="text-sm">Stop ({formatTime(recordingTime)})</span>
              </button>
            ) : (
              <button
                onClick={startRecording}
                className="btn btn-secondary w-full sm:w-auto"
              >
                <Mic className="w-4 h-4" />
                <span>Record Speech</span>
              </button>
            )}

            {isRecording && (
              <div className="flex items-center gap-1.5 px-3 py-1 bg-rose-50 border border-rose-100 rounded-full animate-bounce">
                <span className="w-2 h-2 rounded-full bg-rose-500"></span>
                <span className="text-2xs font-semibold text-rose-600 uppercase font-sans">Listening...</span>
              </div>
            )}
          </div>

          <div className="text-slate-500 text-xs hidden sm:block">or</div>

          {/* Upload File Section */}
          <div className="w-full md:w-auto relative">
            <input
              type="file"
              accept="audio/*"
              onChange={handleFileUpload}
              className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
              id="audio-upload-input"
            />
            <label
              htmlFor="audio-upload-input"
              className="btn btn-secondary w-full sm:w-auto"
            >
              <Upload className="w-4 h-4" />
              <span>Upload Audio File</span>
            </label>
          </div>
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          {audioUrl && (
            <div className="space-y-2">
              <div className="flex items-center gap-3 bg-white border border-slate-100 rounded-lg p-2.5">
                <div className="p-2 bg-brand-50 text-brand-600 rounded-lg">
                  <Volume2 className="w-4 h-4" />
                </div>
                <audio src={audioUrl} controls className="flex-1 h-8 max-w-full" />
              </div>
              
              {audioStats && (
                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-1 text-2xs font-mono bg-emerald-50/50 border border-emerald-100/40 rounded-lg px-3 py-2 text-emerald-800">
                  <div className="flex items-center gap-1">
                    <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse"></span>
                    <span className="font-semibold text-emerald-900">Audio size reduced</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="line-through text-slate-500">{(audioStats.originalSize / (1024 * 1024)).toFixed(2)} MB</span>
                    <span>→</span>
                    <span className="font-semibold text-emerald-700">{(audioStats.compressedSize / (1024 * 1024)).toFixed(2)} MB</span>
                    <span className="bg-emerald-100 text-emerald-900 text-2xs font-semibold px-1 py-0.2 rounded">
                      -{Math.round((1 - audioStats.compressedSize / audioStats.originalSize) * 100)}% Size
                    </span>
                  </div>
                </div>
              )}
            </div>
          )}

        </div>
      )}
    </div>
  );
}
