import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import AppErrorBoundary from './components/AppErrorBoundary';
import ToastViewport from './components/ToastViewport';
import { initMonitoring, reportError } from './services/monitoring';
import LegalCenter from './components/LegalCenter';
import { installChunkRecovery } from './services/chunkRecovery';
import PwaUpdatePrompt from './components/PwaUpdatePrompt';

initMonitoring();
installChunkRecovery();
window.addEventListener('error', event => reportError('window-error', event.error ?? event.message));
window.addEventListener('unhandledrejection', event => reportError('unhandled-rejection', event.reason));

const rootElement = document.getElementById('root');
if (!rootElement) {
  throw new Error("Could not find root element to mount to");
}

const root = ReactDOM.createRoot(rootElement);
root.render(
  <React.StrictMode>
    <AppErrorBoundary><App /><ToastViewport /><PwaUpdatePrompt /><LegalCenter /></AppErrorBoundary>
  </React.StrictMode>
);
