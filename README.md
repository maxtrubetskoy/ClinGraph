# ClinGraph

Clinical annotation workspace for transcripts and notes, canonical entities, attribute nodes, relationships, and text evidence with a separate evidence role and claim context (polarity, certainty, temporality, experiencer, speaker, and function). Firebase provides Google sign-in and durable per-account storage; an offline SQLite mode is also available.

## Firebase and hosted deployment

Firebase mode connects to project **room-furnishing**. New sessions, groups, settings, and checkpoints use the separate **clingraph-v2** database. Sign in with Google and open **Legacy archive** to view your sessions from the original AI Studio database. The archive displays original values and saved group schemas without applying current annotation migrations. It offers audio playback where audio was stored in the record, plus **Download original JSON**. Editing, deletion, regeneration, and restoration are unavailable for archived records.

The server checks account ownership on both databases. Its runtime identity has read-only access to the legacy database and write access to `clingraph-v2`; configuration rejects using the legacy database as the current workspace. No sessions are automatically copied between databases. AI progress, per-utterance error handling, frontend concurrency, structured evidence, temporal fields, review metadata, and checkpoints are retained for the new workspace.

For local development against Firebase, configure credentials with `gcloud auth application-default login` and `gcloud auth application-default set-quota-project room-furnishing`, then run `npm run dev`. This accesses real cloud data. Cloud Run uses its attached service account automatically. See [DEPLOYMENT.md](DEPLOYMENT.md) for hosting and [SCHEMA_MIGRATION.md](SCHEMA_MIGRATION.md) for the archive boundary.

## Run locally

Use `dev:local` for the existing offline workspace. Requires Node.js **22.19 or newer** (Node 24 recommended). SQLite is included with Node; this mode needs no Firebase account or login.

```sh
cd ClinGraph
npm ci
npm run dev:local
```

Open **http://localhost:3000**. Create a session, paste a transcript or note, and choose **Annotate Manually**. Select text in the dialogue view to create a mention, choose its category, then edit the entity and mention attributes. Use **Export JSONL** to download annotations.

The database is created automatically at `data/clingraph.sqlite`. Sessions, groups, custom schemas, provider settings, and audio are stored there. The browser holds the current UI state; clearing browser storage does not delete your workspace. No `.env` file is required.

For a production build:

```sh
npm run build
CLINGRAPH_STORAGE=sqlite npm start
```

`npm run preview` also starts the complete production app, including the API. Set `CLINGRAPH_STORAGE=sqlite` for offline mode; otherwise it uses Firebase. Run commands from the repository directory.

## Annotation checkpoints and schema versions

Open **Annotation history** in a session, optionally name the version (for example, “Human-reviewed baseline”), and click **Save checkpoint**. Ordinary edits remain autosaved working changes; checkpoints are explicit, immutable milestones numbered `v1`, `v2`, etc. within each session. A checkpoint is also created automatically **before AI regeneration** replaces an existing annotation. A failed checkpoint prevents that regeneration from starting.

Each checkpoint captures, together in a database transaction:

- Exact saved source text and transcript segments, including segment IDs, speakers, and timestamps.
- The current annotation: entities, attribute values, mention spans and targets, context labels, relations, and migration/review metadata.
- Clinical encounter time, encounter type, title, and original session creation time.
- The complete effective annotation schema, including category/field definitions, choices, ordering, and hints.
- A server-generated checkpoint timestamp, label, sequence number, and reason.

The **schema version** is a SHA-256 content fingerprint, not the checkpoint sequence number. Two checkpoints with the same schema have the same schema version; changing a definition, choice, hint, or order produces a different version. Object-key order does not affect the fingerprint. `snapshotFormatVersion: 1` identifies the checkpoint envelope; annotation format markers such as `evidenceVersion` and `mentionContextVersion` remain inside the captured annotation.

