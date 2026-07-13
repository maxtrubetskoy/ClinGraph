/**
 * Decodes an audio file (using Web Audio API) and downsamples/converts it 
 * to a lightweight mono WAV file so that even 1-hour conversations
 * are small enough to upload (safely below Cloud Run's 32MB payload limit).
 * 
 * Aggressive Adaptive Compression Engine:
 * - Under 3 minutes: 16,000 Hz 16-bit Mono (~1.92MB per minute, pristine high-fidelity)
 * - 3 to 10 minutes: 12,000 Hz 16-bit Mono (~1.44MB per minute, great high-fidelity)
 * - 10 to 25 minutes: 11,025 Hz 8-bit Mono (~660KB per minute, high-efficiency)
 * - Over 25 minutes: 8,000 Hz 8-bit Mono (~480KB per minute, ultra-compressed telephone quality)
 */
export async function compressAudioToMonoWav(
  file: Blob, 
  onProgress?: (msg: string) => void
): Promise<{ blob: Blob; mimeType: string; originalSize: number; compressedSize: number }> {
  const AudioContextClass = window.AudioContext || (window as any).webkitAudioContext;
  if (!AudioContextClass) {
    throw new Error("Web Audio API is not supported in this browser.");
  }

  const originalSize = file.size;
  onProgress?.("Decoding clinical audio stream...");
  const audioCtx = new AudioContextClass();
  const fileArrayBuffer = await file.arrayBuffer();
  
  let audioBuffer: AudioBuffer;
  try {
    audioBuffer = await audioCtx.decodeAudioData(fileArrayBuffer);
  } catch (decodeError) {
    console.warn("Audio decoding failed, returning original file as-is:", decodeError);
    audioCtx.close();
    return { blob: file, mimeType: file.type, originalSize, compressedSize: file.size };
  }

  const durationMin = audioBuffer.duration / 60;
  let targetSampleRate = 16000;
  let bitsPerSample = 16;
  
  if (durationMin >= 25) {
    targetSampleRate = 8000;
    bitsPerSample = 8;
    onProgress?.(`Audio is very long (${Math.ceil(durationMin)} mins). Compress-scaling to 8kHz 8-bit mono...`);
  } else if (durationMin >= 10) {
    targetSampleRate = 11025;
    bitsPerSample = 8;
    onProgress?.(`Audio is long (${Math.ceil(durationMin)} mins). Downsampling to 11kHz 8-bit mono...`);
  } else if (durationMin >= 3) {
    targetSampleRate = 12000;
    bitsPerSample = 16;
    onProgress?.(`Audio is moderate (${Math.ceil(durationMin)} mins). Setting to 12kHz 16-bit mono...`);
  } else {
    onProgress?.("Pruning short audio to 16kHz 16-bit mono...");
  }

  const numberOfChannels = 1; // Mono
  const OfflineAudioContextClass = window.OfflineAudioContext || (window as any).webkitOfflineAudioContext;
  
  // Create OfflineAudioContext for downsampling
  const offlineCtx = new OfflineAudioContextClass(
    numberOfChannels,
    Math.round(audioBuffer.duration * targetSampleRate),
    targetSampleRate
  );

  // Set up source node
  const source = offlineCtx.createBufferSource();
  source.buffer = audioBuffer;
  source.connect(offlineCtx.destination);
  source.start();

  // Render the audio
  const renderedBuffer = await offlineCtx.startRendering();
  audioCtx.close();

  onProgress?.(`Encoding to secure ${bitsPerSample}-bit WAV layout...`);
  
  const wavBlob = bitsPerSample === 8 
    ? encodeWAV8BitMono(renderedBuffer)
    : encodeWAV16BitMono(renderedBuffer);
  
  return {
    blob: wavBlob,
    mimeType: "audio/wav",
    originalSize,
    compressedSize: wavBlob.size
  };
}

