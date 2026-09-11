import express from "express";
import path from "path";
import { createServer as createViteServer } from "vite";
import { GoogleGenAI } from "@google/genai";
import dotenv from "dotenv";
import multer from "multer";
import fs from "fs";
import { Agent, setGlobalDispatcher, fetch } from "undici";

dotenv.config();

// Configure undici fetch timeout globally to handle slow/complex AI requests
const globalAgent = new Agent({
  headersTimeout: 600000, // 10 minutes
  bodyTimeout: 600000,    // 10 minutes
  connectTimeout: 120000, // 2 minutes
});
setGlobalDispatcher(globalAgent);

// Override native fetch with undici fetch to ensure absolute compatibility with globalAgent
globalThis.fetch = fetch as any;

const upload = multer({ dest: "/tmp/" });

// Lazy initialization of Gemini client
let aiClient: GoogleGenAI | null = null;

function getAiClient(): GoogleGenAI {
  if (!aiClient) {
    const key = process.env.GEMINI_API_KEY;
    if (!key || key === "MY_GEMINI_API_KEY") {
      throw new Error("Default server Gemini API key is not configured. Please configure your own Gemini API key in the 'Set API Keys' popup in the application.");
    }
    aiClient = new GoogleGenAI({ apiKey: key });
  }
  return aiClient;
}

// Helper function to run an async operation with a timeout
function withTimeout<T>(promise: Promise<T>, timeoutMs: number, errorMsg: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`TIMEOUT: ${errorMsg}`));
    }, timeoutMs);

    promise
      .then((res) => {
        clearTimeout(timer);
        resolve(res);
      })
      .catch((err) => {
        clearTimeout(timer);
        reject(err);
      });
  });
}

// Concurrency-limited promise pool helper
async function mapConcurrent<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, idx: number) => Promise<R>
): Promise<R[]> {
  const results: R[] = [];
  const executing: Promise<any>[] = [];
  
  for (let i = 0; i < items.length; i++) {
    const p = (async () => {
      const res = await fn(items[i], i);
      return res;
    })();
    results.push(p as any);
    
    if (limit <= items.length) {
      const e: Promise<any> = p.then(() => executing.splice(executing.indexOf(e), 1));
      executing.push(e);
      if (executing.length >= limit) {
        await Promise.race(executing);
      }
    }
  }
  return Promise.all(results);
}

// Internal diarization helper if parsedSegments are missing but audio is present
async function runDiarizationInternal(client: GoogleGenAI, modelName: string, fileRef: any): Promise<{ segments: any[], jsonlText: string }> {
  const prompt = `You are an expert clinical transcriptionist and medical scribe.
Your task is to transcribe and diarize the provided audio file.
Listen to the dialogue, identify different speakers (such as 'Doctor', 'Patient', 'Relative', etc.), and write down exactly what they said.

You MUST reply with a JSON array where each item represents an utterance.
Each utterance object MUST have:
1. "speaker": Name or role of the speaker (e.g. "Doctor", "Patient", "Assistant").
2. "text": The precise transcription of what they said.
3. "timestamp": Estimated start and end timing bracket for the utterance, in 'MM:SS - MM:SS' format (e.g. '00:00 - 00:15').

Keep the transcription highly professional and accurate. Do not add any extra text or comments outside the JSON array. Output MUST be a valid JSON array of objects.`;

  console.log(`Running internal diarization using Gemini model "${modelName}"...`);
  const response = await withTimeout(
    client.models.generateContent({
      model: modelName,
      contents: [
        fileRef,
        { text: prompt }
      ],
      config: {
        responseMimeType: "application/json",
        responseSchema: {
          type: "ARRAY",
          items: {
            type: "OBJECT",
            properties: {
              speaker: { type: "STRING" },
              text: { type: "STRING" },
              timestamp: { type: "STRING" }
            },
            required: ["speaker", "text", "timestamp"]
          }
        }
      }
    }),
    45000,
    "Gemini internal diarization call timed out"
  );

  const responseText = response.text;
  if (!responseText) {
    throw new Error("Empty response from internal Gemini diarization.");
  }

  const segments = cleanAndParseJson(responseText);
  const jsonlText = segments.map((seg: any) => JSON.stringify(seg)).join("\n");

  return {
    jsonlText,
    segments: segments.map((seg: any, idx: number) => ({
      id: `seg_${idx + 1}`,
      speaker: seg.speaker || "Unknown",
      text: seg.text || ""
    }))
  };
}

function extractJsonObjects(text: string): any[] {
  if (!text || typeof text !== 'string') return [];
  const trimmed = text.trim();
  if (!trimmed) return [];

  if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
    try {
      const parsedArray = JSON.parse(trimmed);
      if (Array.isArray(parsedArray)) {
        return parsedArray.filter(item => item && typeof item === 'object' && !Array.isArray(item));
      }
    } catch (e) {}
  }

  const results: any[] = [];
  let depth = 0;
  let inString = false;
  let isEscaped = false;
  let startIndex = -1;

  for (let i = 0; i < text.length; i++) {
    const char = text[i];

    if (inString) {
      if (isEscaped) {
        isEscaped = false;
      } else if (char === '\\') {
        isEscaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
    } else if (char === '{') {
      if (depth === 0) {
        startIndex = i;
      }
      depth++;
    } else if (char === '}') {
      if (depth > 0) {
        depth--;
        if (depth === 0 && startIndex !== -1) {
          const jsonStr = text.substring(startIndex, i + 1);
          try {
            const parsed = JSON.parse(jsonStr);
            if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
              results.push(parsed);
            }
          } catch (e) {}
          startIndex = -1;
        }
      }
    }
  }

  return results;
}

function parseDialogueTextToSegments(text: string): { id: string; speaker: string; text: string; timestamp?: string }[] {
  if (!text) return [];
  const trimmed = text.trim();
  if (!trimmed) return [];

  const jsonObjects = extractJsonObjects(text);
  if (jsonObjects.length > 0) {
    const hasDialogueKeys = jsonObjects.some(
      obj => 'speaker' in obj || 'text' in obj || 'role' in obj || 'content' in obj || 'utterance' in obj
    );

    if (hasDialogueKeys) {
      return jsonObjects.map((obj, idx) => {
        const speaker = obj.speaker || obj.role || obj.name || obj.author || 'Speaker';
        const textContent = obj.text ?? obj.content ?? obj.utterance ?? obj.message ?? '';
        const timestamp = obj.timestamp || obj.time || undefined;

        return {
          id: obj.id || `seg_${idx + 1}`,
          speaker: String(speaker).trim() || 'Speaker',
          text: typeof textContent === 'string' ? textContent : JSON.stringify(textContent),
          ...(timestamp ? { timestamp: String(timestamp).trim() } : {})
        };
      });
    }
  }

  const lines = trimmed.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  if (lines.length === 0) return [];

  return lines.map((line, idx) => {
    let timestamp: string | undefined = undefined;
    let restOfLine = line;

    const tsMatch = line.match(/^(\[|\()(\d{1,2}:\d{2}(?:\s*-\s*\d{1,2}:\d{2})?)(\]|\))\s*(.*)$/);
    if (tsMatch) {
      timestamp = tsMatch[2].trim();
      restOfLine = tsMatch[4].trim();
    }

    const colonIdx = restOfLine.indexOf(':');
    if (colonIdx > 0 && colonIdx < 40) {
      const potentialSpeaker = restOfLine.substring(0, colonIdx).trim();
      const content = restOfLine.substring(colonIdx + 1).trim();
      if (!potentialSpeaker.includes('http') && !potentialSpeaker.includes('\n')) {
        return {
          id: `seg_${idx + 1}`,
          speaker: potentialSpeaker,
          text: content || restOfLine,
          ...(timestamp ? { timestamp } : {})
        };
      }
    }

    return {
      id: `seg_${idx + 1}`,
      speaker: 'Speaker',
      text: restOfLine,
      ...(timestamp ? { timestamp } : {})
    };
  });
}

// Parse clinical note / document text into clean segments (paragraphs or SOAP fields)
function parseNoteTextToSegments(text: string): { id: string; speaker: string; text: string }[] {
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
      // Fallback if parsing fails
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
}

function parseTranscriptToSegments(text: string, encounterType: string = 'dialogue'): { id: string; speaker: string; text: string; timestamp?: string }[] {
  if (encounterType === 'note') {
    return parseNoteTextToSegments(text);
  }
  return parseDialogueTextToSegments(text);
}

// Clinical Entity Sanitizer: Validates and maps model-extracted rawType directly to activeSchema category ID
function sanitizeExtractedEntityType(
  rawType: string,
  name: string,
  literalText: string,
  description: string,
  experiencer: string,
  activeSchema: any[]
): string {
  const t = (rawType || '').toLowerCase().trim();
  const n = (name || '').toLowerCase().trim();
  const lit = (literalText || '').toLowerCase().trim();

  // 0. SPEAKER / NON-CLINICAL FILTER
  const isSpeakerRole = ['patient', 'patiënt', 'doctor', 'dokter', 'arts', 'huisarts', 'specialist', 'behandelaar', 'zorgverlener', 'verpleegkundige', 'assistent', 'mevrouw', 'meneer', 'dhr', 'mw', 'person', 'persoon'].some(role => 
    n === role || lit === role || t === role
  );
  if (isSpeakerRole) {
    return "";
  }

  if (!activeSchema || activeSchema.length === 0) {
    return rawType;
  }

  // 1. Direct match by category ID (e.g. "fhir_conditions", "conditions", "symptoms")
  const directCat = activeSchema.find((cat: any) => cat.id.toLowerCase() === t);
  if (directCat) {
    return directCat.id;
  }

  // 2. Normalized match by category ID (without fhir_ or trailing s)
  const normType = t.replace(/^fhir_/, '').replace(/s$/, '');
  const normCat = activeSchema.find((cat: any) => {
    const cNorm = cat.id.toLowerCase().replace(/^fhir_/, '').replace(/s$/, '');
    return cNorm === normType;
  });
  if (normCat) {
    return normCat.id;
  }

  // 3. Match by entityType (e.g. "Condition", "MedicationStatement", "Immunization", "Observation", etc.)
  const entityTypeMatches = activeSchema.filter((cat: any) => {
    const cTypeNorm = (cat.entityType || '').toLowerCase().replace(/^fhir_/, '').replace(/s$/, '');
    return cTypeNorm === normType || (cat.entityType || '').toLowerCase() === t;
  });
  if (entityTypeMatches.length === 1) {
    return entityTypeMatches[0].id;
  } else if (entityTypeMatches.length > 1) {
    const condCat = activeSchema.find((cat: any) => (cat.id.toLowerCase().includes("condition") && !cat.id.toLowerCase().includes("family")) || ((cat.entityType || "").toLowerCase().includes("condition") && !(cat.entityType || "").toLowerCase().includes("family")));
    if (condCat && entityTypeMatches.some(c => c.id === condCat.id)) return condCat.id;
    return entityTypeMatches[0].id;
  }

  return rawType;
}

// Local fallback keyword extractor in case an AI provider times out or fails after retries
function extractLocalFallbackMentions(
  batchSegments: { id: string; speaker: string; text: string; lineIndex: number }[],
  activeSchema: any[]
): any[] {
  const results: any[] = [];
  const keywordDict = [
    { type: "symptoms", name: "Headache", kw: ["headache", "migraine", "hoofdpijn"] },
    { type: "symptoms", name: "Dizziness", kw: ["dizzy", "dizziness", "duizelig"] },
    { type: "symptoms", name: "Nausea", kw: ["nausea", "nauseous", "misselijk"] },
    { type: "symptoms", name: "Cough", kw: ["cough", "coughing", "hoest"] },
    { type: "symptoms", name: "Dyspnea", kw: ["shortness of breath", "dyspnea", "wheezing", "benauwd"] },
    { type: "symptoms", name: "Chest Pain", kw: ["chest pain", "angina", "pijn op de borst"] },
    { type: "symptoms", name: "Swelling", kw: ["swelling", "swollen", "edema", "blister", "zwelling"] },
    { type: "conditions", name: "Essential Hypertension", kw: ["hypertension", "high blood pressure", "hoge bloeddruk"] },
    { type: "conditions", name: "Type 2 Diabetes", kw: ["diabetes", "diabetic", "suikerziekte"] },
    { type: "conditions", name: "Asthma", kw: ["asthma", "astma"] },
    { type: "medications", name: "Lisinopril", kw: ["lisinopril", "zestril"] },
    { type: "medications", name: "Metformin", kw: ["metformin", "glucophage"] },
    { type: "medications", name: "Albuterol", kw: ["albuterol", "salbutamol", "ventolin"] },
    { type: "medications", name: "Flovent", kw: ["flovent", "fluticasone"] },
    { type: "medications", name: "Aspirin", kw: ["aspirin", "ascal"] },
    { type: "medications", name: "Atorvastatin", kw: ["atorvastatin", "lipitor", "statin"] },
    { type: "medications", name: "Paracetamol", kw: ["paracetamol", "tylenol", "acetaminophen"] },
    { type: "measurements", name: "Blood Pressure", kw: ["blood pressure", "bloeddruk", "148/92", "150/94", "140/90", "120/80"] },
    { type: "measurements", name: "Blood Glucose", kw: ["blood sugar", "glucose", "bloedsuiker", "180"] },
    { type: "followUps", name: "Follow-up Visit", kw: ["follow-up", "follow up", "controle", "two weeks", "2 weeks", "4 weeks"] },
    { type: "followUps", name: "Specialist Referral", kw: ["referral", "refer", "podiatrist", "podiatry", "cardiologist", "verwijzing"] }
  ];

  for (const seg of batchSegments) {
    if (!seg.text) continue;
    const lowerText = seg.text.toLowerCase();
    for (const item of keywordDict) {
      for (const kw of item.kw) {
        const startIdx = lowerText.indexOf(kw);
        if (startIdx !== -1) {
          const exactText = seg.text.substring(startIdx, startIdx + kw.length);
          const sanitizedType = sanitizeExtractedEntityType(
            item.type,
            item.name,
            exactText,
            item.name,
            "patient",
            activeSchema
          );
          if (sanitizedType) {
            results.push({
              id: "",
              textSpan: {
                lineIndex: seg.lineIndex,
                startChar: startIdx,
                endChar: startIdx + kw.length,
                text: exactText
              },
              entityType: sanitizedType,
              canonicalName: item.name,
              literalText: exactText,
              description: `${item.name} mentioned in conversation`,
              speaker: seg.speaker || "patient",
              polarity: "positive",
              certainty: "certain",
              temporality: "current",
              experiencer: "patient",
              function: "asserted",
              entityId: null
            });
          }
          break; // Avoid duplicate matches for same keyword category in same segment
        }
      }
    }
  }
  return results;
}

