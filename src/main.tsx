import {StrictMode} from 'react';
import {createRoot} from 'react-dom/client';
import AuthenticationGate from './components/AuthenticationGate';
import './index.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <AuthenticationGate />
  </StrictMode>,
);
