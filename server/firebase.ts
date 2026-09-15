import { initializeApp, getApps, applicationDefault } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore } from 'firebase-admin/firestore';
import { getStorage } from 'firebase-admin/storage';
import type { RequestHandler } from 'express';
import savedConfig from '../firebase-applet-config.json';

export function firebaseConfig() {
  const projectId = process.env.FIREBASE_PROJECT_ID || savedConfig.projectId;
  const firestoreDatabaseId = process.env.FIRESTORE_DATABASE_ID || 'clingraph-v2';
  const legacyFirestoreDatabaseId = process.env.LEGACY_FIRESTORE_DATABASE_ID || savedConfig.firestoreDatabaseId;
  if (firestoreDatabaseId === legacyFirestoreDatabaseId || firestoreDatabaseId === savedConfig.firestoreDatabaseId) {
    throw new Error('The current workspace must use a separate database from the legacy archive');
  }
  return {
    ...savedConfig, projectId,
    apiKey: process.env.FIREBASE_WEB_API_KEY || savedConfig.apiKey,
    authDomain: process.env.FIREBASE_AUTH_DOMAIN || savedConfig.authDomain,
    storageBucket: process.env.FIREBASE_STORAGE_BUCKET || 'room-furnishing-clingraph-data',
    firestoreDatabaseId, legacyFirestoreDatabaseId,
  };
}

export function firebaseServices() {
  const config = firebaseConfig();
  const app = getApps().find(app => app.name === 'clingraph') || initializeApp({
    projectId: config.projectId, storageBucket: config.storageBucket,
    ...(process.env.FIRESTORE_EMULATOR_HOST ? {} : { credential: applicationDefault() }),
  }, 'clingraph');
  return { auth: getAuth(app), firestore: getFirestore(app, config.firestoreDatabaseId),
    legacyFirestore: getFirestore(app, config.legacyFirestoreDatabaseId), bucket: getStorage(app).bucket() };
}

/** Never accept a user ID from request parameters, JSON, or an unverified token. */
export const requireFirebaseUser: RequestHandler = (req, res, next) => {
  const match = req.get('authorization')?.match(/^Bearer (\S+)$/);
  if (!match) { res.status(401).json({ error: 'Sign in to access your workspace.' }); return; }
  void firebaseServices().auth.verifyIdToken(match[1]).then(token => {
    res.locals.userId = token.uid;
    next();
  }).catch(() => res.status(401).json({ error: 'Your sign-in has expired. Please sign in again.' }));
};