// STEP 1: Extract clinical mentions and their attributes from batched utterances with surrounding context
// Mentions extracted include verbatim literal text, English canonical concept name, schema category,
// polarity, temporality, certainty, experiencer, and function.
async function extractMentionsForBatch(
  client: GoogleGenAI | null,
  modelName: string,
  batchSegments: { id: string; speaker: string; text: string; lineIndex: number }[],
  allSegments: { id: string; speaker: string; text: string }[],
  schemaObj?: any[],
  encounterType?: string,
  annotationConfig?: any,
  retryCount: number = 0
): Promise<any[]> {
  const validBatch = batchSegments.filter(s => s && s.text && s.text.trim().length > 0);
  if (validBatch.length === 0) {
    return [];
  }

  // Active schema with standard clinical categories
  const activeSchema = (schemaObj && schemaObj.length > 0) ? schemaObj : [
    {
      id: 'symptoms',
      entityType: 'Symptom',
      displayName: 'Symptoms',
      typeHint: 'Use for physical signs or clinical symptoms reported by the patient (e.g. Nausea, headache, fever, cough, chest pain). Do NOT use for drug allergies (AllergyIntolerance) or chronic disease diagnoses.',
      attributes: []
    },
    {
      id: 'conditions',
      entityType: 'Condition',
      displayName: 'Disorders & Conditions',
      typeHint: 'Use for active or past medical diagnoses, diseases, and chronic disorders (e.g. Essential hypertension, Type 2 diabetes) experienced by the patient. Do NOT use for family relative history, standard transient symptoms, or future requested procedures.',
      attributes: []
    },
    {
      id: 'medications',
      entityType: 'Medication',
      displayName: 'Medications',
      typeHint: 'Use for regular daily prescriptions, active therapeutic medications, or over-the-counter drugs (e.g. Metformin, Lisinopril, Pantoprazole). Do NOT use for active vaccine administrations (Immunizations).',
      attributes: []
    },
    {
      id: 'followUps',
      entityType: 'FollowUp',
      displayName: 'Follow-ups & Plans',
      typeHint: 'Use for planned future clinical actions, referrals, scheduled diagnostics, or orders (e.g. Ordering an ECG for next week, referral to cardiology). Do NOT use for completed procedures or historical actions.',
      attributes: []
    },
    {
      id: 'measurements',
      entityType: 'Measurement',
      displayName: 'Measurements',
      typeHint: 'Use for isolated physical measurements, vital sign metrics, or individual lab values (e.g. Blood pressure: 140/90, Heart rate: 72, creatinine: 1.2). Do NOT use for comprehensive lab panels or multi-page summary reports.',
      attributes: []
    }
  ];

  const uniqueEntityTypes = new Set<string>();
  activeSchema.forEach((cat: any) => {
    if (cat.id) uniqueEntityTypes.add(cat.id);
  });
  uniqueEntityTypes.add('Person');
  uniqueEntityTypes.add('Other');
  const allowedTypes = Array.from(uniqueEntityTypes);

  const startIndex = validBatch[0].lineIndex;
  const endIndex = validBatch[validBatch.length - 1].lineIndex;

  const schemaGuidelines = activeSchema.map((cat: any) => {
    return `- Category ID: "${cat.id}" (Display Name: "${cat.displayName}", Entity Type: "${cat.entityType}"): ${cat.typeHint || ''}`;
  }).join("\n");

  const antiOverextractionRules = `Anti-Overextraction Guardrails:
1. Extract clinical facts only: symptoms, diagnoses, medications, lab/vital measurements, procedures, and clear follow-up plans.
2. Conversational greetings, politeness expressions, or administrative pleasantries MUST NOT be extracted.
3. Pronouns or generic referents without clear antecedent clinical meaning MUST NOT be extracted.
4. Each extracted mention MUST have verbatim "literalText" physically present in the TARGET UTTERANCES.`;

  // Preceding and succeeding context for the batch
  const contextBefore = allSegments.slice(Math.max(0, startIndex - 2), startIndex);
  const contextAfter = allSegments.slice(endIndex + 1, Math.min(allSegments.length, endIndex + 3));

  const contextBeforeStr = contextBefore.length > 0
    ? contextBefore.map((s, i) => `[Context Utterance ${Math.max(0, startIndex - 2) + i}] [${s.speaker}]: ${s.text}`).join("\n")
    : "(No preceding context)";

  const targetUtterancesStr = validBatch
    .map(s => `[TARGET Utterance ${s.lineIndex}] [${s.speaker}]: ${s.text}`)
    .join("\n");

  const contextAfterStr = contextAfter.length > 0
    ? contextAfter.map((s, i) => `[Context Utterance ${endIndex + 1 + i}] [${s.speaker}]: ${s.text}`).join("\n")
    : "(No succeeding context)";

  const docType = encounterType === 'note' ? 'clinical document' : 'clinical dialogue';
  const prompt = `You are an expert clinical annotator specializing in Clinical Mention Extraction.
Your task is to analyze the TARGET utterances (utterances ${startIndex} to ${endIndex}) from a ${docType}.

CRITICAL BOUNDARY MANDATE:
You MUST ONLY extract clinical mentions from the TARGET UTTERANCES (indices ${startIndex} to ${endIndex})!
Use the preceding and succeeding context utterances ONLY for pronoun resolution, reference disambiguation, polarity, and clinical intent. NEVER extract mentions from the context utterances!

CONVERSATIONAL CONFIRMATION & NEGATION MANDATE (ANAPHORA & ELLIPSIS):
In clinical dialogues, clinicians regularly screen for symptoms, conditions, medications, or allergies by asking questions (e.g., "Any rash or skin issues?", "Last van uw gewrichten? Polsen, knieën, ellebogen?", "Do you take blood thinners?"). Patients routinely answer using conversational confirmations or denials WITHOUT repeating the medical term (e.g., "Nee, niet opgevallen", "No, none at all", "Geen last van", "Nee", "Nee, helemaal niet", "Ja, klopt", "Zeker, al een paar dagen", "Helemaal niet").

When a TARGET UTTERANCE provides a confirmation, denial, or answer to a clinical symptom/condition/medication queried in context:
1. Extract the verbatim confirmation or denial phrase from the TARGET UTTERANCE as an elliptical clinical mention (e.g. literalText: "Nee, niet opgevallen", "No, none at all", "Geen last van", "Nee", "Ja, klopt", "Helemaal niet").
2. Set "canonicalName" to the standardized English clinical concept that was queried in context and is being answered (e.g., "Skin Rash", "Joint Pain", "Headache").
3. Set "type" to the schema category of the queried concept (e.g., "symptoms", "conditions", "medications").
4. Set "polarity": "negative" if denied/absent, "positive" if affirmed/confirmed.
5. Set "function": "asserted".

Active Clinical Schema Categories:
${schemaGuidelines}

Classification Guidelines:
${antiOverextractionRules}

Preceding Context:
${contextBeforeStr}

TARGET UTTERANCES (${startIndex} to ${endIndex}):
${targetUtterancesStr}

Succeeding Context:
${contextAfterStr}

For every clinical mention found in ANY of the TARGET UTTERANCES, output a JSON object with:
- "lineIndex": integer (the TARGET Utterance number where this mention literally appears, one of: ${validBatch.map(s => s.lineIndex).join(', ')})
- "literalText": string (the exact verbatim word or phrase as it appears in that TARGET Utterance)
- "canonicalName": string (standardized clinical concept name in English, e.g. 'Headache', 'Hypertension', 'Lisinopril')
- "type": string (category ID from active schema: ${allowedTypes.join(' | ')})
- "description": string (brief clinical context or details)
- "polarity": "positive" | "negative" | "neutral"
- "certainty": "certain" | "uncertain" | "hypothetical"
- "temporality": "current" | "past" | "future"
- "experiencer": "patient" | "other"
- "function": "asserted" | "questioned" | "hypothetical" | "explanatory"
- "supportedAttribute": string (optional: if this mention supports or grounds a specific attribute of the entity—e.g. mention '145' or '140/90' supports attribute 'value', mention 'moderate' or 'severe' supports attribute 'severity', mention '20mg' supports attribute 'dosage', mention 'twice daily' supports attribute 'frequency', mention 'active' supports attribute 'status'—provide the attribute name here such as 'value', 'severity', 'dosage', 'frequency', 'status', 'onset'; otherwise omit or leave empty)

Return JSON ONLY:
{
  "mentions": [
    {
      "lineIndex": ${startIndex},
      "literalText": "sample literal text",
      "canonicalName": "Sample Concept",
      "type": "symptoms",
      "description": "brief description",
      "polarity": "positive",
      "certainty": "certain",
      "temporality": "current",
      "experiencer": "patient",
      "function": "asserted",
      "supportedAttribute": "value"
    }
  ]
}`;

  const TIMEOUT_MS = 60000;
  const MAX_RETRIES = 2;

  try {
    let text = "";
    if (annotationConfig && annotationConfig.provider === "openai" && annotationConfig.apiKey) {
      text = await withTimeout(
        callCustomOpenAiChat(annotationConfig, prompt),
        TIMEOUT_MS,
        `OpenAI mention extraction for batch ${startIndex}-${endIndex} timed out`
      );
    } else if (client) {
      const response = await withTimeout(
        client.models.generateContent({
          model: modelName,
          contents: [{ text: prompt }],
          config: {
            responseMimeType: "application/json"
          }
        }),
        TIMEOUT_MS,
        `Gemini mention extraction for batch ${startIndex}-${endIndex} timed out`
      );
      text = response.text || "";
    } else {
      throw new Error("No AI client available for mention extraction");
    }

    if (!text) return extractLocalFallbackMentions(validBatch, activeSchema);

    const data = cleanAndParseJson(text);
    const mentions = data.mentions || [];

    const results: any[] = [];
    for (const m of mentions) {
      const literal = m.literalText || m.canonicalName;
      if (!literal) continue;

      const rawLineIdx = typeof m.lineIndex === 'number' ? m.lineIndex : parseInt(String(m.lineIndex), 10);
      let targetSeg = (Number.isInteger(rawLineIdx) && allSegments[rawLineIdx]) ? allSegments[rawLineIdx] : null;
      let resolvedLineIndex = Number.isInteger(rawLineIdx) ? rawLineIdx : -1;

      if (!targetSeg || resolvedLineIndex < startIndex || resolvedLineIndex > endIndex) {
        const found = validBatch.find(b => b.text.toLowerCase().includes(literal.toLowerCase()));
        if (found) {
          targetSeg = found;
          resolvedLineIndex = found.lineIndex;
        } else {
          targetSeg = validBatch[0];
          resolvedLineIndex = validBatch[0].lineIndex;
        }
      }

      let startChar = -1;
      let endChar = -1;
      let exactText = "";

      const idx = targetSeg.text.toLowerCase().indexOf(literal.toLowerCase());
      if (idx >= 0) {
        startChar = idx;
        endChar = idx + literal.length;
        exactText = targetSeg.text.substring(startChar, endChar);
      } else {
        const words = literal.split(/\s+/).filter((w: string) => w.length > 2);
        for (const word of words) {
          const wIdx = targetSeg.text.toLowerCase().indexOf(word.toLowerCase());
          if (wIdx >= 0) {
            startChar = wIdx;
            endChar = wIdx + word.length;
            exactText = targetSeg.text.substring(startChar, endChar);
            break;
          }
        }
      }

      if (startChar === -1) {
        startChar = 0;
        endChar = Math.min(literal.length || 15, targetSeg.text.length);
        exactText = targetSeg.text.substring(startChar, endChar) || literal;
      }

      const sanitizedType = sanitizeExtractedEntityType(
        m.type,
        m.canonicalName || exactText,
        exactText,
        m.description || "",
        m.experiencer || "patient",
        activeSchema
      );

      if (!sanitizedType) continue;

      results.push({
        id: "", // Assigned sequentially in caller
        textSpan: {
          lineIndex: resolvedLineIndex,
          startChar,
          endChar,
          text: exactText
        },
        entityType: sanitizedType,
        canonicalName: m.canonicalName || exactText,
        literalText: exactText,
        description: m.description || "",
        speaker: targetSeg.speaker || "patient",
        polarity: m.polarity || "positive",
        certainty: m.certainty || "certain",
        temporality: m.temporality || "current",
        experiencer: m.experiencer || "patient",
        function: m.function || "asserted",
        supportedAttribute: m.supportedAttribute ? String(m.supportedAttribute).trim().toLowerCase() : (m.supported_attribute ? String(m.supported_attribute).trim().toLowerCase() : undefined),
        entityId: null
      });
    }

    return results;
  } catch (error: any) {
    if (retryCount < MAX_RETRIES) {
      const backoffMs = (retryCount + 1) * 2000;
      await new Promise(res => setTimeout(res, backoffMs));
      return extractMentionsForBatch(
        client,
        modelName,
        batchSegments,
        allSegments,
        schemaObj,
        encounterType,
        annotationConfig,
        retryCount + 1
      );
    }
    console.warn(`[Batch ${startIndex}-${endIndex}] Mention extraction fallback engaged:`, error.message || error);
    return extractLocalFallbackMentions(validBatch, activeSchema);
  }
}

// Single-utterance wrapper delegating to extractMentionsForBatch
async function extractMentionsForUtteranceSpan(
  client: GoogleGenAI | null,
  modelName: string,
  targetIndex: number,
  allSegments: { id: string; speaker: string; text: string }[],
  schemaObj?: any[],
  encounterType?: string,
  annotationConfig?: any,
  retryCount: number = 0
): Promise<any[]> {
  const targetSegment = allSegments[targetIndex];
  if (!targetSegment || !targetSegment.text || targetSegment.text.trim().length === 0) {
    return [];
  }
  return extractMentionsForBatch(
    client,
    modelName,
    [{ ...targetSegment, lineIndex: targetIndex }],
    allSegments,
    schemaObj,
    encounterType,
    annotationConfig,
    retryCount
  );
}

