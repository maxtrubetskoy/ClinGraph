import { useEffect, useState } from 'react';
import { GoogleAuthProvider, onAuthStateChanged, signInWithPopup, signOut, type User } from 'firebase/auth';
import { initializeFirebaseAuth } from '../firebase';
import App from '../App';

export default function AuthenticationGate() {
  const [runtime, setRuntime] = useState<any>(null);
  const [ready, setReady] = useState(false);
  const [user, setUser] = useState<User | null>(null);
  const [error, setError] = useState('');
  const [signingIn, setSigningIn] = useState(false);
  useEffect(() => {
    let active = true;
    let unsubscribe: (() => void) | undefined;
    void fetch('/api/runtime').then(async response => {
      if (!response.ok) throw new Error('Could not connect to ClinGraph.');
      const config = await response.json();
      if (!active) return;
      setRuntime(config);
      if (config.storage === 'sqlite') { setReady(true); return; }
      const auth = initializeFirebaseAuth(config.firebase, config.authEmulatorUrl);
      unsubscribe = onAuthStateChanged(auth, current => { if (active) { setUser(current); setReady(true); setError(''); } });
    }).catch(error => { if (active) { setError(error.message); setReady(true); } });
    return () => { active = false; unsubscribe?.(); };
  }, []);

  if (ready && runtime && (runtime.storage === 'sqlite' || user)) return <App key={user?.uid || 'local'}
    storageMode={runtime.storage} accountName={user?.displayName || user?.email || 'Signed in'}
    onSignOut={user ? () => { void signOut(initializeFirebaseAuth(runtime.firebase)); } : undefined} />;

  const signIn = async () => {
    setError(''); setSigningIn(true);
    try { await signInWithPopup(initializeFirebaseAuth(runtime.firebase), new GoogleAuthProvider()); }
    catch (error: any) { setError(error.message || 'Could not sign in. Please try again.'); }
    finally { setSigningIn(false); }
  };
  return <main className="min-h-screen flex items-center justify-center bg-slate-50 p-6">
    <div className="panel w-full max-w-md p-8 space-y-5">
      <h1 className="text-2xl font-semibold text-slate-900">ClinGraph</h1>
      {!ready ? <p role="status" className="text-sm text-slate-600">Connecting to your workspace…</p> : <>
        <p className="text-sm text-slate-600">Sign in to open your clinical annotation workspace. Your sessions, checkpoints, audio, and AI settings are saved to your account.</p>
        {runtime && <button type="button" onClick={signIn} disabled={signingIn} className="btn btn-primary w-full">
          {signingIn ? 'Signing in…' : 'Sign in with Google'}
        </button>}
      </>}
      {error && <p role="alert" className="text-sm text-rose-700 break-words">{error}</p>}
    </div>
  </main>;
}
