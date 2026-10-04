# ClinGraph patient management fork design

Draft for user review. Date: 4 October 2026.

Build a fork of ClinGraph for one clinic whose clinicians share responsibility for patients. Clinicians manage longitudinal patient records, transcribe consultations, and extract information from conversations, referrals, and laboratory reports. Patients see their vitals and concerns only after a clinician has reviewed and explicitly registered that information.

Registration creates a durable clinical record with attribution and source evidence. Reviewing an annotation, saving a draft, completing an AI job, or changing a laboratory result status does not make information visible to patients.

## Agreed scope and success criteria

The user approved one clinic or care team, multiple clinicians caring for the same patient, distinct clinician and patient interfaces, read-only patient access in the first version, and clinician review followed by explicit registration before patient visibility. Clinicians upload source documents in this version.

The first release must support the complete workflow:

1. A clinician creates a patient and is assigned to that patient's care team. An administrator assigns additional clinicians.
2. The clinic links an authenticated patient account to that patient.
3. A care-team clinician records or uploads a consultation, pastes a note, or uploads a referral or laboratory report.
4. Processing produces draft findings with source evidence. The clinician can also enter information manually.
5. The clinician corrects and reviews selected findings, then explicitly registers them.
6. The patient sees those registered findings in their own portal, including dates, provenance, and later registered corrections.

Scheduling, messaging, billing, multiple independent clinics, wearable integrations, direct electronic health record connections, patient uploads, and automatic treatment recommendations are outside this first release. These exclusions keep the release focused; document intake and both portals are included.

## Architecture and fork boundary

Use a separate repository checkout at `/Users/trubetskoy/projects/ClinGraphCare`. ClinGraphCare is a working name and can be changed without changing this design. Base the fork on committed ClinGraph application code and include this spec. Preserve the original checkout and its existing uncommitted documentation and experiments. Do not copy local databases, environment files, credentials, dependency directories, or generated output.

The selected approach is one React and TypeScript app with distinct `/clinician` and `/patient` layouts, an Express API, Firebase Authentication, Firestore, and private Cloud Storage. This retains the current deployment model and lets the two interfaces share domain types and authentication without sharing their data responses. A separate private worker uses the same application image for asynchronous processing.

The alternative considered was two independently deployed frontend applications sharing an API. That permits independent releases but adds configuration and deployment work for a single clinic. The first release uses one frontend deployment; the API boundaries leave room to separate the interfaces later.

Reuse ClinGraph's recording, transcription provider adapters, transcript editing, extraction, evidence links, temporal representations, and annotation checkpoints. Place these capabilities behind patient-scoped source and processing services. Do not make session groups stand in for patients or keep the existing per-annotator ownership model as the clinical access policy.

Keep authorization, patient persistence, source intake, AI jobs, registration, and portal projection in separate modules. Mount the annotation editor inside a patient's source workspace rather than expanding the existing large `App.tsx` into the entire clinic application.

## Frontend design workflow

