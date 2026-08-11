import React, { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../services/GeminiService', () => ({
  askSignageAssistant: vi.fn(),
  generateSpeech: vi.fn(),
}));

import Assistant from '../../components/Assistant';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe('Pro Guide greeting', () => {
  let root: Root;
  let host: HTMLDivElement;

  beforeEach(() => {
    Object.defineProperty(Element.prototype, 'scrollIntoView', { configurable: true, value: vi.fn() });
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
  });

  it('introduces the newly documented workflows when opened', async () => {
    await act(async () => root.render(React.createElement(Assistant, { isOpen: true, setIsOpen: vi.fn() })));
    expect(document.body.textContent).toContain('mobile site capture, calibration, sign placement, 3D extrusion and project workflows');
  });
});
