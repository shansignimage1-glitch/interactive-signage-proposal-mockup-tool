import React from 'react';
import { reportError } from '../services/monitoring';

interface ErrorBoundaryProps { children: React.ReactNode }

export default class AppErrorBoundary extends React.Component<ErrorBoundaryProps, { failed: boolean }> {
  declare readonly props: Readonly<ErrorBoundaryProps>;
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  componentDidCatch(error: Error, info: React.ErrorInfo) { reportError('react-boundary', error, { componentStack: info.componentStack }); }
  render() {
    if (this.state.failed) return <main className="h-full bg-gray-950 text-white grid place-items-center p-6"><div className="max-w-md text-center"><h1 className="text-2xl font-bold">SignagePro hit an unexpected problem</h1><p className="text-gray-400 mt-3">Your locally saved projects are still on this device. Reload the app to continue.</p><button onClick={() => location.reload()} className="mt-5 rounded-lg bg-blue-600 px-5 py-2 font-semibold">Reload app</button></div></main>;
    return this.props.children;
  }
}