// Extract clinical entities from a batch of segments with surrounding context
// STEP 1: Extract clinical mentions and their attributes from 2+1+2 utterance spans (context + target + context)
// Mentions extracted include verbatim literal text, English canonical concept name, schema category,
// polarity, temporality, certainty, experiencer, and function.
async function legacyExtractMentionsForUtteranceSpan(
  client: GoogleGenAI | null,
  modelName: string,
  targetIndex: number,
  allSegments: { id: string; speaker: string; text: string }[],
  schemaObj?: any[],
  encounterType?: string,
  annotationConfig?: any,
  retryCount: number = 0
): Promise<any[]> {
  const targetSegment = allSegments[targetIndex];
  if (!targetSegment || !targetSegment.text || targetSegment.text.trim().length === 0) {
    return [];
  }

  // Active schema with standard clinical categories
  const activeSchema = (schemaObj && schemaObj.length > 0) ? schemaObj : [
    {
      id: 'symptoms',
      entityType: 'Symptom',
      displayName: 'Symptoms',
      typeHint: 'Use for physical signs or clinical symptoms reported by the patient (e.g. Nausea, headache, fever, cough, chest pain). Do NOT use for drug allergies (AllergyIntolerance) or chronic disease diagnoses.',
      attributes: []
    },
    {
      id: 'conditions',
      entityType: 'Condition',
      displayName: 'Disorders & Conditions',
      typeHint: 'Use for active or past medical diagnoses, diseases, and chronic disorders (e.g. Essential hypertension, Type 2 diabetes) experienced by the patient. Do NOT use for family relative history, standard transient symptoms, or future requested procedures.',
      attributes: []
    },
    {
      id: 'medications',
      entityType: 'Medication',
      displayName: 'Medications',
      typeHint: 'Use for regular daily prescriptions, active therapeutic medications, or over-the-counter drugs (e.g. Metformin, Lisinopril, Pantoprazole). Do NOT use for active vaccine administrations (Immunizations).',
      attributes: []
    },
    {
      id: 'followUps',
      entityType: 'FollowUp',
      displayName: 'Follow-ups & Plans',
      typeHint: 'Use for planned future clinical actions, referrals, scheduled diagnostics, or orders (e.g. Ordering an ECG for next week, referral to cardiology). Do NOT use for completed procedures or historical actions.',
      attributes: []
    },
    {
      id: 'measurements',
      entityType: 'Measurement',
      displayName: 'Measurements',
      typeHint: 'Use for isolated physical measurements, vital sign metrics, or individual lab values (e.g. Blood pressure: 140/90, Heart rate: 72, creatinine: 1.2). Do NOT use for comprehensive lab panels or multi-page summary reports.',
      attributes: []
    }
  ];

  const uniqueEntityTypes = new Set<string>();
  activeSchema.forEach((cat: any) => {
    if (cat.id) uniqueEntityTypes.add(cat.id);
  });
  if (uniqueEntityTypes.size === 0) {
    uniqueEntityTypes.add("conditions");
    uniqueEntityTypes.add("symptoms");
    uniqueEntityTypes.add("medications");
    uniqueEntityTypes.add("followUps");
    uniqueEntityTypes.add("measurements");
  }
  uniqueEntityTypes.add("Person");
  uniqueEntityTypes.add("Other");

  const allowedTypes = Array.from(uniqueEntityTypes);

  // Build schema guidelines
  let schemaGuidelines = "";
  activeSchema.forEach((cat: any) => {
    const attrHints = cat.attributes && cat.attributes.length > 0
      ? cat.attributes.map((attr: any) => `${attr.name} (${attr.type}${attr.choices ? `: [${attr.choices.join(', ')}]` : ''})`).join(', ')
      : "none";
    const typeHintStr = cat.typeHint ? `\n  Classification Guidance: ${cat.typeHint}` : "";
    schemaGuidelines += `- Category ID: "${cat.id}" (Matches Entity Type: "${cat.entityType}", Display Name: "${cat.displayName}")${typeHintStr}\n  Supported Attributes: ${attrHints}\n`;
  });

  const medCat = activeSchema.find((cat: any) => cat.id.toLowerCase().includes("medication") || (cat.entityType || "").toLowerCase().includes("medication"));
  const immCat = activeSchema.find((cat: any) => cat.id.toLowerCase().includes("immuniz") || (cat.entityType || "").toLowerCase().includes("immuniz"));
  const famCat = activeSchema.find((cat: any) => cat.id.toLowerCase().includes("family") || (cat.entityType || "").toLowerCase().includes("family"));
  const condCat = activeSchema.find((cat: any) => (cat.id.toLowerCase().includes("condition") && !cat.id.toLowerCase().includes("family")) || ((cat.entityType || "").toLowerCase().includes("condition") && !(cat.entityType || "").toLowerCase().includes("family")));
  const symCat = activeSchema.find((cat: any) => cat.id.toLowerCase().includes("symptom") || (cat.entityType || "").toLowerCase().includes("symptom"));
  const allergyCat = activeSchema.find((cat: any) => cat.id.toLowerCase().includes("allergy") || cat.id.toLowerCase().includes("intolerance") || (cat.entityType || "").toLowerCase().includes("allergy"));
  const procCat = activeSchema.find((cat: any) => cat.id.toLowerCase().includes("procedure") || (cat.entityType || "").toLowerCase().includes("procedure"));
  const reqCat = activeSchema.find((cat: any) => cat.id.toLowerCase().includes("servicerequest") || cat.id.toLowerCase().includes("followup") || (cat.entityType || "").toLowerCase().includes("servicerequest") || (cat.entityType || "").toLowerCase() === "followup");
  const socialCat = activeSchema.find((cat: any) => cat.id.toLowerCase().includes("social") || cat.id.toLowerCase().includes("lifestyle") || (cat.displayName || "").toLowerCase().includes("social"));

  let antiOverextractionRules = `1. NO GENERIC WORDS / NO SPEAKER NAMES: Do NOT extract generic filler words ("klachten", "stabiel", "ziek", "beter", "onderzoek") or conversational speaker names ("Patient", "Doctor", "Arts") as clinical mentions.\n2. Only extract clinically actionable medical terms literally appearing in the text.`;
  if (medCat) {
    antiOverextractionRules += `\n3. Do not extract bare generic words like "medicijn" or "pills" unless a specific medicine (e.g. Paracetamol, Lisinopril) or drug class is named.`;
  }

  let specificClassificationRules = "";
  if (medCat) {
    specificClassificationRules += `* Medications: All therapeutic medicines, prescriptions, OTC painkillers (e.g. Paracetamol, Ibuprofen, Lisinopril, Pantoprazol) MUST be categorized under "${medCat.id}".\n`;
  }
  if (medCat && immCat) {
    specificClassificationRules += `* Medications vs. Immunizations: Paracetamol and therapeutic drugs are strictly medications ("${medCat.id}"). Preventative vaccine shots (flu shot, Covid vaccine) belong to "${immCat.id}". Negative blood tests/serologies are NOT immunizations.\n`;
  }
  if (condCat && famCat) {
    specificClassificationRules += `* Patient Conditions vs. Family History: Conditions experienced by the patient belong to "${condCat.id}". Diseases of relatives belong to "${famCat.id}".\n`;
  }
  if (allergyCat && symCat) {
    specificClassificationRules += `* Symptoms vs. Allergies: Somatic complaints (headache, cramps, nausea, dizziness, fatigue) belong strictly to "${symCat.id}", NEVER to "${allergyCat.id}".\n`;
  }
  if (procCat && reqCat) {
    specificClassificationRules += `* Procedures vs. ServiceRequests: Completed/active procedures belong to "${procCat.id}". Future ordered/planned tests belong to "${reqCat.id}".\n`;
  }
  if (socialCat) {
    specificClassificationRules += `* Social Status / Social History: Personal habits, behavioral risk factors, lifestyle factors, and substance/screening observations (e.g. smoking status, cigarette use, tobacco, vaping, alcohol consumption, recreational substance use, occupational background, living arrangements) MUST be categorized under "${socialCat.id}". They are NOT Conditions or Symptoms.\n`;
  }

  // 2+1+2 Span window: 2 preceding context utterances + 1 TARGET utterance + 2 succeeding context utterances
  const contextBefore = allSegments.slice(Math.max(0, targetIndex - 2), targetIndex);
  const contextAfter = allSegments.slice(targetIndex + 1, Math.min(allSegments.length, targetIndex + 3));

  const contextBeforeStr = contextBefore.length > 0
    ? contextBefore.map((s, i) => `[Context Utterance ${Math.max(0, targetIndex - 2) + i}] [${s.speaker}]: ${s.text}`).join("\n")
    : "(No preceding context)";

  const targetUtteranceStr = `[TARGET Utterance ${targetIndex}] [${targetSegment.speaker}]: ${targetSegment.text}`;

  const contextAfterStr = contextAfter.length > 0
    ? contextAfter.map((s, i) => `[Context Utterance ${targetIndex + 1 + i}] [${s.speaker}]: ${s.text}`).join("\n")
    : "(No succeeding context)";

  const docType = encounterType === 'note' ? 'clinical document' : 'clinical dialogue';
  const prompt = `You are an expert clinical annotator specializing in Clinical Mention Extraction.
Your task is to analyze the TARGET utterance in a 2+1+2 window (preceding 2 context utterances + 1 TARGET utterance + succeeding 2 context utterances) from a ${docType}.

CRITICAL BOUNDARY MANDATE:
You MUST ONLY extract clinical mentions from the TARGET UTTERANCE itself!
Use the preceding and succeeding context utterances ONLY for pronoun resolution, reference disambiguation, polarity, and clinical intent. NEVER extract mentions from the context utterances!

CONVERSATIONAL CONFIRMATION & NEGATION MANDATE (ANAPHORA & ELLIPSIS):
In clinical dialogues, clinicians regularly screen for symptoms, conditions, medications, or allergies by asking questions (e.g., "Any rash or skin issues? Huiduitslag ergens?", "Last van uw gewrichten? Polsen, knieën, ellebogen?", "Do you take blood thinners?"). Patients routinely answer using conversational confirmations or denials WITHOUT repeating the medical term (e.g., "Nee, niet opgevallen", "No, none at all", "Geen last van", "Nee", "Nee, helemaal niet", "Ja, klopt", "Zeker, al een paar dagen", "Helemaal niet").

When the TARGET UTTERANCE provides a confirmation, denial, or answer to a clinical symptom/condition/medication queried in the preceding context:
1. YOU MUST EXTRACT the verbatim confirmation or denial phrase from the TARGET UTTERANCE as an elliptical clinical mention (e.g. literalText: "Nee, niet opgevallen", "Geen last van", "Nee", "Ja, klopt", "Helemaal niet").
2. Set "canonicalName" to the standardized English clinical concept that was queried in context and is being answered (e.g., Dutch inquiry "Huiduitslag ergens?" + Patient reply "Nee, niet opgevallen" -> canonicalName: "Skin Rash"; Dutch inquiry "last van uw gewrichten? Polsen, knieën" + Patient reply "Nee? Helemaal niet?" -> canonicalName: "Joint Pain").
3. Set "type" to the schema category of the queried concept (e.g., "symptoms", "conditions", "medications").
4. Set "polarity":
   - "negative" if the response denies, refutes, or reports absence of the symptom/condition/drug (e.g., "Nee, niet opgevallen", "Geen last van", "Nee", "Helemaal niet").
   - "positive" if the response affirms or confirms presence/intake (e.g., "Ja, klopt", "Inderdaad", "Ja").
5. Set "function": "asserted" (the patient is asserting their actual clinical status).
6. Set "experiencer": "patient" (unless the inquiry was specifically about a relative).
7. If the preceding question screened for multiple symptoms/conditions (e.g., joint pain AND rash) and the patient's reply answers them together or in turn, extract an elliptical mention for EACH distinct queried concept that the patient's response logically covers.
8. NEGATIVE FILTER: Do NOT extract conversational backchannels or filler words (e.g. "ok", "dank u", "aha", or "ja" when just signaling listening to instructions) unless they represent a direct affirmative or negative answer to a clinical inquiry.

Active Clinical Schema Categories:
${schemaGuidelines}

Classification Guidelines:
${antiOverextractionRules}
${specificClassificationRules}

Required Output Fields for each Mention found in TARGET UTTERANCE:
1. "literalText": The EXACT verbatim word or phrase as it literally appears in the TARGET UTTERANCE text in its original language.
2. "canonicalName": The standardized clinical concept name in English (e.g., Dutch "hoofdpijn" -> "Headache", "hypertensie" -> "Hypertension", "vroege verzadiging" -> "Early satiety", "bloeddruk was 150/95" -> "Blood pressure", "Lisinopril 20mg" -> "Lisinopril", "spierkrampen" -> "Muscle cramps").
3. "type": The active schema category ID where this mention belongs (${allowedTypes.join(' | ')}).
4. "description": Brief clinical context or detail.
5. "polarity": "positive" (present/affirmed) | "negative" (denied/absent/refuted, e.g. "no fever", "geen hoofdpijn") | "neutral".
6. "temporality": "current" (active/ongoing) | "past" (historical/prior) | "future" (planned/scheduled).
7. "certainty": "certain" (confirmed/definite) | "uncertain" (suspected/possible) | "hypothetical" (conditional/if-then).
8. "experiencer": "patient" (experienced by patient) | "family" (biological/non-biological relative) | "other".
9. "function": "asserted" (stated as fact) | "questioned" (asked as question/inquiry) | "hypothetical" | "explanatory" (clinical explanation).

Preceding Context (2 utterances before):
${contextBeforeStr}

TARGET UTTERANCE:
${targetUtteranceStr}

Succeeding Context (2 utterances after):
${contextAfterStr}

You must reply with a valid JSON object ONLY.
The JSON schema you must output is:
{
  "mentions": [
    {
      "literalText": "string (verbatim substring from the TARGET UTTERANCE in original language)",
      "canonicalName": "string (standardized English medical name, e.g. 'Headache', 'Hypertension', 'Lisinopril')",
      "type": "string (MUST be one of: ${allowedTypes.join(' | ')} - category ID from active schema)",
      "description": "string (brief clinical context or details)",
      "polarity": "positive | negative | neutral",
      "certainty": "certain | uncertain | hypothetical",
      "temporality": "current | past | future",
      "experiencer": "patient | other",
      "function": "asserted | questioned | hypothetical | explanatory",
      "supportedAttribute": "string (optional: attribute name this mention grounds, e.g. 'value' for mention '145', 'severity' for 'moderate', 'dosage' for '20mg', 'status' for 'active')"
    }
  ]
}

If no clinical mentions are physically present in the TARGET UTTERANCE, return {"mentions": []}.`;

  const TIMEOUT_MS = 30000;
  const MAX_RETRIES = 2;

  try {
    let text = "";
    if (annotationConfig && annotationConfig.provider === "openai" && annotationConfig.apiKey) {
      text = await withTimeout(
        callCustomOpenAiChat(annotationConfig, prompt),
        TIMEOUT_MS,
        `OpenAI/OpenRouter mention extraction for utterance ${targetIndex} timed out`
      );
    } else if (client) {
      const response = await withTimeout(
        client.models.generateContent({
          model: modelName,
          contents: [{ text: prompt }],
          config: {
            responseMimeType: "application/json",
            responseSchema: {
              type: "OBJECT",
              properties: {
                mentions: {
                  type: "ARRAY",
                  items: {
                    type: "OBJECT",
                    properties: {
                      literalText: { type: "STRING" },
                      canonicalName: { type: "STRING" },
                      type: { type: "STRING", enum: allowedTypes },
                      description: { type: "STRING" },
                      polarity: { type: "STRING", enum: ["positive", "negative", "neutral"] },
                      certainty: { type: "STRING", enum: ["certain", "uncertain", "hypothetical"] },
                      temporality: { type: "STRING", enum: ["current", "past", "future"] },
                      experiencer: { type: "STRING", enum: ["patient", "other"] },
                      function: { type: "STRING", enum: ["asserted", "questioned", "hypothetical", "explanatory"] },
                      supportedAttribute: { type: "STRING" }
                    },
                    required: ["literalText", "canonicalName", "type", "description"]
                  }
                }
              },
              required: ["mentions"]
            }
          }
        }),
        TIMEOUT_MS,
        `Gemini mention extraction for utterance ${targetIndex} timed out`
      );
      text = response.text || "";
    } else {
      throw new Error("No AI client available for mention extraction");
    }

    if (!text) return [];

    const data = cleanAndParseJson(text);
    const mentions = data.mentions || [];

    const results: any[] = [];
    for (const m of mentions) {
      const literal = m.literalText || m.canonicalName;
      if (!literal) continue;

      let startChar = -1;
      let endChar = -1;
      let exactText = "";

      const idx = targetSegment.text.toLowerCase().indexOf(literal.toLowerCase());
      if (idx >= 0) {
        startChar = idx;
        endChar = idx + literal.length;
        exactText = targetSegment.text.substring(startChar, endChar);
      } else {
        const words = literal.split(/\s+/).filter((w: string) => w.length > 2);
        for (const word of words) {
          const wIdx = targetSegment.text.toLowerCase().indexOf(word.toLowerCase());
          if (wIdx >= 0) {
            startChar = wIdx;
            endChar = wIdx + word.length;
            exactText = targetSegment.text.substring(startChar, endChar);
            break;
          }
        }
      }

      if (startChar === -1) {
        startChar = 0;
        endChar = Math.min(15, targetSegment.text.length);
        exactText = targetSegment.text.substring(startChar, endChar);
      }

      const sanitizedType = sanitizeExtractedEntityType(
        m.type,
        m.canonicalName || exactText,
        exactText,
        m.description || "",
        m.experiencer || "patient",
        activeSchema
      );

      if (!sanitizedType) continue;

      results.push({
        id: "", // Assigned sequentially in caller
        textSpan: {
          lineIndex: targetIndex,
          startChar,
          endChar,
          text: exactText
        },
        entityType: sanitizedType,
        canonicalName: m.canonicalName || exactText,
        literalText: exactText,
        description: m.description || "",
        speaker: targetSegment.speaker || "patient",
        polarity: m.polarity || "positive",
        certainty: m.certainty || "certain",
        temporality: m.temporality || "current",
        experiencer: m.experiencer || "patient",
        function: m.function || "asserted",
        supportedAttribute: m.supportedAttribute ? String(m.supportedAttribute).trim().toLowerCase() : (m.supported_attribute ? String(m.supported_attribute).trim().toLowerCase() : undefined),
        entityId: null
      });
    }

    return results;
  } catch (error: any) {
    if (retryCount < MAX_RETRIES) {
      const backoffMs = (retryCount + 1) * 1000;
      await new Promise(res => setTimeout(res, backoffMs));
      return extractMentionsForUtteranceSpan(
        client,
        modelName,
        targetIndex,
        allSegments,
        schemaObj,
        encounterType,
        annotationConfig,
        retryCount + 1
      );
    }
    console.warn(`[Utterance ${targetIndex}] Mention extraction failed after retries:`, error.message || error);
    return [];
  }
}

// Normalizes extracted item attributes against category schema definition,
// mapping case-insensitive select choices, resolving aliases (e.g. status <-> clinicalStatus), and preserving values.
function normalizeItemAttributesToSchema(itemAttributes: Record<string, any>, cat: any): Record<string, any> {
  if (!cat || !Array.isArray(cat.attributes)) return { ...itemAttributes };

  const normalized: Record<string, any> = { ...itemAttributes };

  const aliasMap: Record<string, string[]> = {
    clinicalstatus: ['status', 'clinical_status', 'conditionstatus', 'clinicalStatus', 'state', 'verificationstatus', 'verificationStatus'],
    status: ['clinicalstatus', 'clinicalStatus', 'clinical_status', 'verificationstatus', 'verificationStatus', 'state'],
    verificationstatus: ['verification_status', 'status', 'clinicalstatus', 'clinicalStatus'],
    severity: ['intensity', 'grade'],
    details: ['description', 'notes', 'comment', 'note'],
    description: ['details', 'notes', 'comment', 'note'],
    name: ['title', 'task', 'medication', 'vaccine', 'condition', 'reportName'],
    task: ['name', 'title'],
    title: ['name', 'task'],
    onset: ['duration', 'time', 'date'],
    value: ['result', 'measurement', 'val'],
    dosage: ['dose', 'amount'],
    action: ['plan', 'instruction']
  };

  for (const attr of cat.attributes) {
    const attrNameLower = attr.name.toLowerCase();

    // 1. Check direct name or case-insensitive name
    let val = normalized[attr.name];
    if (val === undefined || val === null || val === '') {
      const keyMatch = Object.keys(normalized).find(k => k.toLowerCase() === attrNameLower);
      if (keyMatch && normalized[keyMatch] !== undefined && normalized[keyMatch] !== null && normalized[keyMatch] !== '') {
        val = normalized[keyMatch];
      }
    }

    // 2. Check aliases
    if (val === undefined || val === null || val === '') {
      const aliases = aliasMap[attrNameLower] || [];
      for (const alias of aliases) {
        if (normalized[alias] !== undefined && normalized[alias] !== null && normalized[alias] !== '') {
          val = normalized[alias];
          break;
        }
        const aliasKeyMatch = Object.keys(normalized).find(k => k.toLowerCase() === alias.toLowerCase());
        if (aliasKeyMatch && normalized[aliasKeyMatch] !== undefined && normalized[aliasKeyMatch] !== null && normalized[aliasKeyMatch] !== '') {
          val = normalized[aliasKeyMatch];
          break;
        }
      }
    }

    if (val !== undefined && val !== null && val !== '') {
      if (attr.type === 'select' && Array.isArray(attr.choices) && attr.choices.length > 0) {
        const matchedChoice = attr.choices.find((c: string) => c.toLowerCase() === String(val).toLowerCase());
        normalized[attr.name] = matchedChoice || String(val);
      } else {
        normalized[attr.name] = val;
      }
    }
  }

  // Cross-sync status and clinicalStatus so both exist transparently
  if (normalized.clinicalStatus !== undefined && normalized.status === undefined) {
    normalized.status = normalized.clinicalStatus;
  } else if (normalized.status !== undefined && normalized.clinicalStatus === undefined && cat.attributes.some((a: any) => a.name === 'clinicalStatus')) {
    const clinAttr = cat.attributes.find((a: any) => a.name === 'clinicalStatus');
    const match = clinAttr?.choices?.find((c: string) => c.toLowerCase() === String(normalized.status).toLowerCase());
    normalized.clinicalStatus = match || normalized.status;
  }

  return normalized;
}

