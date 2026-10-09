#!/usr/bin/env bash
set -euo pipefail

# Provision a new workspace database and read-only access to the original archive.
# Never copies workspace data or changes the currently served Cloud Run revision.
CLINGRAPH_GCLOUD="${CLINGRAPH_GCLOUD:-gcloud}"
CLINGRAPH_PROJECT=room-furnishing
CLINGRAPH_RUNTIME=clingraph-runtime@room-furnishing.iam.gserviceaccount.com
CLINGRAPH_BUCKET=room-furnishing-clingraph-data

"$CLINGRAPH_GCLOUD" auth application-default set-quota-project "$CLINGRAPH_PROJECT"
"$CLINGRAPH_GCLOUD" services enable run.googleapis.com cloudbuild.googleapis.com \
  artifactregistry.googleapis.com firestore.googleapis.com storage.googleapis.com \
  --project="$CLINGRAPH_PROJECT"

CLINGRAPH_ACCOUNT_FOUND=$("$CLINGRAPH_GCLOUD" iam service-accounts list --project="$CLINGRAPH_PROJECT" \
  --filter="email=$CLINGRAPH_RUNTIME" --format='value(email)')
if [[ -z "$CLINGRAPH_ACCOUNT_FOUND" ]]; then
  "$CLINGRAPH_GCLOUD" iam service-accounts create clingraph-runtime --project="$CLINGRAPH_PROJECT" \
    --display-name='ClinGraph runtime'
fi
"$CLINGRAPH_GCLOUD" projects add-iam-policy-binding "$CLINGRAPH_PROJECT" \
  --member="serviceAccount:$CLINGRAPH_RUNTIME" --role=roles/datastore.user \
  --condition='expression=resource.name=="projects/room-furnishing/databases/clingraph-v2",title=clingraph-v2-database' \
  --format='value(version)'
"$CLINGRAPH_GCLOUD" projects add-iam-policy-binding "$CLINGRAPH_PROJECT" \
  --member="serviceAccount:$CLINGRAPH_RUNTIME" --role=roles/datastore.viewer \
  --condition='expression=resource.name=="projects/room-furnishing/databases/ai-studio-clinicalconversa-3ce6f1dc-daba-4e40-8425-55a414691cb0",title=clingraph-archive' \
  --format='value(version)'

# Authorize the AI Studio preview runtime container if present or specified
CLINGRAPH_AI_STUDIO_RUNTIME="${AUTHORIZED_SERVICE_ACCOUNT_EMAIL:-ais-sandbox@ais-europe-west2-d082e3eb33c94.iam.gserviceaccount.com}"
if [[ -n "${CLINGRAPH_AI_STUDIO_RUNTIME:-}" ]]; then
  echo "Granting Firestore and Storage permissions to AI Studio preview runtime ($CLINGRAPH_AI_STUDIO_RUNTIME)..."
  "$CLINGRAPH_GCLOUD" projects add-iam-policy-binding "$CLINGRAPH_PROJECT" \
    --member="serviceAccount:$CLINGRAPH_AI_STUDIO_RUNTIME" --role=roles/datastore.user \
    --condition='expression=resource.name=="projects/room-furnishing/databases/clingraph-v2",title=clingraph-v2-database' \
    --format='value(version)' || "$CLINGRAPH_GCLOUD" projects add-iam-policy-binding "$CLINGRAPH_PROJECT" \
    --member="serviceAccount:$CLINGRAPH_AI_STUDIO_RUNTIME" --role=roles/datastore.user \
    --format='value(version)'
  "$CLINGRAPH_GCLOUD" projects add-iam-policy-binding "$CLINGRAPH_PROJECT" \
    --member="serviceAccount:$CLINGRAPH_AI_STUDIO_RUNTIME" --role=roles/datastore.viewer \
    --condition='expression=resource.name=="projects/room-furnishing/databases/ai-studio-clinicalconversa-3ce6f1dc-daba-4e40-8425-55a414691cb0",title=clingraph-archive' \
    --format='value(version)' || true
fi

# Remove the old preparation's write grant; retain unrelated IAM bindings.
CLINGRAPH_WRITE_GRANTS=$("$CLINGRAPH_GCLOUD" projects get-iam-policy "$CLINGRAPH_PROJECT" \
  --flatten=bindings --filter="bindings.role=roles/datastore.user AND bindings.members:serviceAccount:$CLINGRAPH_RUNTIME" \
  --format='value(bindings.condition.title)')
if [[ "$CLINGRAPH_WRITE_GRANTS" == *clingraph-database* ]]; then
  "$CLINGRAPH_GCLOUD" projects remove-iam-policy-binding "$CLINGRAPH_PROJECT" \
    --member="serviceAccount:$CLINGRAPH_RUNTIME" --role=roles/datastore.user \
    --condition='expression=resource.name=="projects/room-furnishing/databases/ai-studio-clinicalconversa-3ce6f1dc-daba-4e40-8425-55a414691cb0",title=clingraph-database' \
    --format='value(version)'
fi
CLINGRAPH_DATABASE_FOUND=$("$CLINGRAPH_GCLOUD" firestore databases list --project="$CLINGRAPH_PROJECT" \
  --filter='name:databases/clingraph-v2' --format='value(name)')
if [[ -z "$CLINGRAPH_DATABASE_FOUND" ]]; then
  "$CLINGRAPH_GCLOUD" firestore databases create --project="$CLINGRAPH_PROJECT" \
    --database=clingraph-v2 --location=europe-west2 --type=firestore-native
fi

CLINGRAPH_BUCKET_FOUND=$("$CLINGRAPH_GCLOUD" storage buckets list --project="$CLINGRAPH_PROJECT" \
  --filter="name=$CLINGRAPH_BUCKET" --format='value(name)')
if [[ -z "$CLINGRAPH_BUCKET_FOUND" ]]; then
  "$CLINGRAPH_GCLOUD" storage buckets create "gs://$CLINGRAPH_BUCKET" \
    --project="$CLINGRAPH_PROJECT" --location=europe-west2 \
    --uniform-bucket-level-access --public-access-prevention
fi
"$CLINGRAPH_GCLOUD" storage buckets add-iam-policy-binding "gs://$CLINGRAPH_BUCKET" \
  --member="serviceAccount:$CLINGRAPH_RUNTIME" --role=roles/storage.objectAdmin \
  --format='value(version)'
if [[ -n "${CLINGRAPH_AI_STUDIO_RUNTIME:-}" ]]; then
  "$CLINGRAPH_GCLOUD" storage buckets add-iam-policy-binding "gs://$CLINGRAPH_BUCKET" \
    --member="serviceAccount:$CLINGRAPH_AI_STUDIO_RUNTIME" --role=roles/storage.objectAdmin \
    --format='value(version)' || true
fi