function encodeWAV8BitMono(audioBuffer: AudioBuffer): Blob {
  const channelData = audioBuffer.getChannelData(0); // Only channel 0
  const sampleRate = audioBuffer.sampleRate;
  const bytesPerSample = 1; // 8-bit
  const blockAlign = bytesPerSample;
  
  const buffer = new ArrayBuffer(44 + channelData.length * bytesPerSample);
  const view = new DataView(buffer);

  /* RIFF identifier */
  writeString(view, 0, 'RIFF');
  /* file length */
  view.setUint32(4, 36 + channelData.length * bytesPerSample, true);
  /* RIFF type */
  writeString(view, 8, 'WAVE');
  /* format chunk identifier */
  writeString(view, 12, 'fmt ');
  /* format chunk length */
  view.setUint32(16, 16, true);
  /* sample format (raw PCM) */
  view.setUint16(20, 1, true);
  /* channel count (1 = mono) */
  view.setUint16(22, 1, true);
  /* sample rate */
  view.setUint32(24, sampleRate, true);
  /* byte rate (sample rate * block align) */
  view.setUint32(28, sampleRate * blockAlign, true);
  /* block align (channel count * bytes per sample) */
  view.setUint16(32, blockAlign, true);
  /* bits per sample (8) */
  view.setUint16(34, 8, true);
  /* data chunk identifier */
  writeString(view, 36, 'data');
  /* data chunk length */
  view.setUint32(40, channelData.length * bytesPerSample, true);

  // Write 8-bit unsigned PCM audio samples (Float32 [-1.0, 1.0] -> Uint8 [0, 255])
  let offset = 44;
  for (let i = 0; i < channelData.length; i++) {
    let sample = channelData[i];
    if (sample > 1) sample = 1;
    else if (sample < -1) sample = -1;
    
    // Silence is exactly 128
    const unsignedSample = Math.round((sample + 1.0) * 127.5);
    view.setUint8(offset, Math.min(255, Math.max(0, unsignedSample)));
    offset += bytesPerSample;
  }

  return new Blob([buffer], { type: 'audio/wav' });
}

function encodeWAV16BitMono(audioBuffer: AudioBuffer): Blob {
  const channelData = audioBuffer.getChannelData(0); // Only channel 0
  const sampleRate = audioBuffer.sampleRate;
  const bytesPerSample = 2; // 16-bit
  const blockAlign = bytesPerSample;
  
  const buffer = new ArrayBuffer(44 + channelData.length * bytesPerSample);
  const view = new DataView(buffer);

  /* RIFF identifier */
  writeString(view, 0, 'RIFF');
  /* file length */
  view.setUint32(4, 36 + channelData.length * bytesPerSample, true);
  /* RIFF type */
  writeString(view, 8, 'WAVE');
  /* format chunk identifier */
  writeString(view, 12, 'fmt ');
  /* format chunk length */
  view.setUint32(16, 16, true);
  /* sample format (raw PCM) */
  view.setUint16(20, 1, true);
  /* channel count (1 = mono) */
  view.setUint16(22, 1, true);
  /* sample rate */
  view.setUint32(24, sampleRate, true);
  /* byte rate (sample rate * block align) */
  view.setUint32(28, sampleRate * blockAlign, true);
  /* block align (channel count * bytes per sample) */
  view.setUint16(32, blockAlign, true);
  /* bits per sample (16) */
  view.setUint16(34, 16, true);
  /* data chunk identifier */
  writeString(view, 36, 'data');
  /* data chunk length */
  view.setUint32(40, channelData.length * bytesPerSample, true);

  // Write PCM audio samples (Float32 [-1.0, 1.0] -> Int16 [-32768, 32767])
  let offset = 44;
  for (let i = 0; i < channelData.length; i++) {
    let sample = channelData[i];
    if (sample > 1) sample = 1;
    else if (sample < -1) sample = -1;
    
    const intSample = sample < 0 ? sample * 0x8000 : sample * 0x7FFF;
    view.setInt16(offset, intSample, true);
    offset += bytesPerSample;
  }

  return new Blob([buffer], { type: 'audio/wav' });
}

function writeString(view: DataView, offset: number, str: string) {
  for (let i = 0; i < str.length; i++) {
    view.setUint8(offset + i, str.charCodeAt(i));
  }
}