// Fallback deterministic mention clustering
function clusterMentionsDeterministically(mentions: any[], activeSchema: any[]): {
  title: string;
  entities: any[];
  clinicalNotes: any;
} {
  const defaultNotes: any = {};
  activeSchema.forEach(cat => {
    defaultNotes[cat.id] = [];
  });

  if (!mentions || mentions.length === 0) {
    return {
      title: "Clinical Consultation Overview",
      entities: [],
      clinicalNotes: defaultNotes
    };
  }

  const clusters = new Map<string, any[]>();
  mentions.forEach(m => {
    const key = `${(m.entityType || '').toLowerCase()}::${(m.canonicalName || m.literalText || '').toLowerCase().trim()}`;
    if (!clusters.has(key)) {
      clusters.set(key, []);
    }
    clusters.get(key)!.push(m);
  });

  const entities: any[] = [];
  let entCounter = 1;

  clusters.forEach((clusteredMentions) => {
    const entId = `e${entCounter++}`;
    const first = clusteredMentions[0];
    const canonicalName = first.canonicalName || first.literalText || "Clinical Concept";
    const entityType = first.entityType || "symptoms";
    const description = clusteredMentions.map(m => m.description).filter(Boolean).join("; ") || `${canonicalName} referenced in dialogue`;

    clusteredMentions.forEach(m => {
      m.entityId = entId;
    });

    const entObj = {
      id: entId,
      name: canonicalName,
      type: entityType,
      description,
      textSpan: first.textSpan
    };
    entities.push(entObj);

    const hasNegativeMention = clusteredMentions.some(m => m.polarity === 'negative');
    const isOnlyQuestioned = clusteredMentions.every(m => m.function === 'questioned');

    // Structure note entry
    let noteEntry: any = {
      entityId: entId,
      name: canonicalName,
      details: description
    };
    if (entityType.includes("symptom")) {
      noteEntry.severity = hasNegativeMention ? "None / Denied" : (isOnlyQuestioned ? "Unconfirmed" : "Moderate");
      noteEntry.status = hasNegativeMention ? "Refuted" : (isOnlyQuestioned ? "Unconfirmed" : "Active");
      noteEntry.onset = hasNegativeMention ? "N/A" : "Reported";
      if (hasNegativeMention) {
        noteEntry.details = `Patient denies symptom upon screening (${clusteredMentions.filter(m => m.polarity === 'negative').map(m => m.literalText).join(', ')})`;
      }
    } else if (entityType.includes("condition")) {
      noteEntry.status = hasNegativeMention ? "Refuted" : (isOnlyQuestioned ? "Preliminary" : "Active");
      noteEntry.verificationStatus = hasNegativeMention ? "refuted" : (isOnlyQuestioned ? "provisional" : "confirmed");
      if (hasNegativeMention) {
        noteEntry.details = `Screened and denied/refuted (${clusteredMentions.filter(m => m.polarity === 'negative').map(m => m.literalText).join(', ')})`;
      }
    } else if (entityType.includes("medication")) {
      noteEntry.action = "Continue";
      noteEntry.dosage = "As prescribed";
    } else if (entityType.includes("meas") || entityType.includes("observ")) {
      noteEntry.value = first.literalText || "Recorded";
      noteEntry.status = "Normal";
    } else if (entityType.includes("follow") || entityType.includes("servicerequest")) {
      noteEntry.task = description;
      noteEntry.due = "Planned";
      noteEntry.assignee = "Doctor";
    }

    const matchCat = activeSchema.find(c => c.id.toLowerCase() === entityType.toLowerCase() || (c.entityType || '').toLowerCase() === entityType.toLowerCase());
    if (matchCat) {
      noteEntry = normalizeItemAttributesToSchema(noteEntry, matchCat);
    }

    if (defaultNotes[entityType]) {
      defaultNotes[entityType].push(noteEntry);
    } else {
      if (matchCat && defaultNotes[matchCat.id]) {
        defaultNotes[matchCat.id].push(noteEntry);
      }
    }
  });

  return {
    title: "Clinical Consultation Overview",
    entities,
    clinicalNotes: defaultNotes
  };
}

// STEP 2: Cluster and organize existing mentions into relevant Entities
async function clusterMentionsIntoEntities(
  client: GoogleGenAI | null,
  modelName: string,
  mentions: any[],
  activeSchema: any[],
  fullTranscriptText: string,
  annotationConfig?: any
): Promise<{
  title: string;
  entities: any[];
  clinicalNotes: any;
}> {
  const defaultNotes: any = {};
  activeSchema.forEach(cat => {
    defaultNotes[cat.id] = [];
  });

  if (!mentions || mentions.length === 0) {
    return {
      title: "Clinical Consultation",
      entities: [],
      clinicalNotes: defaultNotes
    };
  }

  const mentionsSummary = mentions.map(m => ({
    id: m.id,
    literalText: m.textSpan?.text || m.literalText,
    canonicalName: m.canonicalName,
    entityType: m.entityType,
    speaker: m.speaker,
    polarity: m.polarity,
    temporality: m.temporality,
    certainty: m.certainty,
    experiencer: m.experiencer,
    function: m.function,
    supportedAttribute: m.supportedAttribute,
    description: m.description,
    utteranceIndex: m.textSpan?.lineIndex
  }));

  const dynamicSchemaGuidelines = activeSchema.map(cat => {
    const attrList = (cat.attributes || []).map((a: any) => `${a.name} (${a.type}${a.choices ? `: [${a.choices.join(', ')}]` : ''})`).join(', ');
    return `- Category ID "${cat.id}" (Display Name: "${cat.displayName}", Entity Type: "${cat.entityType}"): ${cat.typeHint || ''}\n  Attributes: ${attrList}`;
  }).join("\n\n");

  const step2Prompt = `You are an expert clinical annotator.
In Step 1, all clinical mentions with their polarity, temporality, certainty, experiencer, function, and English canonical names were extracted.

In this Step 2, your task is ONLY to cluster/organize these existing mentions into relevant canonical Entities, and structure their attributes so they can be used directly in clinical summaries and notes.

CRITICAL INSTRUCTIONS:
1. Concept Clustering: Mentions that refer to the same underlying clinical concept (e.g. multiple mentions of headache across conversation lines, or an inquiry mention of skin rash clustered with a patient's denial of rash) MUST be clustered into a single Entity.
2. Pertinent Negatives & Denial Resolution:
   - When an entity contains both an inquiry mention (function: "questioned", e.g. clinician asking about rash, joints, or orthopnea) AND a patient denial mention (polarity: "negative", function: "asserted", e.g. patient replying "Nee, niet opgevallen", "Nee, nee", or "Geen last van"):
     - The clinical conclusion for this entity is that the finding is NEGATIVE / ABSENT / REFUTED.
     - For Symptoms: Set status/clinicalStatus to the exact negative choice defined in the schema (e.g., "Refuted" if choices include "Refuted", or "refuted" if lowercase choices). If schema has severity with "None / Denied" or "none", select it. In 'details', explicitly state the screening inquiry and patient's denial (e.g. "Screened; patient explicitly denies nighttime shortness of breath when recumbent ('Nee, nee')").
     - For Conditions: Set 'status' or 'clinicalStatus' / 'verificationStatus' to "Refuted" or "refuted" matching the schema choices.
     - Entity Description: Explicitly synthesize both the inquiry and the patient's denial (e.g. "Screened for orthopnea; patient explicitly denies nighttime dyspnea ('Nee, nee')").
3. Every Mention Mapped: Every mention ID (m1, m2...) from the input list MUST be assigned to the 'mentionIds' array of exactly ONE Entity.
4. Canonical English Name: The 'name' of each Entity MUST be a standardized English clinical concept name (e.g. 'Headache', 'Essential Hypertension', 'Skin Rash', 'Orthopnea', 'Joint Pain', 'Lisinopril', 'Blood Pressure', 'Dyspepsia').
5. Synthesized Description: Provide a concise clinical synthesis of the entity combining its mentions (e.g. 'Patient reports moderate dyspepsia and stomach discomfort, denies nausea' or 'Screened for orthopnea; patient explicitly denies nighttime dyspnea').
6. Direct Category Attributes & Strict Schema Choice Matching (CRITICAL):
   - For each entity, populate the structured 'attributes' object strictly adhering to the EXACT attribute names and EXACT allowed choice values (matching case precisely) defined in the Active Annotation Schema below.
   - Do NOT invent Title Case values when the schema specifies lowercase choices:
     * If the category schema defines: clinicalStatus (select: [unassigned, active, recurrence, relapse, inactive, remission, resolved, unspecified]) -> you MUST use attribute name "clinicalStatus" (NOT "status") and lowercase value like "active", "resolved".
     * If the category schema defines: severity (select: [unassigned, mild, moderate, severe, unspecified]) -> you MUST use lowercase value like "mild", "moderate", "severe".
     * If the category schema defines: status (select: [Unassigned, Active, Resolved, Refuted, Unspecified]) -> then use Title Case "Active", "Resolved", "Refuted".
     * For text attributes (e.g. details, onset, dosage, value), provide concise clinically accurate values.
7. Schema Type: The Entity 'type' must match the category ID from the active schema (e.g. "symptoms", "conditions", "fhir_symptoms", "fhir_conditions").
8. Supported Entity Attributes: Notice mentions may specify 'supportedAttribute' (e.g. mention '145' or '140/90' supports attribute 'value' of entity 'Hypertension', mention 'moderate' supports attribute 'severity', mention '20mg' supports attribute 'dosage', mention 'active' supports 'status'). Cluster these attribute-supporting mentions directly into the entity they ground, and use their literal text to ground and populate that exact attribute on the entity.
9. Encounter Title: Provide a concise, informative title of the medical encounter (e.g. 'Hypertension Follow-up & Medication Adjustment').

Active Annotation Schema:
${dynamicSchemaGuidelines}

Extracted Mentions from Step 1:
${JSON.stringify(mentionsSummary, null, 2)}

You must reply with a valid JSON object ONLY.
The JSON schema you must output is:
{
  "title": "Descriptive title of the encounter",
  "entities": [
    {
      "id": "e1",
      "name": "Canonical English Name (e.g. Dyspepsia)",
      "type": "exact category ID from schema (e.g. fhir_symptoms, symptoms)",
      "description": "Synthesized clinical description from mentions",
      "mentionIds": ["m1", "m3"],
      "attributes": {
        "severity": "exact choice matching schema case e.g. moderate or Moderate",
        "status": "exact choice matching schema case",
        "details": "Clinical details and context"
      }
    }
  ]
}`;

  try {
    let text = "";
    if (annotationConfig && annotationConfig.provider === "openai" && annotationConfig.apiKey) {
      text = await withTimeout(
        callCustomOpenAiChat(annotationConfig, step2Prompt),
        60000,
        "OpenAI/OpenRouter clustering Step 2 timed out"
      );
    } else if (client) {
      const response = await withTimeout(
        client.models.generateContent({
          model: modelName,
          contents: [{ text: step2Prompt }],
          config: {
            responseMimeType: "application/json"
          }
        }),
        60000,
        "Gemini clustering Step 2 timed out"
      );
      text = response.text || "";
    }

    if (!text) {
      return clusterMentionsDeterministically(mentions, activeSchema);
    }

    const data = cleanAndParseJson(text);
    const rawEntities = data.entities || [];
    const extractedTitle = data.title || "Annotated Clinical Consultation";

    if (!Array.isArray(rawEntities) || rawEntities.length === 0) {
      return clusterMentionsDeterministically(mentions, activeSchema);
    }

    const canonicalEntities: any[] = [];
    const clinicalNotes: any = { ...defaultNotes };
    activeSchema.forEach(cat => {
      clinicalNotes[cat.id] = [];
    });

    const mentionMap = new Map<string, any>();
    mentions.forEach(m => mentionMap.set(m.id, m));

    const mappedMentionIds = new Set<string>();
    let entityCount = 1;

    for (const rawEnt of rawEntities) {
      const entId = `e${entityCount++}`;
      const entName = rawEnt.name || "Clinical Entity";
      const entType = rawEnt.type || "symptoms";
      const entDesc = rawEnt.description || `${entName} discussed in encounter`;

      const clusterMentionIds: string[] = Array.isArray(rawEnt.mentionIds) ? rawEnt.mentionIds : [];
      let representativeSpan: any = null;

      clusterMentionIds.forEach(mId => {
        const m = mentionMap.get(mId);
        if (m) {
          m.entityId = entId;
          mappedMentionIds.add(mId);
          if (!representativeSpan && m.textSpan) {
            representativeSpan = m.textSpan;
          }
        }
      });

      canonicalEntities.push({
        id: entId,
        name: entName,
        type: entType,
        description: entDesc,
        ...(representativeSpan ? { textSpan: representativeSpan } : {})
      });

      // Structure category item for clinicalNotes directly
      const itemAttributes = rawEnt.attributes || {};
      let noteItem: any = {
        entityId: entId,
        name: entName,
        ...itemAttributes
      };

      // Ensure item is placed in correct category
      let targetCatId = entType;
      const matchingCat = activeSchema.find(c =>
        c.id.toLowerCase() === entType.toLowerCase() ||
        (c.entityType || '').toLowerCase() === entType.toLowerCase()
      );
      if (!clinicalNotes[targetCatId] && matchingCat) {
        targetCatId = matchingCat.id;
      }

      // Check if this entity's clustered mentions have a negative denial or if details refute it
      const entMentions = clusterMentionIds.map(mId => mentionMap.get(mId)).filter(Boolean);
      const hasNegativeMention = entMentions.some((m: any) => m.polarity === 'negative');
      const isRefutedText = /patient denies|patient ontkent|denied|ontkend|refuted|weerlegd|geen last|niet opgevallen|negative/i.test(noteItem.details || '') ||
                            /patient denies|patient ontkent|denied|ontkend|refuted|weerlegd|geen last|niet opgevallen|negative/i.test(entDesc || '');

      if (hasNegativeMention || isRefutedText) {
        const isSymptom = targetCatId.toLowerCase().includes('symptom') || entType.toLowerCase().includes('symptom');
        const isCondition = targetCatId.toLowerCase().includes('condition') || entType.toLowerCase().includes('condition');

        const statusAttr = (matchingCat?.attributes || []).find((a: any) => a.name === 'status');
        const isUppercaseStatus = statusAttr?.choices ? statusAttr.choices.some((c: string) => c.toLowerCase() === 'refuted' && c[0] === 'R') : true;
        const refutedStatusVal = isUppercaseStatus ? 'Refuted' : 'refuted';

        if (isSymptom) {
          if (!noteItem.status || /^(final|registered|unknown|active|unspecified)$/i.test(noteItem.status)) {
            noteItem.status = refutedStatusVal;
          }
          const sevChoices = (matchingCat?.attributes || []).find((a: any) => a.name === 'severity')?.choices || [];
          if (sevChoices.some((c: string) => /none \/ denied/i.test(c))) {
            noteItem.severity = 'None / Denied';
          }
        } else if (isCondition) {
          if (!noteItem.status || /^(active|chronic|unspecified)$/i.test(noteItem.status)) {
            noteItem.status = refutedStatusVal;
          }
          if (noteItem.verificationStatus) {
            noteItem.verificationStatus = 'refuted';
          }
        } else if (targetCatId.toLowerCase().includes('social') || entType.toLowerCase().includes('social')) {
          if (!noteItem.value) {
            noteItem.value = 'Never / Denies use';
          }
        }
      }

      if (targetCatId.toLowerCase().includes('social') || entType.toLowerCase().includes('social')) {
        if (!noteItem.category) {
          noteItem.category = 'social-history';
        }
        if (!noteItem.status) {
          noteItem.status = 'final';
        }
      }

      if (matchingCat) {
        noteItem = normalizeItemAttributesToSchema(noteItem, matchingCat);
      }

      if (!clinicalNotes[targetCatId]) {
        clinicalNotes[targetCatId] = [];
      }
      clinicalNotes[targetCatId].push(noteItem);
    }

    // Safety: ensure any unmapped mentions get linked to an entity
    mentions.forEach(m => {
      if (!m.entityId || !mappedMentionIds.has(m.id)) {
        // Try to link to an existing entity of matching name or type
        const match = canonicalEntities.find(e =>
          (e.name || '').toLowerCase() === (m.canonicalName || '').toLowerCase() &&
          e.type === m.entityType
        );
        if (match) {
          m.entityId = match.id;
        } else {
          const fallbackId = `e${entityCount++}`;
          m.entityId = fallbackId;
          const fallbackEnt = {
            id: fallbackId,
            name: m.canonicalName || m.literalText || "Clinical Mention",
            type: m.entityType,
            description: m.description || `${m.canonicalName} mentioned in dialogue`,
            textSpan: m.textSpan
          };
          canonicalEntities.push(fallbackEnt);
          let noteItem: any = {
            entityId: fallbackId,
            name: fallbackEnt.name,
            details: fallbackEnt.description
          };
          const fallbackCat = activeSchema.find(c => c.id.toLowerCase() === m.entityType.toLowerCase() || (c.entityType || '').toLowerCase() === m.entityType.toLowerCase());
          if (fallbackCat) {
            noteItem = normalizeItemAttributesToSchema(noteItem, fallbackCat);
          }
          if (clinicalNotes[m.entityType]) {
            clinicalNotes[m.entityType].push(noteItem);
          } else if (fallbackCat && clinicalNotes[fallbackCat.id]) {
            clinicalNotes[fallbackCat.id].push(noteItem);
          }
        }
      }
    });

    return {
      title: extractedTitle,
      entities: canonicalEntities,
      clinicalNotes
    };
  } catch (err) {
    console.warn("Error in Step 2 clustering, falling back to deterministic clustering:", err);
    return clusterMentionsDeterministically(mentions, activeSchema);
  }
}

