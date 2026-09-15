import { applicationDefault } from 'firebase-admin/app';

// AI Studio's original zip deployment has source/base-image annotations that
// gcloud's Docker source-deploy path cannot replace. Preserve service identity,
// secrets and live traffic while preparing a container-based candidate revision.
const [image, revision, mode] = process.argv.slice(2);
const service = 'clinical-conversation-annotator';
const repository = 'europe-west2-docker.pkg.dev/room-furnishing/cloud-run-source-deploy/clinical-conversation-annotator';
if (!image?.startsWith(repository + '@sha256:') || !/^[a-f0-9]{64}$/.test(image.split('@sha256:')[1] || '') ||
    !revision?.startsWith(service + '-firebase-') || !/^[a-z0-9-]{1,63}$/.test(revision) ||
    (mode && mode !== '--apply')) throw new Error('Usage: node scripts/deploy-firebase.mjs IMAGE@sha256:DIGEST NEW_REVISION [--apply]');

const endpoint = `https://europe-west2-run.googleapis.com/apis/serving.knative.dev/v1/namespaces/room-furnishing/services/${service}`;
try {
  const credential = applicationDefault();
  const { access_token } = await credential.getAccessToken();
  const headers = { Authorization: `Bearer ${access_token}`, 'Content-Type': 'application/json', 'x-goog-user-project': 'room-furnishing' };
  const response = await fetch(endpoint, { headers });
  if (!response.ok) throw new Error(`Could not read service: HTTP ${response.status}`);
  const current = await response.json();
  if (current.spec.template.spec.containers.length !== 1) throw new Error('Expected the existing single-container ClinGraph service');
  if (current.status.latestCreatedRevisionName === revision) throw new Error('Choose a new revision name');
  const liveTraffic = current.status.traffic.filter(entry => entry.tag !== 'preview').map(entry => ({
    revisionName: entry.revisionName, percent: entry.percent || 0, ...(entry.tag ? { tag: entry.tag } : {})
  }));
  if (liveTraffic.reduce((total, entry) => total + entry.percent, 0) !== 100) throw new Error('Cannot preserve current traffic safely');
  const template = structuredClone(current.spec.template);
  template.metadata = { name: revision, annotations: { ...template.metadata.annotations }, labels: { ...template.metadata.labels } };
  delete template.metadata.annotations['run.googleapis.com/sources'];
  delete template.metadata.annotations['run.googleapis.com/base-images'];
  template.metadata.annotations['autoscaling.knative.dev/minScale'] = '0';
  template.metadata.annotations['autoscaling.knative.dev/maxScale'] = '3';
  delete template.spec.runtimeClassName;
  template.spec.serviceAccountName = 'clingraph-runtime@room-furnishing.iam.gserviceaccount.com';
  template.spec.timeoutSeconds = 3600;
  template.spec.containerConcurrency = 8;
  const container = template.spec.containers[0];
  container.image = image;
  delete container.command; delete container.args; delete container.workingDir;
  delete container.startupProbe; delete container.livenessProbe; delete container.readinessProbe;
  container.ports = [{ name: 'http1', containerPort: 8080 }];
  container.resources = { limits: { cpu: '1', memory: '1Gi' } };
  const settings = {
    CLINGRAPH_STORAGE: 'firebase', FIREBASE_PROJECT_ID: 'room-furnishing', FIRESTORE_DATABASE_ID: 'clingraph-v2',
    LEGACY_FIRESTORE_DATABASE_ID: 'ai-studio-clinicalconversa-3ce6f1dc-daba-4e40-8425-55a414691cb0',
    FIREBASE_STORAGE_BUCKET: 'room-furnishing-clingraph-data'
  };
  container.env = [...(container.env || []).filter(entry => !(entry.name in settings)),
    ...Object.entries(settings).map(([name, value]) => ({ name, value }))];
  const annotations = { ...current.metadata.annotations };
  delete annotations['run.googleapis.com/operation-id'];
  delete annotations['run.googleapis.com/build-enable-automatic-updates'];
  annotations['run.googleapis.com/maxScale'] = '3';
  const desired = {
    apiVersion: current.apiVersion, kind: current.kind,
    metadata: { name: current.metadata.name, namespace: current.metadata.namespace,
      resourceVersion: current.metadata.resourceVersion, labels: current.metadata.labels, annotations },
    spec: { ...current.spec, template, traffic: [...liveTraffic, { revisionName: revision, percent: 0, tag: 'preview' }] }
  };
  console.log(JSON.stringify({ service, revision, image, retainedTraffic: liveTraffic,
    runtimeIdentity: template.spec.serviceAccountName, settings, mode: mode || 'preview-plan' }, null, 2));
  if (mode === '--apply') {
    const deployed = await fetch(endpoint, { method: 'PUT', headers, body: JSON.stringify(desired) });
    if (!deployed.ok) {
      const error = await deployed.json();
      throw new Error(`Preview deployment failed (${deployed.status}): ${error.error?.message || 'Cloud Run rejected the revision'}`);
    }
    console.log('Candidate revision submitted. Live traffic remains pinned to the existing revision.');
  }
} catch (error) { console.error(error.message); process.exitCode = 1; }