Select a version to preview its source, schema, and annotation JSON, or **Download checkpoint JSON** for a self-contained archive. Historical snapshots are read/exported directly and never passed through newer schema or annotation migrations. A checkpoint captures the current saved working view, including any legacy migration already applied when the session was loaded; creating it does not rewrite the original session.

**Restore as new session** creates an independent editable copy and leaves the current session and historical snapshot untouched. The copy retains source and annotation IDs within its new session, records its checkpoint provenance, and uses a session-local copy of the captured schema even if the original group changes or is deleted. Current annotation-format migrations may apply to the editable copy; the archive remains exact. The session banner offers **Use current group/default schema** if you want to adopt the latest group settings; this checkpoints the working state first. Full Session Record JSONL exports include the restored session's schema and provenance.

Save open annotation forms before checkpointing: unsaved form drafts are not captured. Transcript blur saves and queued workspace writes finish before the checkpoint request. Audio recordings and AI settings/credentials are intentionally excluded. Checkpoints live in the same local database, so they are not an off-device backup. Deleting a session deletes its checkpoints too (the UI requests confirmation when history exists); download any versions you want to keep first. Restored copies are separate sessions and survive deletion of their original session.

## Entity and attribute evidence

Select text, choose a category and an existing entity, then choose **Evidence supports → Entity itself** or **A specific attribute**. Select the attribute and click **Link Evidence**. To create an entity first, select its name in the text and use **Create Entity**, or add an item in the clinical notes. Edit attribute values in the notes; linking evidence does not automatically overwrite a curated value.

The mention editor's **Evidence target** dropdown can move an existing mention between the entity and its attributes without changing the source span, role, or context. Bulk context changes affect only mentions of that exact target **and the same assigned evidence role**. Attribute evidence is displayed separately from direct entity summaries.

The **Evidence Graph** tab shows the actual containment and evidence edges:

```text
Patient (this case)
└── Encounter (session)
    └── Headache
        ├── Mention: "headache"
        └── onset = Tuesday
            └── Mention: "Tuesday"
```

Patient context is case-local: ClinGraph does not yet have shared patient IDs or automatically group different sessions as the same patient. The separate **Entity Relations** view remains for semantic relations between clinical entities.

Annotation format **evidenceVersion: 2** stores attributes on each entity as `{ id, name, value }`. Attribute IDs are stable across value edits. Every mention has one explicit `target`:

```json
{"kind": "entity", "entityId": "e1"}
{"kind": "attribute", "entityId": "e1", "attributeId": "attribute:e1:onset"}
```

The mention's top-level `entityId` is retained as an ownership/navigation alias, not an additional evidence edge. A null target denotes an unlinked legacy mention. Invalid or cross-owner attribute references are rejected before saving.

Existing entity-linked mentions and legacy `supportedAttribute` name hints migrate on load. Migration preserves spans and context, creates real attribute references, and leaves unknown attribute values unassigned. It is saved to SQLite on the next edit. In v2, entity attributes are authoritative; `clinicalNotes` is a compatibility projection for the schema forms.

JSONL exports preserve this distinction: **Entities & Mentions** nests attribute evidence under its attribute, **Mention Spans** includes the explicit target, and **Full Session Record** includes the node/edge evidence graph. Downstream consumers must use `target`, not group all evidence by the ownership alias.

## Mention references versus claims

**Evidence role** is separate from **Evidence target**. Choose it when creating a mention or in its editor:

- `reference` (**Name / reference**) identifies what is discussed, without asserting a finding. For “kidney function may be reduced,” the name span “kidney function” references the entity.
- `claim` (**Claim evidence**) supports a particular proposition, whether asserted, questioned, or hypothetical. “May be reduced” supports the interpretation attribute with certainty **uncertain** and speech function **asserted**. An entity-level affirmation/denial can also be claim evidence; target kind alone does not determine the role.
- `unassigned` means the role has not been annotated. It is excluded from claim summaries until reviewed.