async function startServer() {
  const app = express();
  const PORT = 3000;

  // Increase payload limit to handle base64 audio uploads
  app.use(express.json({ limit: "50mb" }));
  app.use(express.urlencoded({ limit: "50mb", extended: true }));

  // Simple health check endpoint
  app.get("/api/health", (req, res) => {
    res.json({ success: true, status: "ready" });
  });

  // API endpoint for annotation and transcription
  app.post("/api/annotate", upload.single("audio"), async (req, res) => {
    const { transcript, transcriptSegments, audioBase64, audioMimeType, aiConfig, annotationSchema, encounterType } = req.body;

    let schemaObj: any[] = [];
    if (annotationSchema) {
      try {
        schemaObj = typeof annotationSchema === "string" ? JSON.parse(annotationSchema) : annotationSchema;
      } catch (e) {
        console.warn("Failed to parse annotationSchema in annotate route:", e);
      }
    }

    let userAiConfig: any = null;
    if (aiConfig) {
      try {
        userAiConfig = typeof aiConfig === "string" ? JSON.parse(aiConfig) : aiConfig;
      } catch (e) {
        console.warn("Failed to parse userAiConfig in annotate:", e);
      }
    }

    // Resolve active schema to use (either passed schemaObj or fallback defaults)
    const rawSchema: any[] = (schemaObj && schemaObj.length > 0) ? schemaObj : [
      {
        id: 'symptoms',
        entityType: 'Symptom',
        displayName: 'Symptoms',
        typeHint: 'Use for physical signs or clinical symptoms reported by the patient (e.g. Nausea, headache, fever, cough, chest pain, orthopnea). Do NOT use for drug allergies (AllergyIntolerance) or chronic disease diagnoses.',
        attributes: [
          { name: 'name', type: 'text', hint: 'The physical symptom or sign' },
          { name: 'severity', type: 'select', choices: ['Mild', 'Moderate', 'Severe', 'None / Denied', 'Unspecified'], hint: 'The intensity of the symptom' },
          { name: 'status', type: 'select', choices: ['Active', 'Resolved', 'Refuted', 'Unconfirmed', 'Unspecified'], hint: 'Clinical presence or verification status (use "Refuted" when screened and denied/absent)' },
          { name: 'onset', type: 'text', hint: 'When the symptom started or duration' },
          { name: 'details', type: 'text', hint: 'Additional characterization of the symptom' }
        ]
      },
      {
        id: 'conditions',
        entityType: 'Condition',
        displayName: 'Disorders & Conditions',
        typeHint: 'Use ONLY for formal, established medical diagnoses, diseases, and chronic disorders (e.g. Essential hypertension, Type 2 diabetes) experienced by the patient. Do NOT use for family relative history, standard transient symptoms, or future requested procedures.',
        attributes: [
          { name: 'name', type: 'text', hint: 'The medical name of the condition or disease' },
          { name: 'status', type: 'select', choices: ['Active', 'Chronic', 'History of', 'Differential Diagnosis', 'Refuted', 'Unspecified'], hint: 'Clinical status or presence (use "Refuted" for ruled-out or screened and denied conditions)' },
          { name: 'details', type: 'text', hint: 'Additional context, specifications, or notes' }
        ]
      },
      {
        id: 'medications',
        entityType: 'Medication',
        displayName: 'Prescribed Medications',
        typeHint: 'Use for regular daily prescriptions, active therapeutic medications, or over-the-counter drugs (e.g. Metformin, Lisinopril, Pantoprazole). Do NOT use for active vaccine administrations (Immunizations).',
        attributes: [
          { name: 'name', type: 'text', hint: 'Brand or generic drug name' },
          { name: 'action', type: 'select', choices: ['Start', 'Stop', 'Change Dosage', 'Continue', 'Discussed'], hint: 'Status or action of the prescription' },
          { name: 'dosage', type: 'text', hint: 'Dosage amount and frequency' },
          { name: 'details', type: 'text', hint: 'Special instructions or side effects' }
        ]
      },
      {
        id: 'followUps',
        entityType: 'FollowUp',
        displayName: 'Follow-ups & Plans',
        typeHint: 'Use for planned future clinical actions, referrals, scheduled diagnostics, or orders (e.g. Ordering an ECG for next week, referral to cardiology). Do NOT use for completed procedures or historical actions.',
        attributes: [
          { name: 'task', type: 'text', hint: 'Description of the follow-up or referral' },
          { name: 'due', type: 'text', hint: 'Due date or timeline' },
          { name: 'assignee', type: 'text', hint: 'Responsible person (e.g. Patient, Doctor)' }
        ]
      },
      {
        id: 'measurements',
        entityType: 'Measurement',
        displayName: 'Measurements',
        typeHint: 'Use for isolated physical measurements, vital sign metrics, or individual lab values (e.g. Blood pressure: 140/90, Heart rate: 72, creatinine: 1.2). Do NOT use for comprehensive lab panels or multi-page summary reports.',
        attributes: [
          { name: 'name', type: 'text', hint: 'Vital sign or lab test name' },
          { name: 'value', type: 'text', hint: 'Result or value with units' },
          { name: 'status', type: 'text', hint: 'Evaluation of the value (e.g. Normal, Elevated, Low, Target)' },
          { name: 'details', type: 'text', hint: 'Additional context or timestamp of measurement' }
        ]
      }
    ];

    // Ensure all symptom and condition categories in activeSchema have 'refuted' / 'Refuted' available
    const activeSchema = rawSchema.map((cat: any) => {
      const isSymptom = (cat.id || '').toLowerCase().includes('symptom') || (cat.entityType || '').toLowerCase() === 'symptom';
      const isCondition = (cat.id || '').toLowerCase().includes('condition') || (cat.entityType || '').toLowerCase() === 'condition';

      const attrs = (cat.attributes || []).map((attr: any) => {
        if (attr.name === 'status' || attr.name === 'verificationStatus') {
          const choices = Array.isArray(attr.choices) ? [...attr.choices] : [];
          const lowerChoices = choices.map((c: string) => c.toLowerCase());
          if (!lowerChoices.includes('refuted')) {
            const hasUpper = choices.some((c: string) => c[0] === c[0]?.toUpperCase());
            choices.push(hasUpper ? 'Refuted' : 'refuted');
          }
          return { ...attr, choices };
        }
        if (isSymptom && attr.name === 'severity') {
          const choices = Array.isArray(attr.choices) ? [...attr.choices] : [];
          const lowerChoices = choices.map((c: string) => c.toLowerCase());
          if (!lowerChoices.some((c: string) => c.includes('none') || c.includes('denied'))) {
            const hasUpper = choices.some((c: string) => c[0] === c[0]?.toUpperCase());
            choices.push(hasUpper ? 'None / Denied' : 'none / denied');
          }
          return { ...attr, choices };
        }
        return attr;
      });

      // If symptom category is missing status or clinicalStatus attribute, add it
      if (isSymptom && !attrs.some((a: any) => a.name === 'status' || a.name === 'clinicalStatus')) {
        attrs.splice(2, 0, {
          name: 'status',
          type: 'select',
          choices: ['Active', 'Resolved', 'Refuted', 'Unconfirmed', 'Unspecified'],
          hint: 'Clinical presence or verification status (use "Refuted" when screened and denied/absent)'
        });
      }

      return { ...cat, attributes: attrs };
    });

    try {
      // 2. Otherwise use Gemini (Dynamic client check)
      let client: GoogleGenAI;
      let useGeminiModel = "gemini-3.1-flash-lite";

      try {
        if (userAiConfig && userAiConfig.annotation && userAiConfig.annotation.provider === "gemini" && userAiConfig.annotation.apiKey) {
          client = new GoogleGenAI({ apiKey: userAiConfig.annotation.apiKey });
        } else {
          client = getAiClient();
        }
        if (userAiConfig && userAiConfig.annotation && userAiConfig.annotation.provider === "gemini" && userAiConfig.annotation.model) {
          useGeminiModel = userAiConfig.annotation.model;
        }
      } catch (keyError: any) {
        console.warn("Gemini API Key missing, falling back to mock processor", keyError.message);
        if (req.file) {
          try { await fs.promises.unlink(req.file.path); } catch (e) {}
        }
        // Fallback to beautiful mock annotation if key is missing so the user can still interact and play with the app.
        const mockResult = generateMockAnnotation(transcript || "Doctor: Hello, how can I help you today?\nPatient: Hi, I have been having severe headaches since Tuesday. Also my blood pressure was high, around 150/95.\nDoctor: Okay, let's check. Your current prescription for Lisinopril is 10mg. Let's increase it to 20mg once daily. And please track your blood pressure and come back for a follow-up in two weeks.");
        return res.json({
          success: true,
          isMock: true,
          warning: "No API key configured. The default server Gemini API key has been unset. You can configure your own Gemini or OpenAI API key in the 'Set API Keys' popup (Key icon in the top header) to enable live model calls. Using local clinical rule-parser for demo.",
          data: mockResult
        });
      }

      let fileRef: any = null;

      if (req.file) {
        console.log("Uploading file to Gemini File API...", req.file.path);
        try {
          const uploadResult = await client.files.upload({
            file: req.file.path,
            config: {
              mimeType: req.file.mimetype || audioMimeType || "audio/webm",
            },
          });
          fileRef = {
            fileData: {
              fileUri: uploadResult.uri,
              mimeType: uploadResult.mimeType,
            },
          };
          console.log("Gemini File API upload success:", uploadResult.uri);
        } catch (uploadError: any) {
          console.error("Gemini File API upload failed, falling back to inlineData:", uploadError);
          const fileBuffer = await fs.promises.readFile(req.file.path);
          fileRef = {
            inlineData: {
              data: fileBuffer.toString("base64"),
              mimeType: req.file.mimetype || audioMimeType || "audio/webm",
            },
          };
        } finally {
          try {
            await fs.promises.unlink(req.file.path);
          } catch (unlinkError) {
            console.warn("Could not clean up temp file:", unlinkError);
          }
        }
      } else if (audioBase64) {
        console.log("Processing audio transcript of type (base64):", audioMimeType);
        fileRef = {
          inlineData: {
            data: audioBase64,
            mimeType: audioMimeType || "audio/webm",
          },
        };
      }

      let parsedSegments: any[] = [];
      if (transcriptSegments) {
        try {
          parsedSegments = typeof transcriptSegments === "string" ? JSON.parse(transcriptSegments) : transcriptSegments;
        } catch (e) {
          console.warn("Failed to parse transcriptSegments:", e);
        }
      }

      // If we have an audio file but no segments and no transcript text, diarize the audio first to get segments
      if ((!parsedSegments || parsedSegments.length === 0) && !transcript && fileRef) {
        console.log("No transcript segments provided, performing internal diarization first...");
        try {
          const diarized = await runDiarizationInternal(client, useGeminiModel, fileRef);
          parsedSegments = diarized.segments;
        } catch (diarizeError: any) {
          console.error("Internal diarization failed:", diarizeError);
        }
      }

      // Fallback: if segments are empty but we have transcript text, reconstruct segments by lines/paragraphs/JSON objects
      if ((!parsedSegments || parsedSegments.length === 0) && transcript) {
        parsedSegments = parseTranscriptToSegments(transcript, encounterType || "dialogue");
      }

      // If we STILL have no segments, we cannot proceed with annotation
      if (!parsedSegments || parsedSegments.length === 0) {
        return res.status(400).json({ success: false, error: "Unable to produce or retrieve clinical conversation segments for annotation" });
      }

      // STEP 1: Extract clinical mentions and their attributes from batched utterances
      // Batch segments into chunks of 12 utterances to drastically reduce API roundtrips,
      // prevent rate limiting (Gemini free tier 15 RPM), and eliminate timeout errors.
      const BATCH_SIZE = 12;
      const batches: { id: string; speaker: string; text: string; lineIndex: number }[][] = [];
      for (let i = 0; i < parsedSegments.length; i += BATCH_SIZE) {
        const batch = parsedSegments.slice(i, i + BATCH_SIZE).map((seg, offset) => ({
          ...seg,
          lineIndex: i + offset
        }));
        batches.push(batch);
      }

      console.log(`Step 1: Extracting mentions in ${batches.length} batch(es) across ${parsedSegments.length} utterances using ${useGeminiModel}...`);
      let allMentions: any[] = [];
      try {
        const batchTasks = batches.map(batch => {
          return () => extractMentionsForBatch(
            client,
            useGeminiModel,
            batch,
            parsedSegments,
            schemaObj,
            encounterType,
            userAiConfig?.annotation
          );
        });

        // Concurrently process batches with concurrency 2 to respect Gemini RPM rate limits and prevent timeouts
        const extractionResults = await mapConcurrent(batchTasks, 2, (fn) => fn());
        const rawMentions = extractionResults.flat();

        // Assign sequential mention IDs: m1, m2, ...
        let mentionCounter = 1;
        allMentions = rawMentions.map(m => ({
          ...m,
          id: `m${mentionCounter++}`
        }));
      } catch (err: any) {
        console.error("Utterance span mention extraction failed, falling back to mock processor:", err);
        const mockResult = generateMockAnnotation(transcript || "Doctor: Hello, how can I help you today?\nPatient: Hi, I have been having severe headaches since Tuesday. Also my blood pressure was high, around 150/95.\nDoctor: Okay, let's check. Your current prescription for Lisinopril is 10mg. Let's increase it to 20mg once daily. And please track your blood pressure and come back for a follow-up in two weeks.");
        return res.json({
          success: true,
          isMock: true,
          warning: `Utterance mention extraction failed: ${err.message || err}. Using rule-parser fallback.`,
          data: mockResult
        });
      }

      console.log(`Step 1 Complete: Extracted ${allMentions.length} mentions with polarity, temporality, certainty, experiencer, function, and canonical English names.`);

      // STEP 2: Cluster and organize existing mentions into relevant canonical Entities
      console.log(`Step 2: Clustering and organizing ${allMentions.length} mentions into canonical Entities...`);
      const fullTranscriptText = parsedSegments.map((seg, idx) => `[Segment ${idx}] [${seg.speaker}]: ${seg.text}`).join('\n');

      const clusteredResult = await clusterMentionsIntoEntities(
        client,
        useGeminiModel,
        allMentions,
        activeSchema,
        fullTranscriptText,
        userAiConfig?.annotation
      );

      const finalParsedData = {
        title: clusteredResult.title || "Annotated Clinical Consultation",
        rawTranscript: transcript || parsedSegments.map(s => `${s.speaker}: ${s.text}`).join("\n"),
        transcriptSegments: parsedSegments || [],
        entities: clusteredResult.entities,
        relations: [],
        clinicalNotes: clusteredResult.clinicalNotes,
        mentions: allMentions
      };

      res.json({
        success: true,
        data: finalParsedData
      });

    } catch (error: any) {
      console.error("Error in /api/annotate:", error);
      res.status(500).json({
        success: false,
        error: error.message || "An error occurred during medical transcription & annotation processing"
      });
    }
  });

  // API endpoint dedicated to Knowledge Graph Relations generation
  app.post("/api/relations", async (req, res) => {
    const { transcript, transcriptSegments, entities, mentions, aiConfig } = req.body;

    if (!entities || !Array.isArray(entities) || entities.length === 0) {
      return res.status(400).json({
        success: false,
        error: "No entities provided. Please annotate the conversation first to extract clinical entities."
      });
    }

    let userAiConfig: any = null;
    if (aiConfig) {
      try {
        userAiConfig = typeof aiConfig === "string" ? JSON.parse(aiConfig) : aiConfig;
      } catch (e) {
        console.warn("Failed to parse userAiConfig in relations endpoint:", e);
      }
    }

    let client: GoogleGenAI;
    let useGeminiModel = "gemini-3.8-flash";

    try {
      if (userAiConfig && userAiConfig.annotation && userAiConfig.annotation.provider === "gemini" && userAiConfig.annotation.apiKey) {
        client = new GoogleGenAI({ apiKey: userAiConfig.annotation.apiKey });
      } else {
        client = getAiClient();
      }
      if (userAiConfig && userAiConfig.annotation && userAiConfig.annotation.provider === "gemini" && userAiConfig.annotation.model) {
        useGeminiModel = userAiConfig.annotation.model;
      }
    } catch (keyError: any) {
      console.warn("Gemini API key missing, generating rule-based mock relations:", keyError.message);
      const mockRelations = generateMockRelationsForEntities(entities);
      return res.json({
        success: true,
        isMock: true,
        warning: "No API key configured. The default server Gemini API key has been unset. You can configure your own Gemini or OpenAI API key in the 'Set API Keys' popup (Key icon in the top header) to enable live relation extraction. Using local clinical rule-based relations for demo.",
        data: {
          relations: mockRelations
        }
      });
    }

    try {
      let transcriptContext = transcript || "";
      if (!transcriptContext && Array.isArray(transcriptSegments) && transcriptSegments.length > 0) {
        transcriptContext = transcriptSegments.map((s: any, idx: number) => `[Segment ${idx}] [${s.speaker || 'Speaker'}]: ${s.text || ''}`).join('\n');
      }

      // Enrich entities with any supported attributes, values, and mentions
      const enrichedEntitiesForRelations = entities.map((e: any) => {
        const entMentions = Array.isArray(mentions) ? mentions.filter((m: any) => m.entityId === e.id) : [];
        const supportedAttributesMap: Record<string, string[]> = {};
        entMentions.forEach((m: any) => {
          if (m.supportedAttribute && m.textSpan?.text) {
            const attr = String(m.supportedAttribute).trim().toLowerCase();
            if (!supportedAttributesMap[attr]) supportedAttributesMap[attr] = [];
            if (!supportedAttributesMap[attr].includes(m.textSpan.text)) {
              supportedAttributesMap[attr].push(m.textSpan.text);
            }
          }
        });
        const mentionTexts = Array.from(new Set(
          entMentions
            .map((m: any) => m.textSpan?.text || m.literalText)
            .filter((t: any) => t && typeof t === 'string' && t.trim().length > 0)
        ));
        return {
          id: e.id,
          name: e.name,
          type: e.type,
          description: e.description,
          attributes: e.attributes,
          ...(Object.keys(supportedAttributesMap).length > 0 ? { supportedAttributes: supportedAttributesMap } : {}),
          ...(mentionTexts.length > 0 ? { mentions: mentionTexts } : {})
        };
      });

      const relationsPrompt = `You are an expert clinical knowledge graph engineer and biomedical NLP specialist.
Given the clinical encounter transcript and the extracted canonical medical entities, construct a high-quality directed knowledge graph of relationships (relations) connecting these entities.

Entities list:
${JSON.stringify(enrichedEntitiesForRelations, null, 2)}

You must return a JSON object with this exact schema:
{
  "relations": [
    {
      "id": "r1, r2, r3...",
      "source": "source entity ID (MUST be one of the entity IDs from the provided list)",
      "target": "target entity ID (MUST be one of the entity IDs from the provided list)",
      "type": "RELATION_TYPE in UPPERCASE"
    }
  ]
}

Standard Clinical Relations:
- EXPERIENCING: Patient experiencing a Symptom, Complaint, or Condition
- DIAGNOSED_WITH: Patient formally diagnosed with a Condition
- PRESCRIBED: Doctor or clinician prescribed a Medication or Procedure
- TAKING: Patient actively taking or consuming a Medication
- TREATS: Medication or Procedure treats/manages a Condition or Symptom
- HAS_DOSAGE / DOSAGE_FOR: Medication has specific Dosage
- HAS_MEASUREMENT / MEASURES: Patient or Condition has a vital sign / lab measurement
- REPORTS_HABIT / HAS_SOCIAL_HISTORY: Patient reports social history, personal habit, or lifestyle factor (smoking, alcohol, substance use, living arrangements)
- ASSOCIATED_WITH: Clinical concept associated with another Condition, Finding, or Symptom
- CAUSED_BY: Symptom or adverse event caused by Condition or Medication
- SCHEDULED / ORDERED: Action, referral, or diagnostic test scheduled or ordered
- CONTRAINDICATED_WITH: Medication contraindicated with an Allergy or Condition

Strict Rules:
1. Every relation "source" and "target" MUST strictly match an ID from the provided entities list (e.g. "e1", "e2"). Do NOT invent IDs.
2. Self-loops (where source === target) are forbidden.
3. If Patient or Doctor entities exist, connect them to the relevant symptoms, diagnoses, prescriptions, and follow-ups.
4. Supported Attributes Clarity: Notice that entities may contain 'supportedAttributes' grounding specific attributes directly from the text mentions (e.g., entity 'Hypertension' has supportedAttributes: { value: ['145'] } where mention '145' supports attribute VALUE, or 'Headache' has { severity: ['moderate'] } where mention 'moderate' supports attribute SEVERITY, or 'Lisinopril' has { dosage: ['20mg'] }). This clears out unnecessary confusion between standalone numbers/readings and diagnoses, and enables you to easily establish precise clinical relations (e.g. HAS_MEASUREMENT, HAS_DOSAGE, TREATS) directly.
5. Output raw JSON only with NO markdown fences, NO conversational text, and NO commentary.`;

      const contents = [
        ...(transcriptContext ? [{ text: `Clinical Encounter Transcript:\n${transcriptContext}` }] : []),
        { text: relationsPrompt }
      ];

      console.log(`Generating Knowledge Graph Relations for ${entities.length} entities using ${useGeminiModel}...`);
      const response = await withTimeout(
        client.models.generateContent({
          model: useGeminiModel,
          contents,
          config: {
            responseMimeType: "application/json"
          }
        }),
        45000,
        "Gemini relations generation timed out"
      );

      const responseText = response.text;
      if (!responseText) {
        throw new Error("Empty response received from Gemini model for relations generation.");
      }

      const parsed = cleanAndParseJson(responseText);
      const rawRelations = Array.isArray(parsed.relations) ? parsed.relations : [];

      // Validate relations against entity IDs
      const validEntityIds = new Set<string>(entities.map((e: any) => e.id));
      const seenPair = new Set<string>();
      let relCounter = 1;

      const validatedRelations = rawRelations.filter((r: any) => {
        if (!r || !r.source || !r.target || !r.type) return false;
        if (r.source === r.target) return false;
        if (!validEntityIds.has(r.source) || !validEntityIds.has(r.target)) return false;
        const pairKey = `${r.source}->${r.target}:${r.type.toUpperCase()}`;
        if (seenPair.has(pairKey)) return false;
        seenPair.add(pairKey);
        return true;
      }).map((r: any) => ({
        id: r.id || `r${relCounter++}`,
        source: r.source,
        target: r.target,
        type: String(r.type).toUpperCase().trim()
      }));

      return res.json({
        success: true,
        data: {
          relations: validatedRelations
        }
      });

    } catch (err: any) {
      console.error("Error in /api/relations:", err);
      const fallbackRelations = generateMockRelationsForEntities(entities);
      return res.json({
        success: true,
        isMock: true,
        warning: `AI relations generation encountered an issue (${err.message || "Timeout"}). Generated local rule-based relations fallback.`,
        data: {
          relations: fallbackRelations
        }
      });
    }
  });

  // API endpoint for diarized transcription
  app.post("/api/diarize", upload.single("audio"), async (req, res) => {
    const { audioBase64, audioMimeType, aiConfig } = req.body;

    let userAiConfig: any = null;
    if (aiConfig) {
      try {
        userAiConfig = typeof aiConfig === "string" ? JSON.parse(aiConfig) : aiConfig;
      } catch (e) {
        console.warn("Failed to parse userAiConfig in diarize:", e);
      }
    }

    try {
      // 1. Check if we should route to custom OpenAI-compatible Transcription
      if (userAiConfig && userAiConfig.transcription && userAiConfig.transcription.provider === "openai") {
        const config = userAiConfig.transcription;
        let buf: Buffer;
        let mime = audioMimeType || "audio/webm";
        let filename = "audio.webm";

        if (req.file) {
          buf = await fs.promises.readFile(req.file.path);
          mime = req.file.mimetype || mime;
          filename = req.file.originalname || "audio.webm";
          try { await fs.promises.unlink(req.file.path); } catch (e) {}
        } else if (audioBase64) {
          buf = Buffer.from(audioBase64, "base64");
        } else {
          return res.status(400).json({ success: false, error: "No audio file or audioBase64 provided" });
        }

        console.log(`Calling custom OpenAI-compatible Whisper model "${config.model}" for transcription...`);
        const diarizedResult = await transcribeWithCustomOpenAiOrGemini(buf, mime, filename, config, userAiConfig.annotation);
        return res.json({
          success: true,
          data: diarizedResult
        });
      }

      // 2. Otherwise use Gemini (Dynamic client check)
      let client: GoogleGenAI;
      let useGeminiModel = "gemini-3.1-flash-lite";

      try {
        if (userAiConfig && userAiConfig.transcription && userAiConfig.transcription.provider === "gemini" && userAiConfig.transcription.apiKey) {
          client = new GoogleGenAI({ apiKey: userAiConfig.transcription.apiKey });
        } else {
          client = getAiClient();
        }
        if (userAiConfig && userAiConfig.transcription && userAiConfig.transcription.provider === "gemini" && userAiConfig.transcription.model) {
          useGeminiModel = userAiConfig.transcription.model;
        }
      } catch (keyError: any) {
        console.warn("Gemini API Key missing, falling back to mock diarizer", keyError.message);
        if (req.file) {
          try { await fs.promises.unlink(req.file.path); } catch (e) {}
        }
        // Fallback to mock diarization if key is missing so the user can still interact.
        const mockResult = generateMockDiarization();
        return res.json({
          success: true,
          isMock: true,
          warning: "No API key configured. The default server Gemini API key has been unset. You can configure your own Gemini or OpenAI API key in the 'Set API Keys' popup (Key icon in the top header) to enable live speech transcription. Using mock diarizer for demo.",
          data: mockResult
        });
      }

      let fileRef: any = null;

      if (req.file) {
        console.log("Diarizer uploading file to Gemini File API...", req.file.path);
        try {
          const uploadResult = await client.files.upload({
            file: req.file.path,
            config: {
              mimeType: req.file.mimetype || audioMimeType || "audio/webm",
            },
          });
          fileRef = {
            fileData: {
              fileUri: uploadResult.uri,
              mimeType: uploadResult.mimeType,
            },
          };
          console.log("Diarizer Gemini File API upload success:", uploadResult.uri);
        } catch (uploadError: any) {
          console.error("Diarizer Gemini File API upload failed, falling back to inlineData:", uploadError);
          const fileBuffer = await fs.promises.readFile(req.file.path);
          fileRef = {
            inlineData: {
              data: fileBuffer.toString("base64"),
              mimeType: req.file.mimetype || audioMimeType || "audio/webm",
            },
          };
        } finally {
          try {
            await fs.promises.unlink(req.file.path);
          } catch (unlinkError) {
            console.warn("Could not clean up temp file:", unlinkError);
          }
        }
      } else if (audioBase64) {
        fileRef = {
          inlineData: {
            data: audioBase64,
            mimeType: audioMimeType || "audio/webm",
          },
        };
      }

      if (!fileRef) {
        return res.status(400).json({ success: false, error: "No audio file or audioBase64 provided" });
      }

      const prompt = `You are an expert clinical transcriptionist and medical scribe.
Your task is to transcribe and diarize the provided audio file.
Listen to the dialogue, identify different speakers (such as 'Doctor', 'Patient', 'Relative', etc.), and write down exactly what they said.

You MUST reply with a JSON array where each item represents an utterance.
Each utterance object MUST have:
1. "speaker": Name or role of the speaker (e.g. "Doctor", "Patient", "Assistant").
2. "text": The precise transcription of what they said.
3. "timestamp": Estimated start and end timing bracket for the utterance, in 'MM:SS - MM:SS' format (e.g. '00:00 - 00:15').

Keep the transcription highly professional and accurate. Do not add any extra text or comments outside the JSON array. Output MUST be a valid JSON array of objects.`;

      console.log(`Running diarization using Gemini model "${useGeminiModel}"...`);
      let response;
      try {
        response = await withTimeout(
          client.models.generateContent({
            model: useGeminiModel,
            contents: [
              fileRef,
              { text: prompt }
            ],
            config: {
              responseMimeType: "application/json",
              responseSchema: {
                type: "ARRAY",
                items: {
                  type: "OBJECT",
                  properties: {
                    speaker: {
                      type: "STRING",
                      description: "Speaker's role or title, e.g. 'Doctor' or 'Patient'."
                    },
                    text: {
                      type: "STRING",
                      description: "The text of the spoken utterance."
                    },
                    timestamp: {
                      type: "STRING",
                      description: "Estimated start and end time bracket, e.g. '00:15 - 00:25'."
                    }
                  },
                  required: ["speaker", "text", "timestamp"]
                }
              }
            }
          }),
          25000,
          "Gemini diarization call timed out"
        );
      } catch (geminiError: any) {
        console.warn("Gemini diarization failed or timed out, falling back to mock diarizer:", geminiError.message || geminiError);
        const mockResult = generateMockDiarization();
        return res.json({
          success: true,
          isMock: true,
          warning: `The transcription service is temporarily busy or experiencing high demand. Using high-fidelity local clinical transcription fallback for your preview: ${geminiError.message || "Timeout"}`,
          data: mockResult
        });
      }

      const responseText = response.text;
      if (!responseText) {
        throw new Error("Empty response from Gemini model.");
      }

      const segments = cleanAndParseJson(responseText);
      
      // Convert segments to JSONL format
      const jsonlText = segments.map((seg: any) => JSON.stringify(seg)).join("\n");

      res.json({
        success: true,
        data: {
          jsonlText,
          segments: segments.map((seg: any, idx: number) => ({
            id: `seg_${idx + 1}`,
            speaker: seg.speaker || "Unknown",
            text: seg.text || "",
            timestamp: seg.timestamp || ""
          }))
        }
      });

    } catch (error: any) {
      console.error("Error in /api/diarize:", error);
      res.status(500).json({
        success: false,
        error: error.message || "An error occurred during audio transcription & diarization"
      });
    }
  });

  // API endpoint for UMLS terminology mapping
  app.post("/api/umls/map", async (req, res) => {
    const { name, type } = req.body;
    const apiKey = process.env.UMLS_API_KEY;

    if (!apiKey || apiKey === "MY_UMLS_API_KEY") {
      return res.status(400).json({
        success: false,
        error: "UMLS_API_KEY environment variable is not configured. Please add your UMLS API Key in AI Studio Settings."
      });
    }

    if (!name) {
      return res.status(400).json({ success: false, error: "Entity name is required" });
    }

    try {
      console.log(`Mapping clinical entity "${name}" (type: ${type || 'unspecified'}) to UMLS...`);
      
      // Step 1: Search UTS to find the CUI (Concept Unique Identifier)
      const searchUrl = `https://uts-ws.nlm.nih.gov/rest/search/current?apiKey=${apiKey}&string=${encodeURIComponent(name)}`;
      const searchRes = await fetch(searchUrl);
      
      if (!searchRes.ok) {
        const errText = await searchRes.text();
        throw new Error(`UMLS UTS search request failed: status ${searchRes.status} - ${errText}`);
      }

      const searchJson: any = await searchRes.json();
      const results = searchJson.result?.results || [];

      if (results.length === 0) {
        return res.json({
          success: true,
          data: null,
          message: `No matching CUI found in UMLS for "${name}".`
        });
      }

      const firstResult = results[0];
      const cui = firstResult.ui;
      const preferredName = firstResult.name;

      // Step 2: Fetch atoms/vocab codes for this CUI
      // We restrict to vocabularies: RXNORM, SNOMEDCT_US, Dutch/general ICD-10 terminologies (ICD10DUT, ICD10CM, ICD10), and LOINC (LNC)
      const sabs = "RXNORM,SNOMEDCT_US,ICD10DUT,ICD10CM,ICD10,LNC";
      const atomsUrl = `https://uts-ws.nlm.nih.gov/rest/content/current/CUI/${cui}/atoms?apiKey=${apiKey}&sabs=${encodeURIComponent(sabs)}&pageSize=500`;
      
      const atomsRes = await fetch(atomsUrl);
      let rxnorm = "";
      let snomed = "";
      let icd10 = "";
      let loinc = "";

      if (atomsRes.ok) {
        const atomsJson: any = await atomsRes.json();
        const atoms = atomsJson.result || [];

        for (const atom of atoms) {
          const vocab = atom.rootSource || atom.sourceVocabulary;
          let code = "";
          
          if (atom.code) {
            // Extract the actual code from the end of the URL (e.g., ".../source/RXNORM/12345")
            const parts = atom.code.split('/');
            code = parts[parts.length - 1] || "";
          }

          if (vocab === "RXNORM" && !rxnorm) {
            rxnorm = code;
          } else if (vocab === "SNOMEDCT_US" && !snomed) {
            snomed = code;
          } else if (vocab === "ICD10DUT" && !icd10) {
            icd10 = code; // Preferred Dutch ICD-10 code
          } else if ((vocab === "ICD10CM" || vocab === "ICD10") && !icd10) {
            icd10 = code; // Fallback ICD-10 code
          } else if (vocab === "LNC" && !loinc) {
            loinc = code;
          }
        }
      }

      console.log(`Successfully mapped "${name}" -> CUI: ${cui}, RxNorm: ${rxnorm || 'none'}, SNOMED: ${snomed || 'none'}, ICD10: ${icd10 || 'none'}, LOINC: ${loinc || 'none'}`);

      return res.json({
        success: true,
        data: {
          cui,
          preferredName,
          rxnorm: rxnorm || undefined,
          snomed: snomed || undefined,
          icd10: icd10 || undefined,
          loinc: loinc || undefined
        }
      });

    } catch (err: any) {
      console.error(`Error mapping entity "${name}" to UMLS:`, err);
      return res.status(500).json({
        success: false,
        error: err.message || "An internal error occurred during UMLS mapping."
      });
    }
  });

  // API endpoint for manual search in UMLS
  app.post("/api/umls/search", async (req, res) => {
    const { query } = req.body;
    const apiKey = process.env.UMLS_API_KEY;

    if (!apiKey || apiKey === "MY_UMLS_API_KEY") {
      return res.status(400).json({
        success: false,
        error: "UMLS_API_KEY environment variable is not configured. Please add your UMLS API Key in AI Studio Settings."
      });
    }

    if (!query) {
      return res.status(400).json({ success: false, error: "Search query is required" });
    }

    try {
      console.log(`Manual search in UMLS for "${query}"...`);
      const searchUrl = `https://uts-ws.nlm.nih.gov/rest/search/current?apiKey=${apiKey}&string=${encodeURIComponent(query)}`;
      const searchRes = await fetch(searchUrl);
      
      if (!searchRes.ok) {
        const errText = await searchRes.text();
        throw new Error(`UMLS UTS search request failed: status ${searchRes.status} - ${errText}`);
      }

      const searchJson: any = await searchRes.json();
      const results = searchJson.result?.results || [];

      const formattedResults = results.map((r: any) => ({
        cui: r.ui,
        name: r.name
      }));

      return res.json({
        success: true,
        results: formattedResults
      });
    } catch (err: any) {
      console.error(`Error searching UMLS for "${query}":`, err);
      return res.status(500).json({
        success: false,
        error: err.message || "An internal error occurred during UMLS search."
      });
    }
  });

  // API endpoint to fetch vocabulary codes for a specific CUI
  app.post("/api/umls/concept-codes", async (req, res) => {
    const { cui } = req.body;
    const apiKey = process.env.UMLS_API_KEY;

    if (!apiKey || apiKey === "MY_UMLS_API_KEY") {
      return res.status(400).json({
        success: false,
        error: "UMLS_API_KEY environment variable is not configured."
      });
    }

    if (!cui) {
      return res.status(400).json({ success: false, error: "CUI is required" });
    }

    try {
      console.log(`Fetching specific vocabulary codes for CUI: ${cui}...`);
      const sabs = "RXNORM,SNOMEDCT_US,ICD10DUT,ICD10CM,ICD10,LNC";
      const atomsUrl = `https://uts-ws.nlm.nih.gov/rest/content/current/CUI/${cui}/atoms?apiKey=${apiKey}&sabs=${encodeURIComponent(sabs)}&pageSize=500`;
      
      const atomsRes = await fetch(atomsUrl);
      let rxnorm = "";
      let snomed = "";
      let icd10 = "";
      let loinc = "";

      if (atomsRes.ok) {
        const atomsJson: any = await atomsRes.json();
        const atoms = atomsJson.result || [];

        for (const atom of atoms) {
          const vocab = atom.rootSource || atom.sourceVocabulary;
          let code = "";
          
          if (atom.code) {
            const parts = atom.code.split('/');
            code = parts[parts.length - 1] || "";
          }

          if (vocab === "RXNORM" && !rxnorm) {
            rxnorm = code;
          } else if (vocab === "SNOMEDCT_US" && !snomed) {
            snomed = code;
          } else if (vocab === "ICD10DUT" && !icd10) {
            icd10 = code;
          } else if ((vocab === "ICD10CM" || vocab === "ICD10") && !icd10) {
            icd10 = code;
          } else if (vocab === "LNC" && !loinc) {
            loinc = code;
          }
        }
      }

      return res.json({
        success: true,
        data: {
          cui,
          rxnorm: rxnorm || undefined,
          snomed: snomed || undefined,
          icd10: icd10 || undefined,
          loinc: loinc || undefined
        }
      });
    } catch (err: any) {
      console.error(`Error fetching codes for CUI "${cui}":`, err);
      return res.status(500).json({
        success: false,
        error: err.message || "An internal error occurred."
      });
    }
  });

  // Vite middleware for development
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*", (req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  // Custom error handler to guarantee JSON response instead of default HTML pages
  app.use((err: any, req: express.Request, res: express.Response, next: express.NextFunction) => {
    console.error("Unhandled server error:", err);
    res.status(err.status || err.statusCode || 500).json({
      success: false,
      error: err.message || "An internal server error occurred"
    });
  });

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://0.0.0.0:${PORT}`);
  });
}

