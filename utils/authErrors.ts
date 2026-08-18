export const isMissingRedirectStateError = (error: unknown): boolean => {
  const candidate = error as { code?: unknown; message?: unknown } | null;
  const code = typeof candidate?.code === 'string' ? candidate.code.toLowerCase() : '';
  const message = typeof candidate?.message === 'string' ? candidate.message.toLowerCase() : '';
  return code === 'auth/missing-initial-state'
    || message.includes('missing initial state')
    || message.includes('sessionstorage is inaccessible or accidentally cleared');
};

export const isAuthCancellationError = (error: unknown): boolean => {
  const candidate = error as { code?: unknown } | null;
  const code = typeof candidate?.code === 'string' ? candidate.code.toLowerCase() : '';
  return code === 'auth/user-cancelled'
    || code === 'auth/popup-closed-by-user'
    || code === 'auth/cancelled-popup-request';
};