**Certainty** describes speaker commitment to the supported claim, not confidence in recognizing or linking the concept. Name/reference mentions use `not_applicable`; the certainty selector is disabled for this role. **Speech function** may still describe a reference's discourse context: “How is your kidney function?” can be reference + questioned + certainty not applicable, without implying a result or abnormality. A bare reference starts with function not applicable.

**Temporality** also offers `not_applicable`, separate from `unassigned`, current, past, and future. A newly created name/reference defaults to **neutral polarity** and **not-applicable temporality**. “Kidney function is stable now; will it remain stable?” has a timeless name reference, a current asserted stability claim, and a future questioned claim—not a future name reference. Missing time on a claim stays unassigned; a question does not establish a future result.

`not_applicable` means the dimension does not apply; `unassigned` means it has not been annotated or determined. Missing metadata is never defaulted to certain/asserted/positive/current/patient by the extraction adapter. Choosing the reference role explicitly sets neutral polarity and not-applicable temporality/certainty, and clears an asserted/unassigned function to not applicable; contextual questions/explanations are retained. Switching a reference to claim resets neutral polarity and not-applicable temporality/certainty/function to unassigned for review. Retargeting alone never changes role or context.

Reference polarity and temporality are editable defaults, not mandatory values. Normalization fills only missing values; saved labels (including an explicit unassigned) remain intact. Older name/reference mentions with unassigned temporality can now be reviewed and set to not applicable in the mention editor without changing their evidence targets.

Existing mentions keep their original labels, IDs, spans, and targets, with the new role left unassigned. Migration is lazy and does not rewrite SQLite on read. There is no automatic inference that an old certain/asserted label was intentional, or that all entity-targeted mentions are references. Entity summaries use only explicit **claim + asserted + patient** mentions of the entity itself, exclude attribute evidence, and do not fill missing labels with clinical defaults.

Annotations and evidence JSONL exports carry `mentionContextVersion: 1`; every normalized mention has `evidenceRole`, `polarity`, `temporality`, `certainty`, and `function`. Evidence graph mention nodes expose these fields too. AI prompts separate references from claims and scope uncertainty and time to the correct evidence target; invalid roles and claim certainty on explicit references are rejected. Model-generated annotations still need review.

## Temporal annotation

This first timing slice adds **onset**, **resolutionTime**, and **duration** to standard/FHIR symptoms, and **effectiveTime** to standard/FHIR measurements. Existing sessions acquire these slots without changing attribute IDs or mention targets. Old onset strings become unresolved temporal text, not guessed dates.

1. Use **Edit encounter time** near the top of a session to set its actual clinical date/time. This is optional and separate from workspace `createdAt`. Partial dates such as `2026` or `2026-09` are accepted; a date-time needs an explicit UTC offset or `Z`.
2. Edit a symptom or measurement and choose the timing **Format**: absolute, relative offset, interval, duration/range, or unresolved text. Event fields exclude duration; the duration field excludes event dates.
3. For a relative value, enter a signed amount and unit (`-1` week, `+5` hours), choose the anchor, source precision, and qualifier. Anchors may be the clinical encounter, another stable event-timing attribute, or an unknown event. Linking to a duration, a missing attribute, or a cyclic chain is rejected.
4. Select the original phrase in the transcript and link its mention to that timing attribute using **Evidence supports → A specific attribute**. Editing the timing value does not change the mention's source span or context.

Time values are structured objects, for example:

```json
{
  "type": "temporal",
  "kind": "relative",
  "anchor": { "kind": "encounter" },
  "offset": { "value": -1, "unit": "wk" },
  "precision": "week",
  "qualifier": "approximate",
  "text": "about a week ago"
}
```

Units are `a, mo, wk, d, h, min, s`; precision is separately recorded. Duration supports `amount: { value, maxValue?, unit }`. Intervals use optional `start`/`end` partial dates and explicit `endStatus: known | unknown | ongoing`. At least one boundary is required; a missing end is never silently marked ongoing. Original wording and mention evidence remain separate from calculations.