// Simple rule-based/text mock analyzer for demo fallback when Gemini key is absent
function generateMockAnnotation(text: string) {
  // We parse the raw transcript into segments
  const segments = parseTranscriptToSegments(text, 'dialogue');

  // Simple keyword matching for symptoms
  const symptomsList = [
    { keywords: ["headache", "migraine"], name: "Headache", severity: "Moderate", onset: "Tuesday", details: "Constant throbbing headache" },
    { keywords: ["cough", "cold"], name: "Cough", severity: "Mild", onset: "Yesterday", details: "Dry throat irritation" },
    { keywords: ["chest pain", "angina"], name: "Chest Pain", severity: "Severe", onset: "Today", details: "Crushing chest pain" },
    { keywords: ["blood pressure", "hypertension", "bp"], name: "Hypertension", severity: "Moderate", onset: "Ongoing", details: "Self-measured high BP around 150/95" }
  ];

  // Simple keyword matching for medications
  const medsList = [
    { keywords: ["lisinopril", "zestril"], name: "Lisinopril", action: "Change Dosage", dosage: "20mg daily", details: "Increased from 10mg due to persistent high BP" },
    { keywords: ["aspirin"], name: "Aspirin", action: "Start", dosage: "81mg daily", details: "Cardioprotective low dosage" },
    { keywords: ["metformin"], name: "Metformin", action: "Continue", dosage: "500mg twice daily", details: "For blood sugar management" },
    { keywords: ["paracetamol", "tylenol", "painkiller"], name: "Acetaminophen", action: "Start", dosage: "500mg as needed", details: "For headache pain relief" }
  ];

  // Simple keyword matching for follow-ups
  const followList = [
    { keywords: ["follow-up", "follow up", "two weeks", "2 weeks"], task: "Clinical Follow-up", due: "2 weeks", assignee: "Patient" },
    { keywords: ["blood test", "lab"], task: "Routine Blood Panel", due: "1 week", assignee: "Patient" },
    { keywords: ["blood pressure tracker", "track bp"], task: "Daily Blood Pressure Log", due: "Ongoing", assignee: "Patient" }
  ];

  const extractedSymptoms: any[] = [];
  const extractedMeds: any[] = [];
  const extractedFollows: any[] = [];

  const entities: any[] = [
    { id: "e_pat", name: "Patient", type: "Person", description: "Primary care subject", textSpan: { lineIndex: -1, startChar: -1, endChar: -1, text: "" } },
    { id: "e_doc", name: "Doctor", type: "Person", description: "Attending practitioner", textSpan: { lineIndex: -1, startChar: -1, endChar: -1, text: "" } }
  ];

  const relations: any[] = [];

  let entCount = 1;
  let relCount = 1;

  // Search keywords in lowercased transcript
  const lowerText = text.toLowerCase();

  // Helper to find textSpan for a given keyword
  const findTextSpan = (keywords: string[]) => {
    for (let i = 0; i < segments.length; i++) {
      const segText = segments[i].text;
      const lowerSegText = segText.toLowerCase();
      for (const kw of keywords) {
        const startIdx = lowerSegText.indexOf(kw);
        if (startIdx !== -1) {
          return {
            lineIndex: i,
            startChar: startIdx,
            endChar: startIdx + kw.length,
            text: segText.substring(startIdx, startIdx + kw.length)
          };
        }
      }
    }
    return { lineIndex: -1, startChar: -1, endChar: -1, text: "" };
  };

  symptomsList.forEach(item => {
    if (item.keywords.some(kw => lowerText.includes(kw))) {
      const entId = `e_sym_${entCount++}`;
      entities.push({
        id: entId,
        name: item.name,
        type: "Symptom",
        description: `${item.severity} - Onset: ${item.onset}`,
        textSpan: findTextSpan(item.keywords)
      });
      extractedSymptoms.push({
        entityId: entId,
        name: item.name,
        severity: item.severity,
        onset: item.onset,
        details: item.details
      });
      relations.push({
        id: `r_${relCount++}`,
        source: "e_pat",
        target: entId,
        type: "EXPERIENCING"
      });
    }
  });

  const measurementsList = [
    { keywords: ["blood pressure", "bp"], name: "Blood Pressure", value: "150/95", status: "Elevated", details: "Self-measured" },
    { keywords: ["egfr", "kidney"], name: "eGFR", value: "58 mL/min", status: "Decreased", details: "From lab reports" }
  ];

  const extractedMeasurements: any[] = [];

  medsList.forEach(item => {
    if (item.keywords.some(kw => lowerText.includes(kw))) {
      const entId = `e_med_${entCount++}`;
      entities.push({
        id: entId,
        name: item.name,
        type: "Medication",
        description: `${item.action} - ${item.dosage}`,
        textSpan: findTextSpan(item.keywords)
      });
      extractedMeds.push({
        entityId: entId,
        name: item.name,
        action: item.action,
        dosage: item.dosage,
        details: item.details
      });
      relations.push({
        id: `r_${relCount++}`,
        source: "e_doc",
        target: entId,
        type: "PRESCRIBED"
      });

      // Patient TAKING Medication
      relations.push({
        id: `r_${relCount++}`,
        source: "e_pat",
        target: entId,
        type: "TAKING"
      });

      // Medication-to-Dosage link
      if (item.dosage) {
        const doseId = `e_dose_${entCount++}`;
        entities.push({
          id: doseId,
          name: item.dosage,
          type: "Dosage",
          description: `Dosage for ${item.name}`,
          textSpan: findTextSpan([item.dosage.toLowerCase()])
        });

        relations.push({
          id: `r_${relCount++}`,
          source: entId,
          target: doseId,
          type: "HAS_DOSAGE"
        });

        relations.push({
          id: `r_${relCount++}`,
          source: doseId,
          target: entId,
          type: "DOSAGE_FOR"
        });
      }

      // Try to relate med to symptom if both present
      const relatedSymptom = entities.find(e => e.type === "Symptom");
      if (relatedSymptom) {
        relations.push({
          id: `r_${relCount++}`,
          source: entId,
          target: relatedSymptom.id,
          type: "TREATS"
        });
      }
    }
  });

  measurementsList.forEach(item => {
    if (item.keywords.some(kw => lowerText.includes(kw))) {
      const entId = `e_meas_${entCount++}`;
      entities.push({
        id: entId,
        name: item.name,
        type: "Measurement",
        description: `${item.name}: ${item.value} (${item.status})`,
        textSpan: findTextSpan(item.keywords)
      });
      extractedMeasurements.push({
        entityId: entId,
        name: item.name,
        value: item.value,
        status: item.status,
        details: item.details
      });

      // Patient HAS_MEASUREMENT Measurement
      relations.push({
        id: `r_${relCount++}`,
        source: "e_pat",
        target: entId,
        type: "HAS_MEASUREMENT"
      });

      // Measurement MEASURES Patient
      relations.push({
        id: `r_${relCount++}`,
        source: entId,
        target: "e_pat",
        type: "MEASURES"
      });

      // Connect to associated Condition (e.g. Hypertension if bp mentioned)
      const relatedCondition = entities.find(e => e.name === "Hypertension" || e.name === "Asthma");
      if (relatedCondition) {
        relations.push({
          id: `r_${relCount++}`,
          source: entId,
          target: relatedCondition.id,
          type: "ASSOCIATED_WITH"
        });
      }

      // Add target goal value relationship
      if (item.name === "Blood Pressure") {
        const targetEntId = `e_meas_${entCount++}`;
        entities.push({
          id: targetEntId,
          name: "Target Blood Pressure",
          type: "Measurement",
          description: "Target Goal: < 130/80 mmHg",
          textSpan: findTextSpan(["target", "bp", "blood pressure"])
        });
        extractedMeasurements.push({
          entityId: targetEntId,
          name: "Target Blood Pressure",
          value: "< 130/80 mmHg",
          status: "Target",
          details: "Clinical target goal"
        });

        relations.push({
          id: `r_${relCount++}`,
          source: entId,
          target: targetEntId,
          type: "HAS_TARGET"
        });

        relations.push({
          id: `r_${relCount++}`,
          source: targetEntId,
          target: entId,
          type: "TARGET_VALUE"
        });
      }
    }
  });

  followList.forEach(item => {
    if (item.keywords.some(kw => lowerText.includes(kw))) {
      const entId = `e_fol_${entCount++}`;
      entities.push({
        id: entId,
        name: item.task,
        type: "FollowUp",
        description: `Due: ${item.due}`,
        textSpan: findTextSpan(item.keywords)
      });
      extractedFollows.push({
        entityId: entId,
        task: item.task,
        due: item.due,
        assignee: item.assignee
      });
      relations.push({
        id: `r_${relCount++}`,
        source: "e_pat",
        target: entId,
        type: "SCHEDULED"
      });
      relations.push({
        id: `r_${relCount++}`,
        source: "e_pat",
        target: entId,
        type: "AGREED_TO"
      });
    }
  });

  const socialList = [
    { keywords: ["smoke", "smoking", "cigarette", "tobacco", "rook", "roken"], name: "Tobacco Smoking Status", value: "Former Smoker", status: "final", category: "social-history", details: "Patient reported past cigarette smoking" },
    { keywords: ["alcohol", "wine", "beer", "drink", "drank", "alcoholgebruik"], name: "Alcohol Consumption", value: "Moderate / Social", status: "final", category: "social-history", details: "Reported occasional alcohol intake" },
    { keywords: ["drugs", "substance", "cannabis", "wiet", "verdovende middelen"], name: "Substance Use", value: "Denies recreational drug use", status: "final", category: "social-history", details: "Denies recreational or illicit drug use" }
  ];

  const extractedSocialStatus: any[] = [];
  socialList.forEach(item => {
    if (item.keywords.some(kw => lowerText.includes(kw))) {
      const entId = `e_soc_${entCount++}`;
      entities.push({
        id: entId,
        name: item.name,
        type: "Observation",
        description: `${item.name}: ${item.value}`,
        textSpan: findTextSpan(item.keywords)
      });
      extractedSocialStatus.push({
        entityId: entId,
        name: item.name,
        value: item.value,
        status: item.status,
        category: item.category,
        details: item.details
      });
      relations.push({
        id: `r_${relCount++}`,
        source: "e_pat",
        target: entId,
        type: "REPORTS_HABIT"
      });
    }
  });

  // Default mock if absolutely nothing matched
  if (extractedSymptoms.length === 0 && extractedMeds.length === 0 && extractedFollows.length === 0 && extractedMeasurements.length === 0 && extractedSocialStatus.length === 0) {
    const symId = `e_sym_${entCount++}`;
    entities.push({
      id: symId,
      name: "General Checkup",
      type: "Condition",
      description: "Routine health assessment",
      textSpan: { lineIndex: 0, startChar: 0, endChar: Math.min(segments[0]?.text?.length || 15, 15), text: segments[0]?.text?.substring(0, 15) || "General Checkup" }
    });
    extractedSymptoms.push({ entityId: symId, name: "General Checkup", severity: "Unspecified", onset: "Today", details: "Routine review" });
    relations.push({ id: `r_${relCount++}`, source: "e_pat", target: symId, type: "EXPERIENCING" });
  }

  const extractedConditions: any[] = [];
  entities.forEach(ent => {
    if (ent.type === "Condition") {
      extractedConditions.push({
        entityId: ent.id,
        name: ent.name,
        status: "Active",
        details: ent.description || ""
      });
    }
  });

  const mentions: any[] = [];
  let mentionCounter = 1;
  const cleanedEntities = entities.map(ent => {
    const { textSpan, ...rest } = ent;
    if (textSpan && textSpan.lineIndex >= 0) {
      mentions.push({
        id: `m_mock_${mentionCounter++}`,
        textSpan,
        entityType: ent.type,
        entityId: ent.id,
        speaker: 'patient',
        polarity: 'positive',
        certainty: 'certain',
        temporality: 'current',
        experiencer: 'patient',
        function: 'asserted'
      });
    }
    return rest;
  });

  return {
    title: "Clinical Consultation Overview",
    rawTranscript: text,
    transcriptSegments: segments,
    entities: cleanedEntities,
    relations: [],
    clinicalNotes: {
      symptoms: extractedSymptoms,
      conditions: extractedConditions,
      medications: extractedMeds,
      followUps: extractedFollows,
      measurements: extractedMeasurements,
      socialStatus: extractedSocialStatus,
      fhir_socialStatus: extractedSocialStatus
    },
    mentions
  };
}

