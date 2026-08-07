type MonitoringContext = Record<string, unknown>;

let sentryReady: Promise<typeof import('@sentry/react') | null> | null = null;

export const initMonitoring = (): void => {
  const dsn = import.meta.env.VITE_SENTRY_DSN;
  if (!dsn || sentryReady) return;
  sentryReady = import('@sentry/react').then(Sentry => {
    Sentry.init({ dsn, environment: import.meta.env.MODE, release: import.meta.env.VITE_APP_VERSION });
    return Sentry;
  }).catch(error => {
    console.warn('[monitoring] Sentry initialization failed', error);
    return null;
  });
};

export const reportError = (area: string, error: unknown, context: MonitoringContext = {}): void => {
  const normalized = error instanceof Error ? error : new Error(String(error));
  console.error(`[${area}]`, normalized, context);
  if (!import.meta.env.VITE_SENTRY_DSN) return;
  initMonitoring();
  void sentryReady?.then(Sentry => Sentry?.captureException(normalized, { tags: { area }, extra: context }));
};

export const reportWarning = (area: string, message: string, context: MonitoringContext = {}): void => {
  console.warn(`[${area}] ${message}`, context);
  if (!import.meta.env.VITE_SENTRY_DSN) return;
  initMonitoring();
  void sentryReady?.then(Sentry => Sentry?.captureMessage(message, { level: 'warning', tags: { area }, extra: context }));
};