Relative previews and JSONL `resolvedTime` values are **derived**, never saved over the source expression. They are recalculated from the current anchor, carry source precision/qualification, and remain null for insufficiently precise or unknown anchors. Day/week offsets on date-only anchors use date arithmetic; timestamp offsets use elapsed time and display UTC. Calendar-month/year arithmetic, recurring schedules, age-based timing, and automatic interpretation of phrases such as “last week” are outside this first slice: preserve unresolved wording rather than inventing dates. This is a ClinGraph annotation structure, not a native FHIR resource export.

Exports include `temporalVersion: 1` and the clinical `encounterTime` in addition to the existing evidence model. Entity attributes keep their original structured `value` and may include a separate `resolvedTime`. Full exports also include encounter timing on the evidence graph's encounter node.

## Measurement procedures

Standard measurements and **FHIR Observation (Measurement)** have a **Part of procedure** (`partOf`) attribute. Create the procedure event (for example, the ultrasound) separately, then edit the measurement and select that procedure. Multiple events can be linked; only Procedure entities in the same session are offered. Names and available procedure timing help distinguish events.

The measurement keeps its own value and effective time. Linking to an ultrasound does not copy its timing or establish certainty that this scan produced the result. Select the wording that supports the connection and target its evidence to the measurement's **partOf** attribute; label uncertainty on that evidence as needed.

```json
{ "type": "procedure-reference", "procedureIds": ["ultrasound-event-id"] }
```

The value is null when unassigned. References use stable entity IDs; changing a procedure's name preserves the link. Unlinking or deleting a procedure through the editor retains the measurement, the partOf attribute ID, and its source mentions. API saves reject missing targets, non-procedure targets, self-links, duplicate IDs, and malformed values. AI extraction leaves these links unassigned for curation.

The knowledge graph and full export's evidence graph expose measurement → procedure `PART_OF` edges. Relation JSONL exports include these derived edges with `derivedFrom: "partOf"` and `attributeId`, identifying where their evidence belongs. Attributes remain the source of truth; relation regeneration cannot remove a curated partOf value. Checkpoints and entity/full exports retain the structured references. The evidence graph offers **Open procedure** links without duplicating the procedure's evidence subtree.

