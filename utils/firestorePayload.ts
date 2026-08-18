/** Firestore rejects undefined at any nesting level, while local IndexedDB does not. */
export const withoutUndefined = <T>(value: T): T => {
  if (Array.isArray(value)) {
    return value.filter(item => item !== undefined).map(item => withoutUndefined(item)) as T;
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, item]) => item !== undefined)
        .map(([key, item]) => [key, withoutUndefined(item)]),
    ) as T;
  }
  return value;
};