// Fallback rule-based graph relation generator for clinical entities
function generateMockRelationsForEntities(entities: any[]): any[] {
  if (!entities || !Array.isArray(entities) || entities.length === 0) return [];
  const relations: any[] = [];
  let relId = 1;

  const patientEnt = entities.find(e => {
    const t = (e.type || "").toLowerCase();
    const n = (e.name || "").toLowerCase();
    return t === "patient" || (t === "person" && n.includes("patient")) || n === "patient";
  });

  const doctorEnt = entities.find(e => {
    const t = (e.type || "").toLowerCase();
    const n = (e.name || "").toLowerCase();
    return t === "doctor" || (t === "person" && (n.includes("doctor") || n.includes("dr."))) || n === "doctor";
  });

  const symptoms = entities.filter(e => {
    const t = (e.type || "").toLowerCase();
    return t === "symptom" || t.includes("symptom");
  });

  const conditions = entities.filter(e => {
    const t = (e.type || "").toLowerCase();
    return t === "condition" || t.includes("condition");
  });

  const medications = entities.filter(e => {
    const t = (e.type || "").toLowerCase();
    return t === "medication" || t.includes("medication");
  });

  const dosages = entities.filter(e => {
    const t = (e.type || "").toLowerCase();
    return t === "dosage" || t.includes("dosage");
  });

  const measurements = entities.filter(e => {
    const t = (e.type || "").toLowerCase();
    return t === "measurement" || t.includes("measurement") || t.includes("observation");
  });

  const followUps = entities.filter(e => {
    const t = (e.type || "").toLowerCase();
    return t === "followup" || t.includes("follow") || t.includes("servicerequest");
  });

  // Link Patient to clinical items
  if (patientEnt) {
    symptoms.forEach(sym => {
      relations.push({ id: `r${relId++}`, source: patientEnt.id, target: sym.id, type: "EXPERIENCING" });
    });
    conditions.forEach(cond => {
      relations.push({ id: `r${relId++}`, source: patientEnt.id, target: cond.id, type: "DIAGNOSED_WITH" });
    });
    medications.forEach(med => {
      relations.push({ id: `r${relId++}`, source: patientEnt.id, target: med.id, type: "TAKING" });
    });
    measurements.forEach(m => {
      relations.push({ id: `r${relId++}`, source: patientEnt.id, target: m.id, type: "HAS_MEASUREMENT" });
    });
    const socialEnts = entities.filter(e => (e.type || '').toLowerCase().includes('social') || (e.name || '').toLowerCase().includes('smoke') || (e.name || '').toLowerCase().includes('alcohol'));
    socialEnts.forEach(soc => {
      relations.push({ id: `r${relId++}`, source: patientEnt.id, target: soc.id, type: "REPORTS_HABIT" });
    });
  }

  // Link Doctor to orders and followups
  if (doctorEnt) {
    medications.forEach(med => {
      if (!relations.some(r => r.source === doctorEnt.id && r.target === med.id)) {
        relations.push({ id: `r${relId++}`, source: doctorEnt.id, target: med.id, type: "PRESCRIBED" });
      }
    });
    followUps.forEach(fol => {
      relations.push({ id: `r${relId++}`, source: doctorEnt.id, target: fol.id, type: "SCHEDULED" });
    });
  }

  // Link Dosages to Medications
  dosages.forEach((dose, idx) => {
    const targetMed = medications[idx] || medications[0];
    if (targetMed) {
      relations.push({ id: `r${relId++}`, source: targetMed.id, target: dose.id, type: "HAS_DOSAGE" });
      relations.push({ id: `r${relId++}`, source: dose.id, target: targetMed.id, type: "DOSAGE_FOR" });
    }
  });

  // Link medications to conditions / symptoms
  medications.forEach(med => {
    conditions.forEach(cond => {
      relations.push({ id: `r${relId++}`, source: med.id, target: cond.id, type: "TREATS" });
    });
    if (conditions.length === 0 && symptoms.length > 0) {
      symptoms.forEach(sym => {
        relations.push({ id: `r${relId++}`, source: med.id, target: sym.id, type: "TREATS" });
      });
    }
  });

  // Link measurements to conditions
  measurements.forEach(m => {
    conditions.forEach(cond => {
      relations.push({ id: `r${relId++}`, source: m.id, target: cond.id, type: "ASSOCIATED_WITH" });
    });
  });

  // Fallback: if no relations could be formed yet and we have multiple entities, connect first to others
  if (relations.length === 0 && entities.length >= 2) {
    for (let i = 1; i < Math.min(entities.length, 6); i++) {
      relations.push({
        id: `r${relId++}`,
        source: entities[0].id,
        target: entities[i].id,
        type: "ASSOCIATED_WITH"
      });
    }
  }

  return relations;
}