This is a ClinGraph representation of the procedure subset of [FHIR Observation.partOf](https://hl7.org/fhir/R5/observation-definitions.html#Observation.partOf), not a native FHIR export. Other FHIR target types are outside this field's current scope.

## Trajectory annotation

Standard and FHIR **symptoms, conditions, and measurements** have a **trajectory** attribute. Edit the item, choose **Improved (better)**, **Worsened (worse)**, **Unchanged**, or leave the direction unassigned. Set **Compared with which time point?** using the temporal editor: an absolute date, a signed relative offset, a known interval, or unresolved wording such as “the previous visit.” Missing comparison time stays null; it is not replaced with the encounter or workspace creation date.

Direction and comparison time form one structured comparison, separate from current severity, clinical status, and measurement time. Select “worse than a week ago” in the transcript and link it directly to **trajectory**. Both the change and reference phrases can support this attribute, without becoming entity-level evidence. Changing or clearing its value preserves the attribute ID and source mentions.

```json
{
  "type": "trajectory",
  "direction": "worsened",
  "comparedTo": {
    "type": "temporal",
    "kind": "relative",
    "anchor": { "kind": "encounter" },
    "offset": { "value": -1, "unit": "wk" },
    "precision": "week",
    "qualifier": "exact",
    "text": "a week ago"
  },
  "text": "worse than a week ago"
}
```

To compare with another annotated event, select **Relative offset**, choose its timing attribute as the anchor, and enter offset **0**. Unknown anchor dates remain unresolved. Comparisons cannot use durations or broken/cyclic time references. A numerical rise or fall does not automatically mean clinical improvement or worsening, and missing trajectory does not mean unchanged. AI prompts instruct these distinctions, but model annotations still need review.

Existing sessions receive an unassigned trajectory slot on load. Legacy trajectory wording is preserved; only exact better/improved, worse/worsened, and unchanged labels are mapped to directions, with no guessed baseline. Custom categories can add **Trajectory + Comparison Time** attributes in group schema settings.

JSONL evidence exports include `trajectoryVersion: 1`, the original trajectory value, and a separate derived `resolvedComparisonTime` where resolvable. Derived dates are recomputed, never stored over the annotation. This version supports one comparison per trajectory attribute; a sequence of changes should be annotated as distinct clinical events, not merged into one contradictory value. This remains a ClinGraph annotation structure, not a native FHIR field.

## Observation workflow versus clinical assessment

FHIR observation categories (symptoms, measurements, and social history) now separate **Result status** (`status`) from **Diagnostic assessment** (`diagnosticAssessment`). Workflow options are `registered`, `preliminary`, `final`, `amended`, `corrected`, `cancelled`, `entered-in-error`, and `unknown`, with `unassigned` for missing annotation information. A final result can describe an absent finding; a denial does not change workflow status.

Diagnostic assessment is ClinGraph-specific metadata, **not** native FHIR `Observation.verificationStatus`:

| Assessment | Meaning |
| --- | --- |
| `supported` | The finding is explicitly affirmed/supported |
| `suspected` | Suspicion is stated |
| `not_suspected` | No current basis for suspicion is stated; not proof of absence |
| `absent` | Explicit absence or denial, without assuming diagnostic exclusion |
| `ruled_out` | Diagnostic exclusion is explicitly stated |
| `indeterminate` | The assessment is explicitly inconclusive |
| `unassigned` | No assessment has been annotated |

For “no grounds to believe,” link the cue to **Diagnostic assessment → not_suspected**, not to Result status. For a symptom denial, use `absent`, not automatically `ruled_out`. A negated severity/time/value span applies only to that attribute. Numerical interpretation and trajectory remain independent. These values describe the recorded speaker's assessment, not an independently verified clinical truth.

Existing mixed `status: refuted` annotations migrate conservatively on load. The old attribute becomes `diagnosticAssessment: legacy_refuted` and receives a visible review warning; its **ID, evidence targets, original text, and mention metadata stay unchanged**. A new unassigned workflow attribute is created. The raw prior field/value is retained in the attribute's `migration` metadata. Choose an explicit assessment after reviewing the evidence; the warning clears, while migration provenance remains.

If a clinical assessment already exists, or a legacy workflow value is unfamiliar, the original node is instead retained as a separately named `legacyStatus`/`legacyAssessment` attribute with a review warning. Migration never overwrites existing assessments. Attribute IDs are opaque identifiers: after semantic migration they need not match their field name.

Each pending warning now has **Resolve this legacy value** controls, including preserved fields that are not part of the editable schema. Choose an action explicitly, then click **Resolve legacy status**:

- **Keep current assessment; retain legacy value as historical context** marks only that preserved field as reviewed, without changing any clinical value or evidence link.
- **Set assessment** applies your chosen diagnostic assessment (including **Unassigned — insufficient evidence**). For a separate legacy field, the preview identifies the current assessment and explains that its source mentions will move to the assessment attribute. Other evidence is untouched. The original legacy node/value remains available in the graph and exports; its `migration.review` records the decision, prior assessment value, target attribute ID, and moved mention IDs. If the legacy value is already on `diagnosticAssessment`, it is resolved in place with no evidence movement.

Reviewed warnings stay cleared after reload. Each legacy field is reviewed independently; no automatic absence-versus-ruled-out decision is made. Save or cancel an open entity edit before using the review controls. The graph's **Review in clinical notes** button navigates back to them. These are annotation review warnings, not failed saves; review metadata is retained for audit rather than deleting the original source value.

Migration does not rewrite storage on read; the next save persists it. Annotations and evidence exports carry `observationStatusVersion: 1`; new writes and AI output reject clinical labels in workflow status. Saved schema customizations cannot reintroduce `refuted` as a workflow choice. The old negation/keyword status overrides and cross-copying between `status`, `clinicalStatus`, and `verificationStatus` have been removed. Non-FHIR standard categories retain their existing clinical-status fields.

## Optional AI and terminology services

Manual annotation, recording/uploading audio, playback, editing, and export need no API keys. Recording does not start browser speech recognition. Audio up to 50 MB is stored without conversion; larger inputs are compressed locally if possible.

Use **Set API Keys** to configure Gemini or an OpenAI-compatible endpoint separately for annotation and transcription. For a local model server, select OpenAI, enter its `/v1` base URL and the model it serves, and leave the key blank if that server does not require one. Text generation uses `/chat/completions`; transcription requires `/audio/transcriptions`. A text-only local model cannot transcribe audio.

AI processing sends the submitted text/audio to the configured provider. Settings and keys are stored in your private Firebase account settings, or in SQLite when using offline mode. A local model URL must be reachable from the server; localhost in a hosted deployment refers to the cloud container. Missing keys and failed AI requests produce errors, never demo clinical results. Speaker inference from a text transcription is not audio-based diarization; Gemini audio timestamps are model estimates.

Mention extraction makes one chat-completion request per nonblank utterance (or document segment), with up to two preceding and two following utterances supplied as context. Only the target utterance may supply source spans; neighboring text helps resolve answers and references. An utterance can produce several mentions and attribute-evidence spans. ClinGraph validates the target index and verbatim text, then combines results in transcript order for a separate conversation-wide entity-clustering pass. Blank segments keep their original indices but do not trigger a model request.

Up to four extraction requests run concurrently per annotation run by default. Adjust **AI Settings → Clinical annotation → Parallel utterances** from `1` to `32` and save the configuration. The selection is saved with your workspace settings, survives reload, and applies to new annotation runs without a server restart. This controls simultaneous requests, not requests per minute; retries occupy the same worker slot. Individual utterance extraction requires more requests than grouping several targets together, so latency, token usage, and rate limits need to be considered. Each extraction attempt has a configurable deadline (three minutes by default) and up to two retries. Smaller targets do not guarantee complete extraction: review against human annotations is still needed to assess missed mentions.

The app sends the selection as `aiConfig.annotation.concurrency`. API clients that omit it use `CLINGRAPH_AI_CONCURRENCY` from `.env` (default `4`); changing that fallback requires a server restart. Invalid concurrency values are rejected before model requests start.

The AI annotation panel reports completed, in-progress, error-skipped, and pending utterances, with numbered status markers and error details. Blank segments are excluded from counts; displayed numbers retain their positions in the transcript. A failed utterance is skipped after its retries, and successful extractions continue to entity clustering. If every utterance fails, the run fails without replacing annotations. Clustering has its own progress stage. Final progress is saved with the session and cleared when its source transcript changes.

Extraction and clustering use `CLINGRAPH_AI_TIMEOUT_MS` (default `180000`; positive integer, maximum `900000`). The same deadline covers connection, response headers, and the complete response body, and aborts the outgoing request when reached. OpenAI-compatible text calls use this policy too. Audio transcription has separate limits. JSON clients receive HTTP **504** with `code: AI_TIMEOUT` and a request ID for a terminal timeout; invalid model output and provider errors can return 502. The UI requests `application/x-ndjson` from `POST /api/annotate`: progress records arrive during processing, and the final `result` record carries `success`, `progress`, and either `data` or error details. Streamed failures use this terminal record because response headers have already been sent. Closing an annotation request cancels its remaining extraction calls and retry waits.

Firebase mode writes structured operational AI logs to stdout, captured by Cloud Logging on Cloud Run. In SQLite mode, logs are saved to `data/logs/ai-requests.jsonl` by default (beside the database if `CLINGRAPH_DB_PATH` changes). Set `CLINGRAPH_AI_LOG_PATH` to override the location. Logs contain timestamps, a shared request ID, stage, utterance index, attempt number, elapsed time, configured deadline, endpoint path, HTTP status, upstream request ID when supplied, and token counts when available. They record headers separately from completion, so a provider that opens a response quickly but generates slowly is visible. Prompts, transcript text, response content and API keys are not written to these logs. Files rotate at 5 MiB, retaining one previous file with a `.1` suffix; a failed disk write falls back to the terminal. Logs start with this implementation; older attempts cannot be reconstructed.

Optional environment variables, also shown in `.env.example`:

| Variable | Default | Purpose |
| --- | --- | --- |
| `CLINGRAPH_STORAGE` | `firebase` | `firebase` for authenticated cloud storage or `sqlite` for offline mode |
| `PORT` | `3000` | HTTP port; Cloud Run supplies its own port |
| `CLINGRAPH_DB_PATH` | `data/clingraph.sqlite` | SQLite file, relative to the working directory or absolute |
| `CLINGRAPH_AI_CONCURRENCY` | `4` | Fallback concurrency for API requests without an explicit selection, from `1` to `32` |
| `GEMINI_API_KEY` | empty | Server-side Gemini key, overridden by an in-app key |
| `UMLS_API_KEY` | empty | Enables NLM UMLS terminology requests |

SQLite mode binds to `127.0.0.1` and rejects foreign browser origins and hostnames. It is a single-user local workspace with no database encryption. Firebase mode binds to `0.0.0.0:$PORT` and verifies a Firebase ID token before every workspace, audio, AI, and terminology API request. Each account can access only its own records. Firebase session links require the owning account; they do not make sessions public.

## Backups and existing cloud data

Stop the server, then back up `data/clingraph.sqlite`. While running, SQLite may also have `-wal` and `-shm` files; copying only the main file while it is open is not a reliable backup. The database and local settings are excluded from Git. A backup contains audio and any saved provider keys.

Firebase mode keeps the original cloud database as a read-only archive. New work uses `clingraph-v2`. Original records and saved group schemas are never normalized or rewritten by archive reads. Embedded audio is available through the archive; audio stored only in browser IndexedDB is not available on other devices.

The SQLite workspace is preserved separately and is not automatically copied to Firebase. A complete local migration must explicitly map its records to the intended Firebase user and include checkpoints, group schemas, settings, and audio; JSONL exports alone are not complete workspace backups. The current reconnection does not perform that data transfer.

## Verification

```sh
npm run lint
npm test
npm run build
npm run test:e2e
# Requires Java 21+, installed Chrome, and emulator downloads on first run.
npm run test:firebase
```

The browser tests use installed Google Chrome and an isolated database at `data/browser-test.sqlite` on port 3108. Unit/API tests use temporary SQLite files and a simulated local AI provider, so they require no credentials and incur no model charges. They cover persistence, legacy migration, stable attribute identity, precise evidence targeting, invalid references, deletion, rich metadata, exports, API boundaries, provider routing, and explicit failure behavior. Browser tests cover no-login creation, entity and attribute span annotation, retargeting, temporal and trajectory editing, comparison anchors, value edits, reload, the evidence graph, local links, and downloaded JSONL contents.

The Firebase suite runs only against the `demo-clingraph` Auth, Firestore, and Storage emulators, with synthetic data and no paid model calls. It covers verified sign-in, cross-account denial, original-layout current records, exact legacy archive preservation, immutable checkpoints, large payloads, private audio, group deletion, settings, database isolation, rejected archive mutations, and browser sign-in/autosave/archive downloads/account switching. Run `npm run build` first because the Firebase browser test exercises the production frontend.

See [REVIEW.md](REVIEW.md) for the architectural review and remaining work.
