import express from "express";
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { aiTimeoutMs, aiLogPath, callOpenAiChat, logAi, runAiRequest, wrapAiError, type AiRunContext, type AiRequestContext } from './server/aiRequests';
import { normalizeEvidence, isEntityEvidence } from "./src/utils/evidence";
import { normalizeMentionContext } from "./src/utils/mentionContext";
import { validateEncounterTime } from "./src/utils/temporal";
import type { TemporalValue } from "./src/utils/temporal";
import path from "path";
import { createServer as createViteServer } from "vite";
import { GoogleGenAI } from "@google/genai";
import dotenv from "dotenv";
import multer from "multer";
import fs from "fs";
import { Agent, fetch } from "undici";
import { tmpdir } from "node:os";
import { createServer as createHttpServer } from "node:http";
import { LocalDatabase } from "./server/database";
import { localApi, localOnly } from "./server/localApi";
import { legacyArchiveApi } from './server/legacyArchive';
import { firebaseConfig, firebaseServices, requireFirebaseUser } from './server/firebase';
import { FirestoreDatabase } from './server/firestoreDatabase';
import { aiExtractionConcurrency, mapConcurrent } from "./server/concurrency";
import { parseTranscriptToSegments } from "./src/utils/transcriptParser";
import { DEFAULT_ANNOTATION_SCHEMA, normalizeAnnotationSchema } from "./src/types";
import type { AnnotationProgress } from './src/types';

dotenv.config();

// Configure undici fetch timeout globally to handle slow/complex AI requests
const globalAgent = new Agent({
  headersTimeout: 600000, // 10 minutes
  bodyTimeout: 600000,    // 10 minutes
  connectTimeout: 120000, // 2 minutes
});

const upload = multer({ dest: tmpdir(), limits: { fileSize: 50 * 1024 * 1024 } });
const audioUpload: express.RequestHandler = (req, res, next) => {
  upload.single("audio")(req, res, (error) => {
    if (req.file) {
      const filename = req.file.path;
      res.once("close", () => { void fs.promises.rm(filename, { force: true }).catch(console.error); });
    }
    next(error);
  });
};

// Lazy initialization of Gemini client
let aiClient: GoogleGenAI | null = null;

