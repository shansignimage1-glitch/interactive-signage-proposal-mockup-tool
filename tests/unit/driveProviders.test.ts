import { describe, expect, it } from 'vitest';
import { getPreferredProvider, setPreferredProvider, isCloudDriveRef } from '../../services/driveConnectors/providerState';

describe('cloud provider selection and references', () => {
  it('persists the preferred provider', () => {
    setPreferredProvider('onedrive');
    expect(getPreferredProvider()).toBe('onedrive');
    setPreferredProvider('dropbox');
    expect(getPreferredProvider()).toBe('dropbox');
  });

  it('recognizes references from every supported provider', () => {
    expect(isCloudDriveRef('gdrive://abc')).toBe(true);
    expect(isCloudDriveRef('onedrive://abc')).toBe(true);
    expect(isCloudDriveRef('dropbox://id:abc')).toBe(true);
    expect(isCloudDriveRef('https://example.com/image.png')).toBe(false);
  });
});