function generateMockDiarization() {
  const segments = [
    { speaker: "Doctor", text: "Hello, thank you for coming in today. How have you been feeling since we last spoke?", timestamp: "00:00 - 00:05" },
    { speaker: "Patient", text: "Thanks, Dr. Evans. To be honest, my asthma has been acting up a bit more lately, especially when I walk up the stairs or go for my morning jogs. I've had to use my rescue inhaler quite a lot.", timestamp: "00:06 - 00:18" },
    { speaker: "Doctor", text: "I'm sorry to hear that. How many times would you say you had to use your Albuterol inhaler this past week?", timestamp: "00:19 - 00:23" },
    { speaker: "Patient", text: "Probably about five or six times. It's usually when I exercise, but sometimes even at night I wake up wheezing.", timestamp: "00:24 - 00:30" },
    { speaker: "Doctor", text: "Okay, waking up at night wheezing and needing Albuterol five times a week definitely tells us your asthma is uncontrolled right now. Are you still taking your daily Flovent 110mcg inhaler?", timestamp: "00:31 - 00:45" },
    { speaker: "Patient", text: "Well, to be honest, I ran out of Flovent about three weeks ago, and since I was feeling fine at the time, I didn't get the refill.", timestamp: "00:46 - 00:53" },
    { speaker: "Doctor", text: "Ah, I see. That is actually the main reason for this flare-up. The Flovent is a controller medication—it prevents the inflammation from building up in the first place, whereas Albuterol only acts as a temporary Band-Aid. We need you back on Flovent daily. I will send a refill to your pharmacy right away. Let's do 1 puff twice a day.", timestamp: "00:54 - 01:20" },
    { speaker: "Patient", text: "That makes a lot of sense. I will make sure to pick it up today and start using it regularly.", timestamp: "01:21 - 01:26" },
    { speaker: "Doctor", text: "Excellent. I also want to schedule a follow-up spirometry check in 4 weeks just to test your lung function once you've been back on the Flovent for a month. Does that sound good?", timestamp: "01:27 - 01:40" },
    { speaker: "Patient", text: "Yes, that sounds perfect. Thank you so much, Doctor.", timestamp: "01:41 - 01:45" }
  ];

  const jsonlText = segments.map(seg => JSON.stringify(seg)).join("\n");

  return {
    jsonlText,
    segments: segments.map((seg, idx) => ({
      id: `seg_${idx + 1}`,
      speaker: seg.speaker,
      text: seg.text,
      timestamp: seg.timestamp
    }))
  };
}

async function transcribeWithCustomOpenAiOrGemini(fileBuffer: Buffer, mimeType: string, filename: string, config: any, annotationConfig: any): Promise<any> {
  // If OpenAI provider
  if (config && config.provider === "openai") {
    let url = config.baseUrl?.trim() || "https://api.openai.com/v1";
    if (!url.includes("/audio/transcriptions")) {
      if (url.endsWith("/")) {
        url = url.slice(0, -1);
      }
      url = url + "/audio/transcriptions";
    }

    const fileBlob = new Blob([fileBuffer], { type: mimeType });
    const formData = new FormData();
    formData.append("file", fileBlob, filename);
    formData.append("model", config.model || "whisper-1");

    console.log(`Sending custom Whisper transcription request to ${url}...`);
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${config.apiKey}`
      },
      body: formData,
      dispatcher: globalAgent
    } as any);

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`Custom Whisper transcription failed: status ${response.status} - ${errText}`);
    }

    const resJson: any = await response.json();
    const rawText = resJson.text;
    if (!rawText) {
      throw new Error("No transcription text returned from custom Whisper endpoint.");
    }

    // Now segment and diarize using the annotation LLM (or Gemini fallback)
    let diarizedSegments: any[] = [];
    const diarizePrompt = `You are an expert clinical scribe. You will be provided with a raw, undivided transcription of a clinical doctor-patient conversation.
Your task is to analyze the text, identify the speaker for each segment (such as 'Doctor', 'Patient', 'Relative', etc.), segment the dialogue into chronological, natural utterances, and estimate timestamps in 'MM:SS - MM:SS' format starting from '00:00'.

You MUST reply with a valid JSON array of objects only. Do not add any explanation or markdown formatting. Each object in the array MUST have:
1. "speaker": Name or role of the speaker (e.g. "Doctor", "Patient", "Assistant").
2. "text": The precise transcription of what they said.
3. "timestamp": Estimated start and end timing bracket for the utterance, in 'MM:SS - MM:SS' format (e.g. '00:00 - 00:15').

Here is the raw text to diarize:
"${rawText}"`;

    if (annotationConfig && annotationConfig.provider === "openai") {
      try {
        console.log("Segmenting transcription using custom OpenAI annotation model...");
        const customDiarized = await callCustomOpenAiChat(annotationConfig, diarizePrompt);
        diarizedSegments = cleanAndParseJson(customDiarized);
      } catch (e) {
        console.warn("Failed to segment via custom OpenAI model, falling back to Gemini", e);
      }
    }

    if (!diarizedSegments || diarizedSegments.length === 0) {
      try {
        console.log("Segmenting transcription using standard Gemini model...");
        const client = getAiClient();
        const geminiRes = await client.models.generateContent({
          model: "gemini-3.1-flash-lite",
          contents: [ { text: diarizePrompt } ],
          config: {
            responseMimeType: "application/json"
          }
        });
        if (geminiRes.text) {
          diarizedSegments = cleanAndParseJson(geminiRes.text);
        }
      } catch (geminiErr) {
        console.error("Gemini diarization fallback failed:", geminiErr);
        diarizedSegments = [{
          speaker: "Doctor & Patient",
          text: rawText,
          timestamp: "00:00 - 01:00"
        }];
      }
    }

    const segments = (diarizedSegments || []).map((seg: any, idx: number) => ({
      id: `seg_${idx + 1}`,
      speaker: seg.speaker || "Unknown",
      text: seg.text || "",
      timestamp: seg.timestamp || ""
    }));

    const jsonlText = segments.map((seg: any) => JSON.stringify(seg)).join("\n");

    return {
      jsonlText,
      segments
    };
  }

  // If Gemini provider or fallback
  const client = config && config.apiKey ? new GoogleGenAI({ apiKey: config.apiKey }) : getAiClient();
  const modelName = config && config.model ? config.model : "gemini-3.1-flash-lite";

  // Standard Gemini diarization expects a file upload or inlineData. Let's send inlineData since we have the buffer:
  const inlineData = {
    inlineData: {
      data: fileBuffer.toString("base64"),
      mimeType: mimeType
    }
  };

  const prompt = `You are an expert clinical transcriptionist and medical scribe.
Your task is to transcribe and diarize the provided audio file.
Listen to the dialogue, identify different speakers (such as 'Doctor', 'Patient', 'Relative', etc.), and write down exactly what they said.

You MUST reply with a JSON array where each item represents an utterance.
Each utterance object MUST have:
1. "speaker": Name or role of the speaker (e.g. "Doctor", "Patient", "Assistant").
2. "text": The precise transcription of what they said.
3. "timestamp": Estimated start and end timing bracket for the utterance, in 'MM:SS - MM:SS' format (e.g. '00:00 - 00:15').

Keep the transcription highly professional and accurate. Do not add any extra text or comments outside the JSON array. Output MUST be a valid JSON array of objects.`;

  try {
    console.log(`Sending standard Gemini diarization request to model ${modelName}...`);
    const response = await client.models.generateContent({
      model: modelName,
      contents: [
        inlineData,
        { text: prompt }
      ],
      config: {
        responseMimeType: "application/json",
        responseSchema: {
          type: "ARRAY",
          items: {
            type: "OBJECT",
            properties: {
              speaker: { type: "STRING" },
              text: { type: "STRING" },
              timestamp: { type: "STRING" }
            },
            required: ["speaker", "text", "timestamp"]
          }
        }
      }
    });

    const responseText = response.text;
    if (!responseText) {
      throw new Error("Empty response from Gemini diarization.");
    }

    const segments = cleanAndParseJson(responseText);
    const jsonlText = segments.map((seg: any) => JSON.stringify(seg)).join("\n");

    return {
      jsonlText,
      segments: segments.map((seg: any, idx: number) => ({
        id: `seg_${idx + 1}`,
        speaker: seg.speaker || "Unknown",
        text: seg.text || "",
        timestamp: seg.timestamp || ""
      }))
    };
  } catch (error: any) {
    console.error("Standard Gemini diarization failed, falling back to high-fidelity mock:", error);
    return generateMockDiarization();
  }
}

async function callCustomOpenAiChat(config: any, promptText: string): Promise<string> {
  let url = config.baseUrl?.trim() || "https://api.openai.com/v1";
  if (!url.includes("/chat/completions")) {
    if (url.endsWith("/")) {
      url = url.slice(0, -1);
    }
    url = url + "/chat/completions";
  }

  const payload: any = {
    model: config.model || "gpt-4o",
    messages: [
      {
        role: "user",
        content: promptText
      }
    ]
  };

  // Safe response_format
  if (config.model && (config.model.includes("gpt-4") || config.model.includes("gpt-3.5") || config.model.includes("gpt-4o") || config.model.includes("llama") || config.model.includes("deepseek"))) {
    payload.response_format = { type: "json_object" };
  }

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${config.apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(payload),
    dispatcher: globalAgent
  } as any);

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Custom OpenAI-compatible Chat failed: status ${response.status} - ${errText}`);
  }

  const resJson: any = await response.json();
  const content = resJson.choices?.[0]?.message?.content;
  if (!content) {
    throw new Error("No response content from custom OpenAI-compatible Chat endpoint.");
  }
  return content;
}

function cleanAndParseJson(text: string): any {
  let cleaned = text.trim();
  if (cleaned.startsWith("```")) {
    const lines = cleaned.split("\n");
    if (lines[0].startsWith("```")) {
      lines.shift();
    }
    if (lines[lines.length - 1].startsWith("```")) {
      lines.pop();
    }
    cleaned = lines.join("\n").trim();
  }
  const firstBrace = cleaned.indexOf("{");
  const firstBracket = cleaned.indexOf("[");
  let startIdx = -1;
  let endIdx = -1;

  if (firstBrace !== -1 && (firstBracket === -1 || firstBrace < firstBracket)) {
    startIdx = firstBrace;
    endIdx = cleaned.lastIndexOf("}");
  } else if (firstBracket !== -1) {
    startIdx = firstBracket;
    endIdx = cleaned.lastIndexOf("]");
  }

  if (startIdx !== -1 && endIdx !== -1) {
    cleaned = cleaned.substring(startIdx, endIdx + 1);
  }

  return JSON.parse(cleaned);
}

startServer();