The user requested design skills for frontend development. Install and use [Anthropic's frontend-design](https://github.com/anthropics/skills/tree/main/skills/frontend-design) for the visual direction and implementation, and [Vercel's web-design-guidelines](https://github.com/vercel-labs/agent-skills/tree/main/skills/web-design-guidelines) for accessibility and interaction review. The repository's [frontend instructions](../../../AGENTS.md) make both part of development and must be copied into the fork.

Before implementing screens, establish shared design tokens and distinct layouts for the clinician's evidence/review workspace and the patient's readable record. Check each completed frontend change against the current interface guidelines and inspect desktop/mobile screenshots and keyboard behavior. Clinical registration, source provenance, and patient access remain the governing product requirements.

## Account access and care teams

Firebase verifies account identity. Clinic membership, care-team assignment, and patient-account binding determine access on every API request. A successful sign-in to the shared Firebase project alone grants no access to the fork.

| Actor | Permitted access |
| --- | --- |
| Clinic administrator | Manage staff membership, the patient directory, account bindings, and care-team assignments. Clinical content additionally requires clinician status and an active care-team assignment. |
| Assigned clinician | Read and manage the assigned patient's profile, sources, drafts, registered records, and clinical history. Review, register, correct, and withdraw entries. |
| Unassigned clinician | No access to the patient's clinical content, files, processing jobs, or registration endpoints. |
| Linked patient | Read their own patient-facing profile and registered records through patient-specific API responses. |
| Unlinked or suspended account | No patient or clinician data access. Display an account-access message. |

One account can have both staff and patient access, but each portal checks its own permissions. The initial administrator is provisioned by an explicit administrative bootstrap command; normal sign-up cannot select a privileged role. Administrators provision staff and link patients through single-use invitations that expire after 48 hours. Each invitation fixes the intended roles or patient and requires the verified account email to match. Use a random token with at least 256 bits of entropy and store only its hash. Consume the invitation atomically and persist the verified Firebase UID as the membership or binding. Email is an invitation delivery constraint, not the ongoing access key. This release exposes a copyable invitation link; email delivery is not required. Administrators can revoke an unused invitation.

An active clinician can create a patient; creation and the creator's initial care-team assignment are atomic. Administrators manage subsequent assignments. Check active clinic membership, patient state, and active assignment or binding from the database rather than relying solely on a role embedded in an older token. Revoking an assignment or account binding, or deactivating a patient, blocks the next relevant request. Worker execution also checks that the initiating clinician still has access before processing and before committing output.

Keep direct browser Firestore and Storage access denied. The Admin SDK bypasses Firestore client rules, so API authorization and narrowly scoped runtime IAM are both required. [Firebase security documentation](https://firebase.google.com/docs/firestore/security/rules-conditions).

## Patient records and provenance

Use a clinic namespace even though this version has one configured clinic. This is a data boundary, not a multi-clinic product feature. Server-side clinic configuration and verified permissions determine the namespace; request fields cannot grant another scope.

| Record | Contents and purpose |
| --- | --- |
| Staff membership | Verified account UID, clinician/admin roles, active state, and administrative history. |
| Patient | Stable patient ID, name, optional date of birth and clinic identifier, contact details, and revision. Unknown demographics remain unknown. |
| Care-team assignment | Patient ID, clinician UID, active state, and assignment history. |
| Patient account binding | Verified account UID, patient ID, and active state. One patient binding per account in this release. |
| Source | Patient ID, consultation/referral/lab-report/note kind, title, author when known, clinical date when known, original file reference, and revision. |
| Source version | Immutable original-file and text/annotation hashes, exact transcript or document text, segment/page identifiers, saved annotation snapshot, and creation metadata. Large payloads live in private object storage. |
| Processing job | Patient/source/version IDs, initiating clinician, stage, bounded progress, attempts, provider/model and prompt/schema versions, errors, and timestamps. No credentials. |
| Draft finding | Proposed typed measurement, concern, or summary; source version and evidence references; clinical time; context; review state, reviewer UID/time, and reviewed revision; and optimistic revision. |
| Registered entry | Patient ID, entry type, stable entry ID, immutable registered revisions, current revision pointer, registering clinician/time, and provenance. |
| Concern | Clinician-established identity grouping related concern entries across encounters. Names alone never merge concerns automatically. |
| Audit event | Actor, operation, patient/record IDs, version references, and server timestamp, recorded atomically with clinical mutations. |

Source evidence identifies the source ID and immutable version plus transcript segment or document page, verbatim text, and text offsets where available. Annotation links retain entity/attribute/mention IDs. Patient-facing provenance includes source type, title, clinical date, and a short clinician-approved excerpt; it does not expose an entire internal transcript or document.

Clinical event time, document time, extraction time, and registration time are separate fields. Preserve partial dates, approximation, uncertainty, negation, and experiencer information. A family-history statement, question, or denied symptom must not become a positive current patient concern through a default mapping. Any clinician reinterpretation is recorded explicitly.

Measurements retain a label or optional terminology code, a clinician-selected series identity, value, unit when known, clinical time, and reference interval when supplied by the source or clinician. Support scalar numeric values, comparator values, text results, and named components such as systolic/diastolic pressure. Do not guess units, convert units implicitly, infer reference ranges, or derive a diagnosis from a numeric result.

Concerns retain the clinician-selected label, description, status, clinical time, and assessment or uncertainty when applicable. A concern can be a symptom, a condition, or another issue; the portal must preserve that distinction. Concern status is active, resolving, resolved, historical, or unassigned. Related encounters can be linked to an existing concern by explicit clinician choice.

## Clinician interface

The clinician home shows the patients assigned to that clinician and their pending review work. Use paginated summaries and load detailed sources on demand, instead of downloading every transcript on startup.

A patient workspace contains an overview, registered vitals and concerns, encounters/documents, a review queue, and clinical history. It supports profile editing, manual measurement and concern entry, and source creation. Administrative account and care-team controls are available only to administrators.

Opening a source shows the original document or audio, transcript/document text, extraction progress, evidence-linked draft findings, and ClinGraph's detailed annotation editor. Keep the research annotation tools accessible here; the default patient overview shows clinical records.

The review queue allows the clinician to compare a proposed item with its source, change values or wording, supply or confirm clinical time, select concern grouping, and mark the item reviewed. Saving changes to a reviewed item's content resets its review state. Reviewed findings have a preview of the exact information that will appear in the patient portal.

## Review registration and corrections

Draft findings move from `draft` to `reviewed` through an explicit clinician action. Registration requires the exact reviewed revision. The UI action is **Register in patient record** and shows the selected items and their patient-facing content before submitting.

Registration checks the clinician's current care-team access, each draft revision and review state, the immutable source version, evidence ownership, and required typed content. Manual entries identify the author and manual origin; they do not require invented source evidence. Unknown clinical dates or units may be registered when explicitly confirmed as unknown and are displayed accordingly.

Register at most 25 selected findings in one transaction. Registration creates immutable entry revisions, marks the draft revisions as registered, advances current entry pointers, and appends the audit event atomically. A stale revision or invalid selection rejects the entire batch with item-level reasons. Return HTTP 409 for a concurrent change. A request idempotency key prevents double-clicks and retried requests from creating duplicate entries; reusing it with different content is rejected.

The application's registration state is independent of an observation's laboratory workflow status. For example, a laboratory result labeled `preliminary` can appear in the portal only if a clinician registers it and preserves its preliminary label. A result labeled `final` remains invisible until registered.

Editing transcripts, modifying annotations, or rerunning extraction creates new source/draft versions. It never edits registered entries. Correcting a registered entry creates a correction draft, which requires explicit review and a new registration action. Patients see the current registered revision and a correction indicator; the history contains only previously registered revisions. Clinicians retain the full audit trail.

Withdrawing an entry requires a reason and records a new audited revision. All patient views, including correction history, omit the withdrawn entry's clinical content and show that the clinic removed an entry. Clinicians retain its prior revisions and withdrawal reason. Existing sources referenced by registered records can be archived but are not hard-deleted through routine source management. A patient can be deactivated without deleting their record history.

## Patient interface

The portal home shows the patient's registered vitals, concerns, and encounter summaries, with clear clinical dates and registration attribution. It offers a chronological timeline and focused views for measurements and concerns. Use an empty state when nothing is registered.

The patient API constructs an allowlisted response from registered records. It must not return draft findings, internal comments, job state, provider configuration, raw annotations, source storage paths, staff administration data, or raw audio/documents. Client-side hiding is insufficient. Patient responses and file APIs use private, non-cacheable responses, and account switching clears in-memory data.

Charts compare only compatible measurements with the same identity, unit, and component. Undated or insufficiently precise measurements remain in the list and are excluded from a chart that needs a precise date. Show recorded reference intervals only when present. No independent abnormality classification or generated care recommendation is added.

Concern cards show the registered wording, distinction between symptoms and diagnoses, recorded assessment/uncertainty, status, date, and source attribution. Summaries are clinician-written or clinician-reviewed and registered. The patient cannot edit records, upload files, or trigger AI processing in this release.

## Conversation and document processing

Support microphone recording and audio upload using ClinGraph's existing provider adapters, along with pasted transcripts and notes. Transcription is draft material, including speaker assignments and any estimated timestamps, and can be corrected before extraction or registration.

Document intake accepts PDF, JPEG, PNG, and plain text. The pilot limits are 50 MiB per audio file, 20 MiB per document file, 1 MiB per pasted/plain-text source, and 100 pages per PDF. Validate actual format as well as the supplied MIME type. Reject malformed, encrypted, unsupported, or oversized files with explicit errors. Store originals privately before processing; partially uploaded sources do not enter the review queue.

Extract selectable PDF text locally with page boundaries. When a page has no usable text, use the configured document-capable Gemini provider to transcribe that page or image. Treat model-generated document text as unreviewed, retain the original page for comparison, and require review of its source excerpt before registration. Source documents can contain instructions; processing treats those instructions as document content, not commands to the application. Gemini supports PDF input, but that capability is not evidence of transcription or clinical extraction accuracy. [Gemini document documentation](https://ai.google.dev/gemini-api/docs/document-processing).

Reuse ClinGraph's clinical extraction against the resulting segmented text. Convert source-grounded measurements, symptoms/concerns, and candidate summaries into draft findings, preserving unknown context. Register selected findings only; extraction is not a wholesale replacement of the patient's record.

Annotation, transcription, and document text extraction have separate configured provider capabilities. Existing OpenAI-compatible text or audio endpoints do not automatically gain PDF/image support. If document text extraction is unavailable, report that limitation and permit the clinician to paste or manually enter text. No service failure supplies fabricated findings or transcripts.

## Durable jobs and failure handling

Persist job state before dispatch. In cloud mode, use a dedicated Cloud Tasks queue and an authenticated private Cloud Run worker. Task messages contain job and stage IDs; patient source content and credentials are read from authorized storage. Each stage checkpoints output and dispatches its successor only after committing that output. Closing the browser does not cancel the job.

Use bounded page/utterance batches and configurable provider deadlines. Jobs expose queued, running, ready for review, partial, failed, cancelled, and access-revoked states. Retry transient failures with a bounded policy; configuration/authentication errors and invalid source output fail explicitly. A clinician can retry failed portions without replacing successful drafts or registered information.

Cloud Tasks can execute a task more than once. Workers use stage IDs, transactional leases, and idempotent output writes so duplicate dispatch cannot duplicate source versions or findings. External provider calls may still repeat after an interrupted attempt. Store the requested dispatch alongside job state; an authenticated reconciliation endpoint retries pending dispatches and expired stages after an enqueue failure or worker interruption. Cloud Scheduler invokes that endpoint every five minutes using the worker invocation identity, so recovery does not depend on a browser staying open. The UI reports dispatch failures and exposes a retry action instead of leaving a job indefinitely labeled running. [Cloud Tasks execution behavior](https://docs.cloud.google.com/tasks/docs/common-pitfalls), [authenticated Cloud Scheduler targets](https://docs.cloud.google.com/scheduler/docs/http-target-auth).

Source edits during a job do not change its captured input. Completed output remains linked to its input version and is marked stale relative to newer source content. A stale draft requires a fresh review of its captured source version and explicit acknowledgement that newer source content exists before registration. Registration records this acknowledgement; evidence is never silently relinked to newer text. Cancellation or access revocation is checked before each provider batch and before output commit.

Operational logs record request/job IDs, stages, durations, attempts, response codes, and usage counts when available. They exclude clinical text, model content, files, credentials, and invitation tokens. A failed write or provider error leaves registered information intact. Transactions do not contain external AI calls or object-storage uploads.

## API and service boundaries

Separate the public routes into `/api/me`, administrator-only `/api/admin/*`, care-team-authorized `/api/clinician/patients/:patientId/*`, and `/api/patient/*`. The patient namespace derives patient identity from the active account binding rather than a freely supplied patient ID.

Clinician operations cover paginated patient listing, patient/profile editing, source upload/versioning, private source viewing, job start/status/cancel/retry, draft editing/review, registration batches, registered corrections, and withdrawal. All mutable records use optimistic revision checks. Cross-patient source/evidence references are rejected even when the clinician is assigned to both patients.

Internal worker and reconciliation handlers live in the private worker service and require the configured Google service identity. The public app does not expose an alternate path into these handlers. Cloud Tasks dispatch uses an OIDC identity with permission to invoke that worker. [Authenticated Cloud Tasks requests](https://docs.cloud.google.com/tasks/docs/creating-http-target-tasks#use_http_target_tasks_with_authentication_tokens).

Domain services depend on typed repositories and provider/job-dispatch interfaces. Firestore is the hosted store. Local development and automated tests use Firebase Auth, Firestore, and Storage emulators with synthetic users; an injected local dispatcher replaces Cloud Tasks and deterministic provider fixtures replace paid calls. The existing unauthenticated SQLite workspace is not the patient application's access model.

## Google Cloud deployment

The existing repository's [deployment documentation](../../../DEPLOYMENT.md) identifies Google Cloud project `room-furnishing` and region `europe-west2`. These are the requested hosting targets; resource availability must be checked when preparing deployment.

Use these defaults for the fork:

| Resource | Default |
| --- | --- |
| Public Cloud Run app | `clingraph-care` |
| Private Cloud Run worker | `clingraph-care-worker` |
| Firestore database | `clingraph-care` |
| Private bucket | `room-furnishing-clingraph-care-data` |
| App/worker runtime account | `clingraph-care-runtime@room-furnishing.iam.gserviceaccount.com` |
| Task invocation account | `clingraph-care-dispatch@room-furnishing.iam.gserviceaccount.com` |
| Cloud Tasks queue | `clingraph-care-processing` |
| Cloud Scheduler reconciliation job | `clingraph-care-reconcile`, every five minutes |

Continue using the existing project's Firebase Authentication. Add the fork's deployed host to its authorized domains without removing existing hosts. API permissions come from the fork's membership data, independent of ClinGraph's accounts and sessions. Firestore supports separate databases in the same project. [Firebase database documentation](https://firebase.google.com/docs/firestore/manage-databases).

The new runtime receives database access only to `clingraph-care`, object access only to its private bucket, the necessary queue permissions, and access only to its configured provider secrets. The dispatch identity can invoke only the worker. Grant no access to ClinGraph's current or legacy databases. Deploy client-access rules only to the new database; adapt provisioning and deployment scripts to target the fork explicitly.

Provider credentials use server-side environment or Secret Manager configuration and are never returned to the portal or stored in browser settings. Preserve separate provider/model selection for annotation, transcription, and document text extraction. Do not automatically import the original application's saved user keys.

Serve the app directly from Cloud Run and store persistent records and files externally. Build one Node 24 container image for app and worker entry points. Prepare a candidate deployment with a reviewable resource/identity plan and verify it before assigning the fork's normal traffic. Existing ClinGraph traffic and archives are outside the fork's deployment target. Local/cloud data migration is not automatic.

## Verification and acceptance

Implementation verification uses synthetic clinical content, deterministic provider responses, and Firebase emulators. Existing reusable annotation regression coverage remains in place. Type checking, unit/API tests, a production build, and browser tests are required before release.

Required behavioral checks:

1. Two assigned clinicians can manage one patient's record; an unassigned clinician cannot access the record, files, jobs, or mutation routes.
2. Each patient sees only their bound patient's registered information. Unlinked accounts, forged patient IDs, and cross-patient evidence references fail.
3. Draft, reviewed-but-unregistered, failed, and partial extractions remain absent from every patient API response, including timeline, chart, summary, and correction history.
4. Registration requires explicit review of the current revision, is atomic, records attribution/provenance, and resists duplicate submissions and concurrent edits.
5. Source edits and AI reruns cannot change registered records. Corrections require review/registration; withdrawals update patient views while preserving clinical audit history.
6. Unknown dates/units, partial dates, uncertainty, negation, and family history are preserved. Incompatible or undated values do not create misleading trend points.
7. Conversation recording/upload, transcription, manual correction, extraction, review, and registration work end to end. Missing provider configuration and provider failures show explicit errors.
8. Digital PDFs, scanned PDFs, images, and text reports can produce page-linked drafts. Corrupt, encrypted, unsupported, and oversized sources fail clearly.
9. Refreshing or closing a browser preserves jobs. Duplicate delivery, failed dispatch, interrupted workers, cancellation, access revocation, and stale source versions have deterministic outcomes.
10. Patient responses contain no raw source files, drafts, internal comments, private object paths, provider keys, or invitation tokens. Revocation and account switching prevent later access.
11. The deployment plan targets only the fork's resources and grants the runtime no ClinGraph database access. Hosted validation exercises sign-in, care-team access, persistence, private files, processing, registration, and the patient portal.

Passing software checks establishes the application's workflows and data boundaries. Extraction accuracy still requires review against representative clinical sources; automated fixtures do not establish medical correctness.

## Implementation order

Deliver this single-clinic release in four coherent stages, with one implementation plan covering the complete agreed scope:

1. Create the isolated fork, typed patient/domain repositories, authentication, care-team access, patient bindings, and source provenance.
2. Build manual records, draft review, atomic registration, corrections, the clinician workspace, and the patient portal. This supplies an end-to-end usable record workflow before AI integration.
3. Embed the existing annotation/transcription capabilities, add document intake and durable processing, and connect source-linked draft findings to the review queue.
4. Complete browser/emulator acceptance checks, prepare isolated cloud resources, and validate the hosted candidate and deployment plan.

Detailed task boundaries, dependency versions, commands, and execution method belong in the implementation plan after this written design is approved.
