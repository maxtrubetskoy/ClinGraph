import express from "express";
import path from "path";
import { createServer as createViteServer } from "vite";
import { GoogleGenAI } from "@google/genai";
import dotenv from "dotenv";
import multer from "multer";
import fs from "fs";

dotenv.config();

const upload = multer({ dest: "/tmp/" });

// Lazy initialization of Gemini client
let aiClient: GoogleGenAI | null = null;

function getAiClient(): GoogleGenAI {
  if (!aiClient) {
    const key = process.env.GEMINI_API_KEY;
    if (!key || key === "MY_GEMINI_API_KEY") {
      throw new Error("GEMINI_API_KEY environment variable is required and has not been configured in AI Studio.");
    }
    aiClient = new GoogleGenAI({ apiKey: key });
  }
  return aiClient;
}

async function startServer() {
  const app = express();
  const PORT = 3000;

  // Increase payload limit to handle base64 audio uploads
  app.use(express.json({ limit: "50mb" }));
  app.use(express.urlencoded({ limit: "50mb", extended: true }));

  // API endpoint for annotation and transcription
  app.post("/api/annotate", upload.single("audio"), async (req, res) => {
    const { transcript, transcriptSegments, audioBase64, audioMimeType, aiConfig } = req.body;

    let userAiConfig: any = null;
    if (aiConfig) {
      try {
        userAiConfig = typeof aiConfig === "string" ? JSON.parse(aiConfig) : aiConfig;
      } catch (e) {
        console.warn("Failed to parse userAiConfig in annotate:", e);
      }
    }

    try {
      const prompt = `You are an expert clinical annotator. Your task is to process a clinical conversation (which may be provided as audio, raw text, or a transcript) and output an extremely detailed and dense structured clinical entity-relation knowledge graph along with nested notes.

You must reply with a valid JSON object ONLY. Do not wrap the JSON in markdown code blocks or add any trailing comments.

The JSON schema you must output is:
{
  "title": "A brief, descriptive title of the medical encounter (e.g. 'Hypertension Follow-up & Medication Adjustment')",
  "rawTranscript": "The complete reconstructed raw transcript of the conversation",
  "transcriptSegments": [
    {
      "id": "string (e.g. seg1, seg2...)",
      "speaker": "string (e.g. Doctor, Patient, Relative, Assistant)",
      "text": "string (the clean transcription of what was said)"
    }
  ],
  "entities": [
    {
      "id": "string (e.g. e1, e2, e3...)",
      "name": "string (the specific clinical entity, e.g. 'Headache', 'Lisinopril', 'Patient', 'Dr. Smith', 'Check blood pressure', 'eGFR')",
      "type": "string (MUST be one of: 'Patient', 'Doctor', 'Symptom', 'Condition', 'Medication', 'Dosage', 'FollowUp', 'Measurement', 'Other')",
      "description": "string (brief context or details, e.g. 'Severe, since Tuesday', '20mg once daily', 'Follow up in 2 weeks', '58 mL/min')",
      "textSpan": {
        "lineIndex": "number (the 0-based index of the segment in the transcriptSegments array where this entity is explicitly mentioned. Set to -1 if it is a generic actor like Patient/Doctor not bound to a specific text line)",
        "startChar": "number (the 0-based character offset of the entity name/mention within that segment's text, or -1)",
        "endChar": "number (the 0-based character offset where the entity name/mention ends within that segment's text, or -1)",
        "text": "string (the exact substring from the segment text corresponding to this character range, or empty string)"
      }
    }
  ],
  "relations": [
    {
      "id": "string (e.g. r1, r2...)",
      "source": "string (the source entity ID)",
      "target": "string (the target entity ID)",
      "type": "string (MUST be uppercase verb, e.g. 'DIAGNOSED_WITH', 'PRESCRIBED', 'TREATS', 'EXPERIENCING', 'SCHEDULED', 'COOPERATES_WITH', 'REPLACES', 'PROPOSED_BY', 'DIAGNOSED_BY', 'PRESCRIBED_BY', 'SCHEDULED_BY', 'CANCELLED_BY', 'CONSIDERED_BY', 'DISCONTINUED_BY', 'HAS_DOSAGE', 'DOSAGE_FOR', 'HAS_MEASUREMENT', 'MEASURES', 'MEASURED_BY', 'ASSOCIATED_WITH', 'MONITORING_DRUG', 'AFFECTS_MEASUREMENT', 'PRESCRIBED_FOR', 'PREVENTS', 'INDICATED_FOR', 'SWITCHED_TO', 'COMBINED_WITH', 'CONTRAINDICATED_WITH', 'ORDERED_BY', 'TAKING', 'AGREED_TO', 'HAS_TARGET', 'TARGET_VALUE', 'NORMAL_VALUE')"
    }
  ],
  "clinicalNotes": {
    "symptoms": [
      {
        "entityId": "string (matching entity ID in entities array)",
        "name": "string (symptom name)",
        "severity": "string (MUST be one of: 'Mild', 'Moderate', 'Severe', 'Unspecified')",
        "onset": "string (when did it start, or empty string)",
        "details": "string (brief context)"
      }
    ],
    "conditions": [
      {
        "entityId": "string (matching entity ID in entities array)",
        "name": "string (condition or disease name, e.g., 'ADPKD', 'Hypertension')",
        "status": "string (MUST be one of: 'Active', 'Chronic', 'History of', 'Differential Diagnosis', 'Unspecified')",
        "details": "string (brief context)"
      }
    ],
    "medications": [
      {
        "entityId": "string (matching entity ID in entities array)",
        "name": "string (medication name)",
        "action": "string (MUST be one of: 'Start', 'Stop', 'Change Dosage', 'Continue', 'Discussed')",
        "dosage": "string (dosage description, e.g. '20mg daily')",
        "details": "string (context, e.g. 'increased from 10mg due to high blood pressure')"
      }
    ],
    "followUps": [
      {
        "entityId": "string (matching entity ID in entities array)",
        "task": "string (task description)",
        "due": "string (timeline, e.g. '2 weeks')",
        "assignee": "string (who does the task, e.g. 'Patient', 'Doctor', 'Nurse')"
      }
    ],
    "measurements": [
      {
        "entityId": "string (matching entity ID in entities array)",
        "name": "string (measurement name, e.g. 'eGFR', 'Blood Pressure', 'Target Blood Pressure')",
        "value": "string (the value, e.g. '58 mL/min', '140/90', '< 130/80')",
        "status": "string (evaluation state, e.g. 'Stable', 'Decreased', 'Elevated', 'Target', 'Goal')",
        "details": "string (context, e.g. 'measured in clinic today')"
      }
    ]
  }
}

Guidelines for High-Fidelity & Exhaustive Clinical Annotation:
1. EXHAUSTIVE ENTITY EXTRACTION:
   - Identify and extract ALL clinical entities. Do not omit any relevant terms.
   - Entity Types must strictly be one of: 'Patient', 'Doctor', 'Symptom', 'Condition', 'Medication', 'Dosage', 'FollowUp', 'Measurement', 'Other'.
   - For lab measurements, laboratory values, vital signs, and clinical targets (e.g., eGFR, Blood Pressure, Target Blood Pressure, heart rate, creatinine, HbA1c), ALWAYS use the 'Measurement' type instead of 'Dosage' or 'Other'.
   - Include conditions mentioned in differential diagnosis, past history, active complaints, or proposed treatments.
   - Be extremely detailed. If a term is clinical, extract it.

2. EXHAUSTIVE RELATIONSHIP MAPPING:
   - Make the knowledge graph dense and deeply connected. Every clinically relevant relationship must be captured in the 'relations' array.
   - DRUGS TO DOSAGES (CRITICAL): Ensure every 'Dosage' entity is connected to its corresponding 'Medication' entity. Use relation types like: 'HAS_DOSAGE' (from Medication to Dosage) or 'DOSAGE_FOR' (from Dosage to Medication). NEVER leave a 'Dosage' entity disconnected from its drug.
   - MEASUREMENTS & LABS: Connect 'Measurement' entities to relevant entities:
     - 'Patient -> HAS_MEASUREMENT -> Measurement' (or 'Measurement -> MEASURES -> Patient')
     - 'Measurement -> ASSOCIATED_WITH -> Condition/Symptom' (e.g., Blood Pressure associated with Hypertension or eGFR associated with Chronic Kidney Disease)
     - 'Measurement -> MONITORING_DRUG -> Medication' or 'Medication -> AFFECTS_MEASUREMENT -> Measurement'
      - 'Measurement -> HAS_TARGET -> Measurement/Other' or 'Measurement -> TARGET_VALUE -> Measurement/Other' or 'Measurement -> NORMAL_VALUE -> Measurement/Other' (to connect a lab/measurement to its target or normal reference value discussed, e.g., Blood Pressure connected to Target Blood Pressure)
   - DRUGS TO SYMPTOMS/DISEASES: Link medications to the symptoms/conditions they treat or are indicated for. Use relation types like: 'TREATS', 'PRESCRIBED_FOR', 'PREVENTS', 'INDICATED_FOR'.
   - DRUG-TO-DRUG RELATIONSHIPS: If a drug is replaced by, switched to, or combined with another drug, model this explicitly. Use relation types like: 'REPLACES', 'SWITCHED_TO', 'COMBINED_WITH', 'CONTRAINDICATED_WITH'.
   - DOCTOR'S ACTIONS & DIFFERENTIAL DIAGNOSES: Link clinical entities to the Doctor when the doctor is making a differential diagnosis, actively assessing, proposing, or scheduling them:
     - 'Condition/Symptom -> CONSIDERED_BY -> Doctor' (for differential diagnoses or suspected issues)
     - 'Medication -> PROPOSED_BY -> Doctor' or 'Medication -> PRESCRIBED_BY -> Doctor'
     - 'FollowUp -> SCHEDULED_BY -> Doctor'
     - 'Other -> ORDERED_BY -> Doctor' (for lab tests, imaging, etc.)
   - CANCELLED OR DISCONTINUED TREATMENTS: If a treatment is stopped, cancelled, or held, represent this clearly in the relations. E.g.:
     - 'Medication -> CANCELLED_BY -> Doctor'
     - 'Medication -> DISCONTINUED_BY -> Doctor'
   - PATIENT RELATIONSHIPS:
     - 'Patient -> EXPERIENCING -> Symptom/Condition'
     - 'Patient -> TAKING -> Medication'
     - 'Patient -> AGREED_TO -> FollowUp'

3. SPAN-REPORTING & INTEGRITY:
   - For each entity, you MUST provide an accurate 'textSpan' linking it to the exact occurrence in 'transcriptSegments'.
   - 'lineIndex' is the 0-based index of the segment where the term is spoken.
   - 'startChar' and 'endChar' are the exact character boundary offsets within that segment's 'text' (0-based, inclusive start, exclusive end).
   - 'text' must match the exact substring in the segment.
   - If an entity is a generic participant (like the "Patient" or "Doctor" actor) or is an inferred clinical summary entity that isn't tied to a specific word or sentence, set lineIndex to -1, startChar to -1, endChar to -1, and text to "".

4. Ensure all clinical notes items (symptoms, medications, follow-ups) have the exact matching 'entityId' pointing to an entity in your 'entities' array.
5. Provide a valid, parsable JSON response only. Do not wrap in markdown or include any conversational filler.`;

      // 1. Check if we should route to custom OpenAI-compatible Annotation
      if (userAiConfig && userAiConfig.annotation && userAiConfig.annotation.provider === "openai") {
        const config = userAiConfig.annotation;

        let segmentsToAnnotate: any[] = [];
        if (transcriptSegments) {
          try {
            segmentsToAnnotate = typeof transcriptSegments === "string" ? JSON.parse(transcriptSegments) : transcriptSegments;
          } catch (e) {
            console.warn("Failed to parse transcriptSegments for custom model:", e);
          }
        }

        let textToAnnotate = transcript;

        // If we have an audio file but no segments, transcribe it first
        if (segmentsToAnnotate.length === 0 && (req.file || audioBase64)) {
          let buf: Buffer;
          let filename = "audio.webm";
          let mimeType = audioMimeType || "audio/webm";

          if (req.file) {
            buf = await fs.promises.readFile(req.file.path);
            mimeType = req.file.mimetype || mimeType;
            filename = req.file.originalname || "audio.webm";
            try { await fs.promises.unlink(req.file.path); } catch (e) {}
          } else {
            buf = Buffer.from(audioBase64, "base64");
          }

          // Transcribe using custom transcription or fallback Gemini
          const transConfig = userAiConfig.transcription || { provider: "gemini" };
          const diarized = await transcribeWithCustomOpenAiOrGemini(buf, mimeType, filename, transConfig, config);
          segmentsToAnnotate = diarized.segments;
          textToAnnotate = diarized.jsonlText;
        }

        let segmentsPromptPart = "";
        if (segmentsToAnnotate && segmentsToAnnotate.length > 0) {
          segmentsPromptPart = `\n\n--- TARGET TRANSCRIPT SEGMENTS WITH 0-BASED INDEX NUMBERS (USE THESE EXACTLY FOR lineIndex IN YOUR textSpan SCHEMA!) ---\n` +
            segmentsToAnnotate.map((seg: any, idx: number) => `[Segment ${idx}] [${seg.speaker || 'Unknown'}]: ${seg.text}`).join('\n') +
            `\n\nCRITICAL SPAN MATCHING INSTRUCTION:
- You MUST map each extracted entity to the exact 0-based index of the segment where it is mentioned.
- For example, if an entity is mentioned in '[Segment ${segmentsToAnnotate.length - 1}]', its 'lineIndex' MUST be ${segmentsToAnnotate.length - 1}.
- Double check that 'startChar' and 'endChar' are 100% correct relative to the 'text' of that specific segment.
- If an entity is not explicitly mentioned in any segment text, set its 'lineIndex' to -1.`;
        }

        const fullPrompt = prompt + segmentsPromptPart;
        console.log(`Calling custom OpenAI-compatible annotation model "${config.model}"...`);
        const completionText = await callCustomOpenAiChat(config, fullPrompt);
        const parsedData = cleanAndParseJson(completionText);
        
        return res.json({
          success: true,
          data: parsedData
        });
      }

      // 2. Otherwise use Gemini (Dynamic client check)
      let client: GoogleGenAI;
      let useGeminiModel = "gemini-3.5-flash";

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
          warning: "GEMINI_API_KEY is not configured in AI Studio. Using local clinical rule-parser for demo.",
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

      if ((!parsedSegments || parsedSegments.length === 0) && transcript) {
        // Fallback: extract from transcript if it's formatted as lines or JSONL
        const lines = transcript.split('\n').filter((l: string) => l.trim().length > 0);
        parsedSegments = lines.map((line: string, idx: number) => {
          try {
            if (line.trim().startsWith('{') && line.trim().endsWith('}')) {
              const parsed = JSON.parse(line.trim());
              return {
                id: `seg_${idx + 1}`,
                speaker: parsed.speaker || "Unknown",
                text: parsed.text || ""
              };
            }
          } catch (e) {}
          const colonIdx = line.indexOf(':');
          if (colonIdx > -1) {
            return {
              id: `seg_${idx + 1}`,
              speaker: line.substring(0, colonIdx).trim(),
              text: line.substring(colonIdx + 1).trim()
            };
          }
          return {
            id: `seg_${idx + 1}`,
            speaker: "Unknown",
            text: line.trim()
          };
        });
      }

      let segmentsPromptPart = "";
      if (parsedSegments && parsedSegments.length > 0) {
        segmentsPromptPart = `\n\n--- TARGET TRANSCRIPT SEGMENTS WITH 0-BASED INDEX NUMBERS (USE THESE EXACTLY FOR lineIndex IN YOUR textSpan SCHEMA!) ---\n` +
          parsedSegments.map((seg, idx) => `[Segment ${idx}] [${seg.speaker || 'Unknown'}]: ${seg.text}`).join('\n') +
          `\n\nCRITICAL SPAN MATCHING INSTRUCTION:
- You MUST map each extracted entity to the exact 0-based index of the segment where it is mentioned.
- For example, if an entity is mentioned in '[Segment ${parsedSegments.length - 1}]', its 'lineIndex' MUST be ${parsedSegments.length - 1}.
- Double check that 'startChar' and 'endChar' are 100% correct relative to the 'text' of that specific segment.
- If an entity is not explicitly mentioned in any segment text, set its 'lineIndex' to -1.`;
      }

      let contents: any[] = [];

      if (fileRef) {
        contents.push(fileRef);
        if (transcript) {
          contents.push({
            text: `Partial client transcript context:\n${transcript}`
          });
        }
      } else if (transcript) {
        console.log("Processing text annotation...");
        contents.push({
          text: `Here is the conversation text to analyze:\n${transcript}`
        });
      } else {
        return res.status(400).json({ success: false, error: "Either transcript or audioBase64 must be provided" });
      }

      contents.push({ text: prompt + segmentsPromptPart });

      console.log(`Running annotation generation using Gemini model "${useGeminiModel}"...`);
      const response = await client.models.generateContent({
        model: useGeminiModel,
        contents: contents,
        config: {
          responseMimeType: "application/json"
        }
      });

      const responseText = response.text;
      if (!responseText) {
        throw new Error("Empty response from Gemini model.");
      }

      const parsedData = cleanAndParseJson(responseText);
      res.json({
        success: true,
        data: parsedData
      });

    } catch (error: any) {
      console.error("Error in /api/annotate:", error);
      res.status(500).json({
        success: false,
        error: error.message || "An error occurred during medical transcription & annotation processing"
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
      let useGeminiModel = "gemini-3.5-flash";

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
          warning: "GEMINI_API_KEY is not configured in AI Studio. Using mock diarizer for demo.",
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
      const response = await client.models.generateContent({
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
      });

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
  const lines = text.split("\n").filter(l => l.trim() !== "");
  const segments = lines.map((line, idx) => {
    const parts = line.split(":");
    let speaker = "Unknown";
    let textVal = line;
    if (parts.length > 1) {
      speaker = parts[0].trim();
      textVal = parts.slice(1).join(":").trim();
    }
    return {
      id: `seg${idx + 1}`,
      speaker,
      text: textVal
    };
  });

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
    { id: "e_pat", name: "Patient", type: "Patient", description: "Primary care subject", textSpan: { lineIndex: -1, startChar: -1, endChar: -1, text: "" } },
    { id: "e_doc", name: "Doctor", type: "Doctor", description: "Attending practitioner", textSpan: { lineIndex: -1, startChar: -1, endChar: -1, text: "" } }
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

  // Default mock if absolutely nothing matched
  if (extractedSymptoms.length === 0 && extractedMeds.length === 0 && extractedFollows.length === 0 && extractedMeasurements.length === 0) {
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

  return {
    title: "Clinical Consultation Overview",
    rawTranscript: text,
    transcriptSegments: segments,
    entities,
    relations,
    clinicalNotes: {
      symptoms: extractedSymptoms,
      conditions: extractedConditions,
      medications: extractedMeds,
      followUps: extractedFollows,
      measurements: extractedMeasurements
    }
  };
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
      body: formData
    });

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
          model: "gemini-3.5-flash",
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
  const modelName = config && config.model ? config.model : "gemini-3.5-flash";

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
    body: JSON.stringify(payload)
  });

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

