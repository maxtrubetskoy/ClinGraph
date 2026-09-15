import { initializeApp, getApps, type FirebaseOptions } from 'firebase/app';
import { getAuth, connectAuthEmulator, type Auth } from 'firebase/auth';

let auth: Auth | null = null;
export function initializeFirebaseAuth(config: FirebaseOptions, emulatorUrl?: string) {
  if (auth) return auth;
  const app = getApps().find(app => app.name === 'clingraph') || initializeApp(config, 'clingraph');
  auth = getAuth(app);
  if (emulatorUrl) connectAuthEmulator(auth, emulatorUrl, { disableWarnings: true });
  return auth;
}

/** All workspace, audio, AI, and terminology requests share the current sign-in. */
export async function apiFetch(input: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  if (auth) {
    const user = auth.currentUser;
    if (!user) throw new Error('Sign in to access your workspace.');
    headers.set('Authorization', `Bearer ${await user.getIdToken()}`);
    if (auth.currentUser?.uid !== user.uid) throw new Error('Your signed-in account changed. Please try again.');
  }
  return fetch(input, { ...init, headers });
}
