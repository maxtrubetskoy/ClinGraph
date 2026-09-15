# Firebase and AI Studio deployment

ClinGraph serves the React frontend and authenticated API from one Node 24 server. Firebase Auth provides Google sign-in. Project `room-furnishing` hosts two separate Firestore databases in `europe-west2`:

- `clingraph-v2`: current sessions, groups, AI settings, and immutable checkpoints.
- `ai-studio-clinicalconversa-3ce6f1dc-daba-4e40-8425-55a414691cb0`: original sessions and schemas, exposed only through the read-only legacy archive.

The existing AI Studio Cloud Run service is **clinical-conversation-annotator**, at <https://clinical-conversation-annotator-xa4lefhyua-nw.a.run.app>. No local SQLite sessions or checkpoints are uploaded. See [SCHEMA_MIGRATION.md](SCHEMA_MIGRATION.md) for the database and schema boundary.

## Authentication and infrastructure

Install the [Google Cloud CLI](https://docs.cloud.google.com/sdk/docs/install-sdk), then authenticate:

```sh
gcloud auth login --update-adc
bash scripts/prepare-firebase.sh
```

The preparation script sets the local ADC quota project, enables required APIs, creates the current database and dedicated runtime identity, and configures the private bucket `room-furnishing-clingraph-data`. It does not modify legacy records, publish an app revision, or change Firestore client rules. Set `CLINGRAPH_GCLOUD` if gcloud is outside PATH.

Runtime identity `clingraph-runtime@room-furnishing.iam.gserviceaccount.com` receives `roles/datastore.user` only for `clingraph-v2` and `roles/datastore.viewer` only for the archive, through [per-database IAM conditions](https://firebase.google.com/docs/firestore/manage-databases). The preparation script removes its earlier legacy write grant. It receives `roles/storage.objectAdmin` only on the dedicated bucket, which has uniform bucket access and public-access prevention. Other project applications retain their own resources and roles.

Cloud Run supplies [Application Default Credentials](https://firebase.google.com/docs/admin/setup) through its service account. Do not bundle service-account keys. Source builds require appropriate build permissions, including `roles/run.builder` on the build identity; see [Cloud Run build service accounts](https://docs.cloud.google.com/run/docs/configuring/services/build-service-account).

## Verification and deployment

```sh
npm ci
npm run lint
npm test
npm run build
npm run test:e2e
npm run test:firebase
```

The Firebase suite requires Java 21+ and Chrome. It uses only the `demo-clingraph` emulators and synthetic data. The production frontend must be built before its browser test. `.gcloudignore` and `.dockerignore` exclude local databases, environment files, dependencies, and credential files from source uploads.

AI Studio's original service uses a zip source and automatic base image. Build a Docker image separately so stale source annotations cannot block the update:

```sh
gcloud builds submit --project=room-furnishing --region=europe-west2 \
  --tag=europe-west2-docker.pkg.dev/room-furnishing/cloud-run-source-deploy/clinical-conversation-annotator:YOUR_VERSION .
gcloud artifacts docker images describe \
  europe-west2-docker.pkg.dev/room-furnishing/cloud-run-source-deploy/clinical-conversation-annotator:YOUR_VERSION \
  --format='value(image_summary.digest)'
```

Use the returned immutable digest and a unique revision name to inspect the deployment plan, then submit the candidate:

```sh
node scripts/deploy-firebase.mjs \
  europe-west2-docker.pkg.dev/room-furnishing/cloud-run-source-deploy/clinical-conversation-annotator@sha256:DIGEST \
  clinical-conversation-annotator-firebase-YOUR_VERSION
# Repeat with --apply after reviewing the plan.
```

The script preserves existing secret values and the service identity, removes obsolete zip/base-image metadata, applies the new database settings and runtime identity, and creates a `preview` revision with zero live traffic. It pins existing traffic to the previous revision. It does not deploy Firestore rules or perform cutover. Its API update includes the current resource version to reject concurrent configuration changes.

Preserve the service's existing public invocation policy so visitors can reach the sign-in page. The app requires verified Firebase tokens for workspace, archive, audio, AI, and terminology APIs. Cloud Run request concurrency is separate from the frontend **Parallel utterances** control, which applies per annotation run. Configure provider keys in AI Settings or runtime secrets; The deployment script preserves unrelated existing variables and secrets.

Verify the candidate's `/api/runtime`, sign-in, current workspace persistence, and legacy archive. Add the deployed hostname to Firebase Authentication's **Authorized domains** without removing existing domains if needed.

At cutover, deploy the client-access rules for the **two explicit databases** in `firebase.json` and move traffic to the verified candidate revision:

```sh
GOOGLE_CLOUD_QUOTA_PROJECT=room-furnishing npx firebase deploy --only firestore:rules --project=room-furnishing
gcloud run services update-traffic clinical-conversation-annotator \
  --project=room-furnishing --region=europe-west2 --to-revisions=VERIFIED_REVISION=100
```

The rules deny direct browser Firestore access. The runtime API remains able to read the archive through its read-only IAM grant. These rules stop stale copies of the old frontend from writing legacy records; perform the traffic switch in the same cutover. Other Firestore databases are outside this config. Deploy the optional payload index exemptions in `firestore.indexes.json` to the new database without deleting unrelated existing indexes in the archive. No Cloud Storage Firebase rules are deployed to shared project buckets; bucket access uses IAM.

## Hosting behavior

Serve the app directly from Cloud Run. Firebase Hosting rewrites impose a [60-second request timeout](https://firebase.google.com/docs/hosting/cloud-run), which can interrupt annotation. The service uses a [3600-second timeout](https://docs.cloud.google.com/run/docs/configuring/request-timeout); closing the browser request still cancels outstanding model calls. The Dockerfile builds the complete app; the server listens on `0.0.0.0:$PORT`. Workspace persistence is external because [Cloud Run's filesystem is temporary](https://docs.cloud.google.com/run/docs/container-contract). Firebase mode writes structured operational diagnostics to stdout for Cloud Logging.

## Synchronizing source with AI Studio

Push the reviewed source to the connected GitHub repository and pull it through AI Studio's GitHub integration, or use **Import from GitHub** for a new project. Include server code, frontend code, lockfile, Dockerfile, and Firebase configuration. Build outputs are regenerated. See [AI Studio Build](https://ai.google.dev/gemini-api/docs/aistudio-build-mode) and [deployment documentation](https://ai.google.dev/gemini-api/docs/aistudio-deploying).

Direct Cloud Run deployment updates the hosted app but does not synchronize AI Studio's source editor. Before publishing again from AI Studio, pull the updated source and retain the runtime database settings, service account, bucket, and request timeout. Publishing an old editor copy could replace the new application code.

## Deployed version — 15 September 2026

The live service and <https://clingraph.ai.studio> serve revision `clinical-conversation-annotator-firebase-0915a` with 100% of traffic. Image digest: `sha256:e5295076732c29a811c8e09b38b7a510b140eeda76aa40e65981311a814dc567`. Build: `6c92ac8d-7ede-4a52-bb2d-75386fa06a56` in `europe-west2`.

Firestore client rules were deployed to both explicit databases. The runtime has database-scoped write access to `clingraph-v2` and read-only access to the original archive. The existing Cloud Run URL and preview hostname were added to Firebase's authorized domains, preserving existing entries. The `clingraph.ai.studio` domain was already authorized.

Validation: 77 unit/API tests, 7 Firebase tests, 12 browser regression tests, typecheck, and local/Cloud Build production builds passed. The hosted preview read the signed-in owner's 13 archived sessions and passed authenticated session, checkpoint, and private audio persistence checks. The synthetic test session and storage objects were removed. A temporary token-signing permission used for verification was removed. Both live URLs return the new Firebase runtime configuration, and Chrome renders the live sign-in page.

No local SQLite sessions or checkpoints were migrated. No GitHub push or AI Studio source-editor synchronization was performed by this deployment; synchronize source before republishing from that editor.