function getAiClient(): GoogleGenAI {
  if (!aiClient) {
    const key = process.env.GEMINI_API_KEY;
    if (!key || key === "MY_GEMINI_API_KEY") {
      throw Object.assign(new Error("Configure an AI provider in Settings to use AI features. Manual annotation requires no API key."), { status: 503 });
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

async function extractMentionsForUtterance(
  client: GoogleGenAI | null,
  modelName: string,
  targetSegment: { id: string; speaker: string; text: string; lineIndex: number },
  allSegments: { id: string; speaker: string; text: string }[],
  schemaObj?: any[],
  encounterType?: string,
  annotationConfig?: any,
  retryCount: number = 0,
  runContext: AiRunContext = { requestId: randomUUID() }
): Promise<any[]> {
  if (!targetSegment.text?.trim()) {
    return [];
  }

  const activeSchema = schemaObj?.length ? schemaObj : DEFAULT_ANNOTATION_SCHEMA;

  const uniqueEntityTypes = new Set<string>();
  activeSchema.forEach((cat: any) => {
    if (cat.id) uniqueEntityTypes.add(cat.id);
  });
  uniqueEntityTypes.add('Person');
  uniqueEntityTypes.add('Other');
  const allowedTypes = Array.from(uniqueEntityTypes);

  const targetIndex = targetSegment.lineIndex;

  const schemaGuidelines = activeSchema.map((cat: any) => {
    return `- Category ID: "${cat.id}" (Display Name: "${cat.displayName}", Entity Type: "${cat.entityType}"): ${cat.typeHint || ''}`;
  }).join("\n");

  const antiOverextractionRules = `Anti-Overextraction Guardrails:
1. Extract clinical facts only: symptoms, diagnoses, medications, lab/vital measurements, procedures, and clear follow-up plans.
2. Conversational greetings, politeness expressions, or administrative pleasantries MUST NOT be extracted.
3. Pronouns or generic referents without clear antecedent clinical meaning MUST NOT be extracted.
4. Each extracted mention MUST have verbatim "literalText" physically present in the TARGET UTTERANCE.
5. Extract clinically relevant time phrases as attribute evidence: symptom onset, resolutionTime or duration; measurement effectiveTime. Keep the phrase linked to the owning event, not a standalone temporal entity. Do not confuse duration with onset.
6. Extract explicit clinical change and its comparison phrase as trajectory attribute evidence when the schema has a trajectory-typed field, e.g. 'worse than a week ago' -> trajectory on the owning symptom/condition/measurement. Use the exact schema field name for custom trajectory attributes. Comparison time is not onset or measurement time. Do not infer improved/worsened from a numeric increase/decrease alone.
7. When the owning category has diagnosticAssessment, extract clinical assessment cues as evidence for that field: e.g. 'no grounds to believe', explicit symptom denial, or explicit exclusion. They are NOT result workflow status evidence. Keep them linked to the relevant clinical finding; do not create standalone negation entities.`;

  // Keep conversational context while extracting only from this utterance.
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
Your task is to analyze exactly one TARGET utterance (utterance ${targetIndex}) from a ${docType}.
Extract every distinct clinical mention and attribute-evidence span in this utterance; do not summarize it into a single mention. An utterance may contain several findings, values, times, or claims. Before returning, check the entire target for any omitted clinical facts or evidence spans.

CRITICAL BOUNDARY MANDATE:
You MUST ONLY extract clinical mentions from the TARGET UTTERANCE (index ${targetIndex})!
Use the preceding and succeeding context utterances ONLY for pronoun resolution, reference disambiguation, polarity, and clinical intent. NEVER extract mentions from the context utterances!

CONVERSATIONAL CONFIRMATION & NEGATION MANDATE (ANAPHORA & ELLIPSIS):
In clinical dialogues, clinicians regularly screen for symptoms, conditions, medications, or allergies by asking questions (e.g., "Any rash or skin issues?", "Last van uw gewrichten? Polsen, knieën, ellebogen?", "Do you take blood thinners?"). Patients routinely answer using conversational confirmations or denials WITHOUT repeating the medical term (e.g., "Nee, niet opgevallen", "No, none at all", "Geen last van", "Nee", "Nee, helemaal niet", "Ja, klopt", "Zeker, al een paar dagen", "Helemaal niet").

When a TARGET UTTERANCE provides a confirmation, denial, or answer to a clinical symptom/condition/medication queried in context:
1. Extract the verbatim confirmation or denial phrase from the TARGET UTTERANCE as an elliptical clinical mention (e.g. literalText: "Nee, niet opgevallen", "No, none at all", "Geen last van", "Nee", "Ja, klopt", "Helemaal niet").
2. Set "canonicalName" to the standardized English clinical concept that was queried in context and is being answered (e.g., "Skin Rash", "Joint Pain", "Headache").
3. Set "type" to the schema category of the queried concept (e.g., "symptoms", "conditions", "medications").
4. Set "polarity": "negative" if denied/absent, "positive" if affirmed/confirmed.
5. Set "evidenceRole": "claim" and "function": "asserted". These answers support a claim; they are not name-only references.

EVIDENCE ROLE AND CLAIM CONTEXT:
- evidenceRole is independent of evidenceTarget: reference identifies/names a referent; claim supports a specific proposition (including a question or hypothetical proposition); unassigned means the role has not been determined. An entity target is NOT automatically a reference: an explicit affirmation or denial can support an entity-level claim.
- Separate a name-only reference from its result/assessment when they have distinct spans. In "kidney function may be reduced", "kidney function" is reference evidence for the entity; "may be reduced" is claim evidence for its interpretation attribute, with certainty uncertain and function asserted. Asserted and uncertain are compatible.
- Certainty is the speaker's commitment to the supported clinical claim, NEVER confidence in extraction, concept recognition, or entity linking. For reference mentions use certainty not_applicable, not certain. Do not transfer result uncertainty to the name mention.
- Function describes speech use: asserted, questioned, hypothetical, explanatory. For a bare reference use function not_applicable unless a contextual speech function is useful: "How is your kidney function?" can have reference + questioned + certainty not_applicable, without implying an abnormal result.
- For name/reference mentions default polarity to neutral and temporality to not_applicable. Temporality describes the supported claim, not the topic's existence or the tense of a surrounding question. In "kidney function is stable now; will it remain stable?", the name is reference + neutral + temporality not_applicable; "stable now" is a current asserted claim and "will it remain stable?" is a future questioned claim. Do not copy future temporality to the bare name. A future question is not evidence of a future result.
- not_applicable means this dimension does not apply; unassigned means it has not been annotated or cannot yet be determined. Do not invent certain/asserted/positive/current/patient defaults for missing context. Preserve the scope of uncertainty/negation cues, including when the cue is outside the minimal name span.

Active Clinical Schema Categories:
${schemaGuidelines}

Classification Guidelines:
${antiOverextractionRules}

Preceding Context:
${contextBeforeStr}

TARGET UTTERANCE (${targetIndex}):
${targetUtteranceStr}

Succeeding Context:
${contextAfterStr}

For every clinical mention found in the TARGET UTTERANCE, output a JSON object with:
- "lineIndex": integer (must be ${targetIndex}, the TARGET Utterance number where this mention literally appears)
- "literalText": string (the exact verbatim word or phrase as it appears in that TARGET Utterance)
- "canonicalName": string (standardized clinical concept name in English, e.g. 'Headache', 'Hypertension', 'Lisinopril')
- "type": string (category ID from active schema: ${allowedTypes.join(' | ')})
- "description": string (brief clinical context or details)
- "evidenceRole": "unassigned" | "reference" | "claim"
- "polarity": "unassigned" | "positive" | "negative" | "neutral"
- "certainty": "unassigned" | "not_applicable" | "certain" | "uncertain" | "hypothetical"
- "temporality": "unassigned" | "not_applicable" | "current" | "past" | "future"
- "experiencer": "unassigned" | "patient" | "family" | "other"
- "function": "unassigned" | "not_applicable" | "asserted" | "questioned" | "hypothetical" | "explanatory"
- "evidenceTarget": {"kind":"entity"} if this span names the entity itself; {"kind":"attribute","attributeName":"exact schema field"} if it supports only a specific field (e.g. '20mg' -> dosage, 'Tuesday' -> onset, 'moderate' -> severity). Use the owning entity's canonicalName/type for attribute spans; do not create a separate entity for a dosage or onset.

Return JSON ONLY:
{
  "mentions": [
    {
      "lineIndex": ${targetIndex},
      "literalText": "sample literal text",
      "canonicalName": "Sample Concept",
      "type": "symptoms",
      "description": "brief description",
      "evidenceRole": "claim",
      "polarity": "positive",
      "certainty": "certain",
      "temporality": "current",
      "experiencer": "patient",
      "function": "asserted",
      "evidenceTarget": {"kind": "attribute", "attributeName": "value"}
    }
  ]
}`;

  const MAX_RETRIES = 2;
  const requestContext: AiRequestContext = { ...runContext, stage: 'mention-extraction', utteranceIndex: targetIndex, attempt: retryCount + 1 };

  try {
    let text = "";
    if (annotationConfig && annotationConfig.provider === "openai") {
      text = await callCustomOpenAiChat(annotationConfig, prompt, requestContext);
    } else if (client) {
      const response = await runAiRequest(requestContext, { provider: 'gemini', model: modelName, promptChars: prompt.length }, signal =>
        client.models.generateContent({
          model: modelName,
          contents: [{ text: prompt }],
          config: {
            responseMimeType: "application/json", abortSignal: signal, httpOptions: { timeout: aiTimeoutMs() }
          }
        })
      );
      text = response.text || "";
    } else {
      throw new Error("No AI client available for mention extraction");
    }

    if (!text) throw new Error("The AI provider returned an empty mention extraction response");

    const data = cleanAndParseJson(text);
    const mentions = data.mentions || [];

    const results: any[] = [];
    for (const m of mentions) {
      const literal = typeof m.literalText === 'string' ? m.literalText.trim() : '';
      if (!literal) throw new Error('AI mention is missing its verbatim source text');

      const rawLineIdx = typeof m.lineIndex === 'number' ? m.lineIndex : parseInt(String(m.lineIndex), 10);
      if (rawLineIdx !== targetIndex) throw new Error('AI mention must reference the target utterance, not its context');
      const targetSeg = targetSegment;
      const resolvedLineIndex = targetIndex;

      let startChar = -1;
      let endChar = -1;
      let exactText = "";

      const idx = targetSeg.text.toLowerCase().indexOf(literal.toLowerCase());
      if (idx >= 0) {
        startChar = idx;
        endChar = idx + literal.length;
        exactText = targetSeg.text.substring(startChar, endChar);
      } else {
        throw new Error('AI mention does not match its source utterance');
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

      results.push(normalizeMentionContext({
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
        evidenceRole: m.evidenceRole ?? 'unassigned',
        polarity: m.polarity,
        certainty: m.certainty,
        temporality: m.temporality,
        experiencer: m.experiencer || "unassigned",
        function: m.function,
        // The clustering stage resolves this temporary field name to a stable attribute ID.
        supportedAttribute: m.evidenceTarget?.kind === 'attribute'
          ? String(m.evidenceTarget.attributeName || '').trim()
          : m.evidenceTarget?.kind === 'entity' ? undefined
          : String(m.supportedAttribute || m.supported_attribute || '').trim() || undefined,
        entityId: null
      }));
    }

    logAi(requestContext, 'extraction_validated', { mentionCount: results.length });
    return results;
  } catch (error: any) {
    if (retryCount < MAX_RETRIES && !runContext.signal?.aborted) {
      const backoffMs = (retryCount + 1) * 2000;
      logAi(requestContext, 'retry_scheduled', { reason: error.code || 'EXTRACTION_FAILED', retryDelayMs: backoffMs });
      await delay(backoffMs, undefined, { signal: runContext.signal });
      return extractMentionsForUtterance(
        client,
        modelName,
        targetSegment,
        allSegments,
        schemaObj,
        encounterType,
        annotationConfig,
        retryCount + 1,
        runContext
      );
    }
    throw wrapAiError(error, `Mention extraction failed for utterance ${targetIndex}`);
  }
}

function normalizeItemAttributesToSchema(itemAttributes: Record<string, any>, cat: any): Record<string, any> {
  if (!cat || !Array.isArray(cat.attributes)) return { ...itemAttributes };

  const normalized: Record<string, any> = { ...itemAttributes };

  const aliasMap: Record<string, string[]> = {
    clinicalstatus: ['clinical_status', 'conditionstatus'],
    status: [],
    verificationstatus: ['verification_status'],
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

    // Entity IDs are assigned after clustering. Never persist model-invented procedure references.
    if (attr.type === 'procedure-reference') {
      normalized[attr.name] = null;
      continue;
    }
    // Temporal roles are not aliases. A duration must never become an onset/effective date.
    if (attr.type === 'temporal' || attr.type === 'trajectory') {
      normalized[attr.name] = val ?? null;
      continue;
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

  return normalized;
}

// Fallback deterministic mention clustering
async function clusterMentionsIntoEntities(
  client: GoogleGenAI | null,
  modelName: string,
  mentions: any[],
  activeSchema: any[],
  fullTranscriptText: string,
  annotationConfig?: any,
  encounterTime?: TemporalValue | null,
  runContext: AiRunContext = { requestId: randomUUID() }
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
    evidenceRole: m.evidenceRole,
    polarity: m.polarity,
    temporality: m.temporality,
    certainty: m.certainty,
    experiencer: m.experiencer,
    function: m.function,
    evidenceTarget: m.supportedAttribute
      ? { kind: 'attribute', attributeName: m.supportedAttribute } : { kind: 'entity' },
    description: m.description,
    utteranceIndex: m.textSpan?.lineIndex
  }));

  const dynamicSchemaGuidelines = activeSchema.map(cat => {
    const attrList = (cat.attributes || []).map((a: any) => `${a.name} (${a.type}${a.choices ? `: [${a.choices.join(', ')}]` : ''})`).join(', ');
    return `- Category ID "${cat.id}" (Display Name: "${cat.displayName}", Entity Type: "${cat.entityType}"): ${cat.typeHint || ''}\n  Attributes: ${attrList}`;
  }).join("\n\n");

  const step2Prompt = `You are an expert clinical annotator.
In Step 1, all clinical mentions with their evidenceRole, polarity, temporality, certainty, experiencer, function, and English canonical names were extracted.

In this Step 2, your task is ONLY to cluster/organize these existing mentions into relevant canonical Entities, and structure their attributes so they can be used directly in clinical summaries and notes.

CRITICAL INSTRUCTIONS:
0. Reference versus claim: preserve every mention's evidenceRole and claim context. A name/reference identifies a referent; it does NOT establish its presence, absence, result, or assessment. Reference function questioned/explanatory is discourse context, not a clinical finding. Missing context stays unassigned; not_applicable is distinct. Do not copy uncertainty or negation between the name and a separate result/attribute claim. Resolve the evidence target without changing the role. Unassigned legacy/provider roles must not be guessed from the target or old certain/asserted labels.
1. Event Clustering: Group mentions of the same clinical event or symptom episode. Do NOT merge distinct measurement occurrences, distinct dates, or separate symptom episodes merely because the concept name is identical. Blood pressure 140 yesterday and 120 today require separate entities with their own value, effectiveTime, and evidence.
2. Negation and assessment scope:
   - A patient explicitly denying a symptom supports stated absence, not proof of diagnostic exclusion. A negative attribute mention affects ONLY that attribute, not the whole entity.
   - For FHIR observation categories (symptoms, measurements, social history), status is RESULT WORKFLOW only: registered, preliminary, final, amended, corrected, cancelled, entered-in-error, unknown, or unassigned. Never put refuted, absent, active, confirmed, or suspected into workflow status. A final result can describe an absent finding.
   - Use diagnosticAssessment for an explicitly stated clinical assessment: supported (affirmed finding), suspected, not_suspected, absent (stated absence/denial), ruled_out (explicit exclusion), indeterminate, or unassigned. This is ClinGraph metadata, not native FHIR Observation.verificationStatus.
   - "No grounds to believe" supports diagnosticAssessment not_suspected, NOT ruled_out or absent. "No headache" supports absent. A negative test is a result; do not automatically turn it into exclusion of a disease. Do not infer an assessment of the whole entity from negation of a dosage, time, severity, trajectory, or other attribute.
   - Link assessment cues to attributeMentionIds.diagnosticAssessment; workflow evidence goes to attributeMentionIds.status. Do not duplicate evidence. Preserve who made the assessment and its certainty on each mention.
   - For Conditions, clinicalStatus and verificationStatus are distinct; they are never aliases. Use refuted verification ONLY when exclusion is stated, not merely a question, uncertainty, lack of suspicion, or absence of symptoms. Do not put verification codes into clinicalStatus.
   - Missing workflow/assessment/verification information stays unassigned. Do not infer final because a result was mentioned. Never generate legacy_refuted: that code is reserved for lossless migration of old annotations.
   - For other/custom schemas, follow the defined attributes without inventing assessment/status fields.

3. Every Mention Mapped: Every input mention ID must occur exactly once, either as direct entity evidence in mentionIds or as evidence of one field in attributeMentionIds.
4. Canonical English Name: The 'name' of each Entity MUST be a standardized English clinical concept name (e.g. 'Headache', 'Essential Hypertension', 'Skin Rash', 'Orthopnea', 'Joint Pain', 'Lisinopril', 'Blood Pressure', 'Dyspepsia').
5. Synthesized Description: Provide a concise clinical synthesis of the entity combining its mentions (e.g. 'Patient reports moderate dyspepsia and stomach discomfort, denies nausea' or 'Screened for orthopnea; patient explicitly denies nighttime dyspnea').
6. Direct Category Attributes & Strict Schema Choice Matching (CRITICAL):
   - For each entity, populate the structured 'attributes' object strictly adhering to the EXACT attribute names and EXACT allowed choice values (matching case precisely) defined in the Active Annotation Schema below.
   - Do NOT invent Title Case values when the schema specifies lowercase choices:
     * If the category schema defines: clinicalStatus (select: [unassigned, active, recurrence, relapse, inactive, remission, resolved, unspecified]) -> you MUST use attribute name "clinicalStatus" (NOT "status") and lowercase value like "active", "resolved".
     * If the category schema defines: severity (select: [unassigned, mild, moderate, severe, unspecified]) -> you MUST use lowercase value like "mild", "moderate", "severe".
     * If the category schema defines: status (select: [Unassigned, Active, Resolved, Refuted, Unspecified]) -> then use Title Case "Active", "Resolved", "Refuted".
     * For text attributes (e.g. details, dosage, value), provide concise clinically accurate values.
7. Schema Type: The Entity 'type' must match the category ID from the active schema (e.g. "symptoms", "conditions", "fhir_symptoms", "fhir_conditions").
8. Evidence targets: mentionIds contains ONLY mentions that directly support the entity. Put attribute-only evidence in attributeMentionIds, a map from exact schema field names to arrays of mention IDs. For example, 'headache' is direct evidence; 'Tuesday' supports onset; 'moderate' supports severity. Populate each field's value in attributes. A mention must occur exactly once, in either mentionIds or one attributeMentionIds entry, never both. Assign all mentions, including attribute-only spans, to the appropriate owning entity. Context on an attribute span is not a denial/assertion of the entire entity.
9. Encounter Title: Provide a concise, informative title of the medical encounter (e.g. 'Hypertension Follow-up & Medication Adjustment').

Temporal attributes (type "temporal") use the ClinGraph structure, NOT a guessed date string:
- Common fields: "type":"temporal", "precision":"unknown"|"year"|"month"|"week"|"day"|"hour"|"minute"|"second", "qualifier":"exact"|"approximate"|"before"|"after", "text":original time phrase.
- Absolute: "kind":"absolute", "date":"2026-03" (precision month), or a real YYYY-MM-DD/date-time. Date-times require an explicit UTC offset or Z; never invent a timezone.
- Relative: "kind":"relative", "anchor":{"kind":"encounter"}, "offset":{"value":-1,"unit":"wk"}. Signed units: a, mo, wk, d, h, min, s. Preserve source precision and approximation.
- For another event or unclear reference, use "anchor":{"kind":"unknown","label":"the referenced event"}. Do not invent attribute IDs.
- Duration: "kind":"duration", "amount":{"value":2,"unit":"wk"}; optional maxValue for a range. Do not copy duration into onset or derive onset from it.
- Interval: "kind":"interval", optional "start" and "end" dates, "endStatus":"known"|"unknown"|"ongoing". At least one date boundary is required. Ongoing must be explicitly stated; no end date alone does not imply ongoing.
- Unresolved phrase: "kind":"text", "text":"last week", "precision":"unknown", "qualifier":"exact". "Last week" is a calendar interval, not -1 week; preserve it as text unless explicit interval dates are supplied.
- Unstated timing is null. No createdAt/current-system-time fallback. Do not generate resolved dates; the app computes conservative previews separately.
- Link the original phrase to onset, resolutionTime, duration, or effectiveTime as appropriate. "Effective time" means time measured/sample collected, not time documented.

Procedure reference attributes (type "procedure-reference", partOf) must be null at extraction time. Extract the measurement and procedure as separate entities; a curator links the procedure event after stable entity IDs are assigned. Do not infer a link just because they occur nearby. Evidence explicitly connecting the measurement to a procedure may target attributeMentionIds.partOf.

Trajectory attributes (type "trajectory") record one explicit clinical comparison:
- Use {"type":"trajectory","direction":"improved"|"worsened"|"unchanged"|"unassigned","comparedTo":temporal value or null,"text":original comparison wording}.
- comparedTo is the reference time the CURRENT state is being compared with, using the temporal structure above (absolute, relative, interval, or unresolved text; never duration). It is not onset, resolutionTime, or effectiveTime.
- Example 'worse than a week ago': direction worsened, comparedTo {"type":"temporal","kind":"relative","anchor":{"kind":"encounter"},"offset":{"value":-1,"unit":"wk"},"precision":"week","qualifier":"exact","text":"a week ago"}.
- 'Better' without a comparison time means improved with comparedTo null. 'Unchanged since the previous visit' uses unchanged and an unresolved comparison time 'the previous visit'; do not substitute the current encounter date.
- No stated change means trajectory null, NOT unchanged. Preserve unclear wording with direction unassigned. Do not infer clinical improvement/worsening from numeric changes, current severity, status, or high/low interpretation. A statement that something did not improve does not establish unchanged or worsened.
- Link change/comparison mentions to attributeMentionIds.trajectory (or the exact custom trajectory field name), not to the entity, onset, or effectiveTime. Both the direction and reference wording support this one comparison attribute. Keep distinct comparisons/events separate; never overwrite opposite trajectories by merging distinct events.

Clinical encounter time (may be unknown; NOT the workspace creation date):
${JSON.stringify(encounterTime || null)}

Active Annotation Schema:
${dynamicSchemaGuidelines}

Full source transcript (context for grouping and interpreting the extracted mentions):
${fullTranscriptText}
Use this context to distinguish events and resolve references across utterances. Do not invent additional mentions or evidence IDs; attach only the supplied Step 1 mention IDs to their supported entities or attributes.

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
      "mentionIds": ["m1"],
      "attributeMentionIds": {"severity": ["m3"]},
      "attributes": {
        "severity": "exact choice matching schema case e.g. moderate or Moderate",
        "status": "exact choice matching schema case",
        "details": "Clinical details and context"
      }
    }
  ]
}`;

  try {
    const requestContext: AiRequestContext = { ...runContext, stage: 'clustering', attempt: 1 };
    let text = "";
    if (annotationConfig && annotationConfig.provider === "openai") {
      text = await callCustomOpenAiChat(annotationConfig, step2Prompt, requestContext);
    } else if (client) {
      const response = await runAiRequest(requestContext, { provider: 'gemini', model: modelName, promptChars: step2Prompt.length }, signal =>
        client.models.generateContent({
          model: modelName,
          contents: [{ text: step2Prompt }],
          config: {
            responseMimeType: "application/json", abortSignal: signal, httpOptions: { timeout: aiTimeoutMs() }
          }
        })
      );
      text = response.text || "";
    }

    if (!text) {
      throw new Error("The AI provider returned invalid entity clusters");
    }

    const data = cleanAndParseJson(text);
    const rawEntities = data.entities || [];
    const extractedTitle = data.title || "Annotated Clinical Consultation";

    if (!Array.isArray(rawEntities) || rawEntities.length === 0) {
      throw new Error("The AI provider returned invalid entity clusters");
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
      const attach = (mId: string, attributeName?: string) => {
        const m = mentionMap.get(mId);
        if (!m || mappedMentionIds.has(mId)) throw new Error('Each evidence mention must be assigned once to a valid target');
        m.entityId = entId;
        // Preserve hints from older compatible providers, but never promote them to direct evidence.
        m.supportedAttribute = attributeName || m.supportedAttribute;
        mappedMentionIds.add(mId);
        if (!m.supportedAttribute && !representativeSpan && m.textSpan) representativeSpan = m.textSpan;
      };
      clusterMentionIds.forEach(mId => attach(mId));
      for (const [attributeName, ids] of Object.entries(rawEnt.attributeMentionIds || {})) {
        if (!attributeName.trim() || !Array.isArray(ids)) throw new Error('Invalid attribute evidence mapping');
        ids.forEach(mId => attach(mId, attributeName));
      }

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

      // Clinical conclusions come from explicitly scoped attributes and their evidence.
      // Do not overwrite workflow/verification status based on negation or description keywords.

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
        if (m.supportedAttribute) throw new Error('The AI provider left attribute evidence without an owning entity');
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
    throw wrapAiError(err, 'Entity clustering failed');
  }
}

async function startServer() {
  const app = express();
  const server = createHttpServer(app);
  const PORT = Number(process.env.PORT || 3000);
  const storageMode = process.env.CLINGRAPH_STORAGE || 'firebase';
  if (!['sqlite', 'firebase'].includes(storageMode)) throw new Error('CLINGRAPH_STORAGE must be firebase or sqlite');
  aiTimeoutMs(); // Fail at startup for invalid timeout configuration.
  if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) throw new Error("PORT must be between 1 and 65535");
  const database = storageMode === 'sqlite' ? new LocalDatabase(path.resolve(process.env.CLINGRAPH_DB_PATH || "data/clingraph.sqlite")) : null;
  const firebase = storageMode === 'firebase' ? firebaseServices() : null;
  if (database) app.use(localOnly);

  app.get('/api/runtime', (_req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.json({ storage: storageMode, ...(firebase ? { firebase: firebaseConfig(),
      ...(process.env.FIREBASE_AUTH_EMULATOR_HOST ? { authEmulatorUrl: `http://${process.env.FIREBASE_AUTH_EMULATOR_HOST}` } : {}) } : {}) });
  });
  app.get('/api/health', (_req, res) => res.json({ success: true, status: 'ready', storage: database ? 'sqlite' : 'firestore', authentication: Boolean(firebase) }));
  if (firebase) app.use('/api', requireFirebaseUser);
  if (firebase) app.use('/api/archive', legacyArchiveApi(firebase.legacyFirestore));

  // Increase payload limit to handle base64 audio uploads
  app.use(express.json({ limit: "50mb" }));
  app.use(express.urlencoded({ limit: "50mb", extended: true }));

  app.use('/api', localApi(database || (req => new FirestoreDatabase(firebase!.firestore, firebase!.bucket, req.res!.locals.userId))));

  // API endpoint for annotation and transcription
  app.post("/api/annotate", audioUpload, async (req, res) => {
    const runController = new AbortController();
    const runContext: AiRunContext = { requestId: randomUUID(), signal: runController.signal };
    res.setHeader('X-Request-ID', runContext.requestId);
    res.once('close', () => { if (!res.writableEnded) runController.abort(); });
    const { transcript, transcriptSegments, audioBase64, audioMimeType, aiConfig, annotationSchema, encounterType } = req.body;
    let encounterTime: TemporalValue | null = null;
    try {
      encounterTime = typeof req.body.encounterTime === "string" ? JSON.parse(req.body.encounterTime) : req.body.encounterTime ?? null;
      validateEncounterTime(encounterTime);
    } catch (error) { return res.status(400).json({ success: false, error: (error as Error).message }); }

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

    const activeSchema = normalizeAnnotationSchema(schemaObj.length ? schemaObj : DEFAULT_ANNOTATION_SCHEMA);

    let extractionConcurrency: number;
    try {
      extractionConcurrency = aiExtractionConcurrency(userAiConfig?.annotation?.concurrency);
    } catch (error: any) {
      return res.status(error.status || 500).json({ success: false, error: error.message });
    }

    const streaming = req.get('Accept')?.includes('application/x-ndjson');
    const progress: AnnotationProgress = { requestId: runContext.requestId, stage: 'preparing', utterances: [] };
    const publishProgress = () => {
      if (streaming && !res.destroyed && !res.writableEnded) {
        res.write(JSON.stringify({ type: 'progress', progress }) + '\n');
      }
    };
    const finish = (status: number, result: Record<string, unknown>) => {
      if (res.destroyed) return;
      const payload = { ...result, requestId: runContext.requestId, progress };
      if (streaming) res.end(JSON.stringify({ type: 'result', ...payload }) + '\n');
      else res.status(status).json(payload);
    };
    if (streaming) {
      res.setHeader('Content-Type', 'application/x-ndjson');
      res.setHeader('Cache-Control', 'no-cache, no-store, no-transform');
      res.setHeader('X-Accel-Buffering', 'no');
      res.flushHeaders();
      publishProgress();
      const heartbeat = setInterval(() => {
        if (!res.destroyed && !res.writableEnded) res.write('{"type":"heartbeat"}\n');
      }, 15000);
      res.once('close', () => clearInterval(heartbeat));
    }

    try {
      const annotationConfig = userAiConfig?.annotation;
      const client = annotationConfig?.provider === "openai" ? null
        : annotationConfig?.apiKey ? new GoogleGenAI({ apiKey: annotationConfig.apiKey }) : getAiClient();
      const useGeminiModel = annotationConfig?.model || "gemini-3.1-flash-lite";
      if (!client && !transcript && !transcriptSegments) {
        throw Object.assign(new Error('Transcribe the audio before annotating with an OpenAI-compatible text model.'), { status: 400 });
      }

      let fileRef: any = null;

      if (client && req.file && !transcript && !transcriptSegments) {
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
        throw Object.assign(new Error('Unable to produce or retrieve clinical conversation segments for annotation'), { status: 400 });
      }

      // STEP 1: One target per request, with neighboring context supplied by the extractor.
      // Keep original indices even when blank utterances are skipped.
      const targets = parsedSegments.map((seg, lineIndex) => ({ ...seg, lineIndex }))
        .filter(seg => seg.text?.trim());
      if (!targets.length) throw Object.assign(new Error('No nonblank utterances available for annotation.'), { status: 400 });
      progress.stage = 'extracting';
      progress.utterances = targets.map(target => ({ lineIndex: target.lineIndex, status: 'pending' }));
      publishProgress();

      console.log(`Step 1: Extracting mentions from ${targets.length} target utterances individually using ${useGeminiModel} (${extractionConcurrency} concurrent requests, 2 context utterances on each side)...`);
      let firstExtractionError: unknown;
      // Each worker settles its own utterance so one exhausted retry does not discard other results.
      const extractionResults = await mapConcurrent(targets, extractionConcurrency, async (target, index) => {
        runController.signal.throwIfAborted();
        const utterance = progress.utterances[index];
        utterance.status = 'in_progress';
        publishProgress();
        try {
          const mentions = await extractMentionsForUtterance(
            client,
            useGeminiModel,
            target,
            parsedSegments,
            activeSchema,
            encounterType,
            userAiConfig?.annotation,
            0,
            runContext
          );
          utterance.status = 'complete';
          return mentions;
        } catch (error: any) {
          if (runController.signal.aborted) throw error;
          firstExtractionError ??= error;
          utterance.status = 'skipped';
          utterance.error = error.message || 'Mention extraction failed after retries.';
          logAi({ ...runContext, stage: 'mention-extraction', utteranceIndex: target.lineIndex }, 'utterance_skipped', { reason: error.code || 'EXTRACTION_FAILED' });
          return [];
        } finally {
          publishProgress();
        }
      });
      if (progress.utterances.every(utterance => utterance.status === 'skipped')) throw firstExtractionError;
      // Concurrent completion never changes transcript order or mention IDs.
      const allMentions = extractionResults.flat().map((mention, index) => ({ ...mention, id: `m${index + 1}` }));

      console.log(`Step 1 Complete: Extracted ${allMentions.length} mentions with polarity, temporality, certainty, experiencer, function, and canonical English names.`);

      // STEP 2: Cluster and organize existing mentions into relevant canonical Entities
      console.log(`Step 2: Clustering and organizing ${allMentions.length} mentions into canonical Entities...`);
      progress.stage = 'clustering';
      publishProgress();
      const fullTranscriptText = parsedSegments.map((seg, idx) => `[Segment ${idx}] [${seg.speaker}]: ${seg.text}`).join('\n');

      const clusteredResult = await clusterMentionsIntoEntities(
        client,
        useGeminiModel,
        allMentions,
        activeSchema,
        fullTranscriptText,
        userAiConfig?.annotation,
        encounterTime,
        runContext
      );

      const finalParsedData = {
        title: clusteredResult.title || "Annotated Clinical Consultation",
        rawTranscript: transcript || parsedSegments.map(s => `${s.speaker}: ${s.text}`).join("\n"),
        transcriptSegments: parsedSegments || [],
        ...normalizeEvidence({
          mentionContextVersion: 1,
          observationStatusVersion: 1,
          entities: clusteredResult.entities,
          relations: [],
          clinicalNotes: clusteredResult.clinicalNotes,
          mentions: allMentions
        }, activeSchema)
      };

      logAi({ ...runContext, stage: 'annotation' }, 'annotation_completed', { mentionCount: finalParsedData.mentions?.length });
      progress.stage = 'complete';
      finish(200, {
        success: true,
        requestId: runContext.requestId,
        data: finalParsedData
      });

    } catch (error: any) {
      runController.abort();
      logAi({ ...runContext, stage: 'annotation' }, 'annotation_failed', { reason: error.code || 'ANNOTATION_FAILED' });
      console.error("Error in /api/annotate:", error);
      if (res.destroyed) return;
      progress.stage = 'failed';
      progress.error = error.message || 'AI annotation failed.';
      progress.utterances.forEach(utterance => { if (utterance.status === 'in_progress') utterance.status = 'pending'; });
      finish(error.status || 502, {
        success: false,
        requestId: runContext.requestId,
        code: error.code,
        error: `${error.message || 'An error occurred during medical transcription & annotation processing'} [request ${runContext.requestId}]`
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

    try {
      const annotationConfig = userAiConfig?.annotation;
      const client = annotationConfig?.provider === "openai" ? null
        : annotationConfig?.apiKey ? new GoogleGenAI({ apiKey: annotationConfig.apiKey }) : getAiClient();
      const useGeminiModel = annotationConfig?.model || "gemini-3.1-flash-lite";
      let transcriptContext = transcript || "";
      if (!transcriptContext && Array.isArray(transcriptSegments) && transcriptSegments.length > 0) {
        transcriptContext = transcriptSegments.map((s: any, idx: number) => `[Segment ${idx}] [${s.speaker || 'Speaker'}]: ${s.text || ''}`).join('\n');
      }

      // Attribute evidence belongs only to its attribute; do not flatten it into entity evidence.
      const relationAnnotation = normalizeEvidence({
        entities, mentions: Array.isArray(mentions) ? mentions : [], relations: [],
        clinicalNotes: { symptoms: [], medications: [], followUps: [] }
      });
      const enrichedEntitiesForRelations = relationAnnotation.entities.map(e => ({
        id: e.id, name: e.name, type: e.type, description: e.description,
        mentions: relationAnnotation.mentions!.filter(m => isEntityEvidence(m, e.id)),
        attributes: (e.attributes || []).map(attribute => ({
          ...attribute,
          mentions: relationAnnotation.mentions!.filter(m =>
            m.target?.kind === 'attribute' && m.target.attributeId === attribute.id)
        }))
      }));

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
4. Evidence scope: Each entity's mentions directly support that entity. Each attribute has its own ID, value, and mentions supporting ONLY that attribute. A dosage/onset/value span is not evidence for the whole entity. Preserve polarity, certainty, temporality, experiencer, and function at the exact target; do not infer an entity-level denial from negative attribute evidence. These evidence edges already exist; return only semantic relations between the supplied entities. Measurement-to-procedure PART_OF links are derived from curated partOf attributes; do not generate those relations.
5. Output raw JSON only with NO markdown fences, NO conversational text, and NO commentary.`;

      const contents = [
        ...(transcriptContext ? [{ text: `Clinical Encounter Transcript:\n${transcriptContext}` }] : []),
        { text: relationsPrompt }
      ];

      console.log(`Generating Knowledge Graph Relations for ${entities.length} entities using ${useGeminiModel}...`);
      const responseText = annotationConfig?.provider === "openai"
        ? await callCustomOpenAiChat(annotationConfig, contents.map(item => item.text).join("\n\n"))
        : (await withTimeout(client!.models.generateContent({
            model: useGeminiModel, contents, config: { responseMimeType: "application/json" }
          }), 45000, "Relation generation timed out")).text;
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
      return res.status(err.status || 502).json({ success: false, error: err.message || "Relation generation failed" });
    }
  });

  // API endpoint for diarized transcription
  app.post("/api/diarize", audioUpload, async (req, res) => {
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
        throw keyError;
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
        throw geminiError;
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
      res.status(error.status || 502).json({
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
        error: "UMLS_API_KEY environment variable is not configured. Set UMLS_API_KEY in your local .env file and restart ClinGraph."
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
        error: "UMLS_API_KEY environment variable is not configured. Set UMLS_API_KEY in your local .env file and restart ClinGraph."
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

  app.use("/api", (_req, res) => res.status(404).json({ success: false, error: "API endpoint not found" }));

  // Vite middleware for development
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true, hmr: process.env.DISABLE_HMR === 'true' ? false : { server } },
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

  server.listen(PORT, database ? '127.0.0.1' : '0.0.0.0', () => {
    console.log(`ClinGraph running on http://localhost:${PORT}`);
    console.log(database ? `Local database: ${database.filename} (no login)` : `Firebase project: ${firebaseConfig().projectId}; database: ${firebaseConfig().firestoreDatabaseId} (sign-in required)`);
    console.log(`AI request deadline: ${aiTimeoutMs() / 1000}s; diagnostics: ${aiLogPath()}`);
  });
  const shutdown = () => {
    server.close(() => { database?.close(); process.exit(0); });
    server.closeIdleConnections();
    setTimeout(() => process.exit(0), 5000).unref();
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
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
        ...(config.apiKey ? { "Authorization": `Bearer ${config.apiKey}` } : {})
      },
      body: formData,
      dispatcher: globalAgent,
    signal: AbortSignal.timeout(60000)
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
    const diarizePrompt = `Segment the following transcript into chronological utterances.
Infer the speaker when clear; otherwise use "Unknown". Preserve the exact spoken words.
Return a JSON array of objects with "speaker" and "text". Do not invent timestamps: only text is available.

Transcript:
${rawText}`;

    if (annotationConfig?.provider === "openai") {
      diarizedSegments = cleanAndParseJson(await callCustomOpenAiChat(annotationConfig, diarizePrompt));
    } else if (annotationConfig?.apiKey || process.env.GEMINI_API_KEY) {
      const client = annotationConfig?.apiKey ? new GoogleGenAI({ apiKey: annotationConfig.apiKey }) : getAiClient();
      const response = await withTimeout(client.models.generateContent({
        model: annotationConfig?.model || "gemini-3.1-flash-lite",
        contents: [{ text: diarizePrompt }], config: { responseMimeType: "application/json" }
      }), 60000, "Transcript segmentation timed out");
      diarizedSegments = cleanAndParseJson(response.text || "");
    } else {
      // Preserve the actual transcription when no segmentation model is configured.
      diarizedSegments = [{ speaker: "Unknown", text: rawText }];
    }
    if (!Array.isArray(diarizedSegments) || !diarizedSegments.length) {
      throw new Error("The segmentation model returned no transcript segments");
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
    throw error;
  }
}

async function callCustomOpenAiChat(config: any, promptText: string, context?: AiRequestContext): Promise<string> {
  return callOpenAiChat(config, promptText, context);
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

startServer().catch(error => { console.error(error); process.exit(1); });
