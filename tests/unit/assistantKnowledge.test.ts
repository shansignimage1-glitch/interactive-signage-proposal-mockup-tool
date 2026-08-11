import { describe, expect, it } from 'vitest';
import {
  buildAssistantSystemInstruction,
  selectAssistantProductKnowledge,
  SIGNAGEPRO_KNOWLEDGE_VERSION,
  SIGNAGEPRO_PRODUCT_KNOWLEDGE,
} from '../../api/_lib/assistantKnowledge';

describe('SignagePro assistant knowledge', () => {
  it('is versioned and includes the current device and project workflows', () => {
    expect(SIGNAGEPRO_KNOWLEDGE_VERSION).toBe('2026-08-11');
    expect(SIGNAGEPRO_PRODUCT_KNOWLEDGE).toContain('iPhone and Android');
    expect(SIGNAGEPRO_PRODUCT_KNOWLEDGE).toContain('maximum dimension of 4096 px');
    expect(SIGNAGEPRO_PRODUCT_KNOWLEDGE).toContain('720 px thumbnail');
    expect(SIGNAGEPRO_PRODUCT_KNOWLEDGE).toContain('Save project returns the user to the saved-project screen');
    expect(SIGNAGEPRO_PRODUCT_KNOWLEDGE).toContain('New project starts clean');
  });

  it('documents calibrated planes and the honest limits of measurement', () => {
    expect(SIGNAGEPRO_PRODUCT_KNOWLEDGE).toContain('A homography models only one flat plane');
    expect(SIGNAGEPRO_PRODUCT_KNOWLEDGE).toContain('Parallel offset plane');
    expect(SIGNAGEPRO_PRODUCT_KNOWLEDGE).toContain('wall 500 mm farther back should use a +500 mm offset');
    expect(SIGNAGEPRO_PRODUCT_KNOWLEDGE).toContain('Without calibration, size is visual only');
  });

  it('explains pixels and the exact dimension calculations without implying a fixed pixel size', () => {
    expect(SIGNAGEPRO_PRODUCT_KNOWLEDGE).toContain('A pixel (picture element)');
    expect(SIGNAGEPRO_PRODUCT_KNOWLEDGE).toContain('An image pixel has no fixed physical width or height');
    expect(SIGNAGEPRO_PRODUCT_KNOWLEDGE).toContain('25.4 divided by PPI/DPI');
    expect(SIGNAGEPRO_PRODUCT_KNOWLEDGE).toContain('intrinsic image pixels');
    expect(SIGNAGEPRO_PRODUCT_KNOWLEDGE).toContain('mm per pixel = confirmed millimetres / reference pixel distance');
    expect(SIGNAGEPRO_PRODUCT_KNOWLEDGE).toContain('a 350 px line on the same plane is 700 mm');
    expect(SIGNAGEPRO_PRODUCT_KNOWLEDGE).toContain("sign's displayed width is the average of its transformed top and bottom edge lengths");
    expect(SIGNAGEPRO_PRODUCT_KNOWLEDGE).toContain('do not present them as survey-grade');
  });

  it('documents the corrected extrusion model and construction choices', () => {
    expect(SIGNAGEPRO_PRODUCT_KNOWLEDGE).toContain('Backing board + raised artwork');
    expect(SIGNAGEPRO_PRODUCT_KNOWLEDGE).toContain('Individual letters/logo (no board)');
    expect(SIGNAGEPRO_PRODUCT_KNOWLEDGE).toContain('15 units equals 5% of placed sign width');
    expect(SIGNAGEPRO_PRODUCT_KNOWLEDGE).toContain('per-element depths remain independent');
    expect(SIGNAGEPRO_PRODUCT_KNOWLEDGE).toContain('Camera-pose 3D');
    expect(SIGNAGEPRO_PRODUCT_KNOWLEDGE).toContain('relative-width-v1');
    expect(SIGNAGEPRO_PRODUCT_KNOWLEDGE).toContain('separate logo, letter and backing-board side colours are not yet available');
  });

  it('instructs the model to stay grounded instead of inventing capabilities', () => {
    const instruction = buildAssistantSystemInstruction([{ text: 'Teach me how to start' }]);
    expect(instruction).toContain(SIGNAGEPRO_PRODUCT_KNOWLEDGE.trim());
    expect(instruction).toContain('Do not invent controls');
    expect(instruction).toContain('visual approximation, calibrated measurement and physically based projection');
    expect(instruction).toContain('say that you are not certain');
  });

  it('routes a dimension question to compact measurement knowledge', () => {
    const instruction = buildAssistantSystemInstruction([{ text: 'What is a pixel and how are dimensions calculated?' }]);
    expect(instruction).toContain('Calibration and measurement');
    expect(instruction).toContain('mm per pixel = confirmed millimetres / reference pixel distance');
    expect(instruction).not.toContain('Libraries and storage');
    expect(instruction.length).toBeLessThan(8_500);
  });

  it('routes extrusion questions without transmitting the full knowledge base', () => {
    const selected = selectAssistantProductKnowledge([{ role: 'user', text: 'Why is my extrusion thin?' }]);
    expect(selected).toContain('3D extrusion');
    expect(selected).not.toContain('Phone site capture and image quality');
    expect(selected.length).toBeLessThan(SIGNAGEPRO_PRODUCT_KNOWLEDGE.length / 2);
  });

  it('prioritizes the latest user question over older conversation topics', () => {
    const selected = selectAssistantProductKnowledge([
      { role: 'user', text: 'How do I save a project?' },
      { role: 'model', text: 'Use Save project.' },
      { role: 'user', text: 'Tell me about phone photo capture and leveling a wall.' },
      { role: 'model', text: 'Capture the elevation and use the optional level tool.' },
      { role: 'user', text: 'Why is my extrusion thin?' },
    ]);
    expect(selected).toContain('3D extrusion');
  });

  it('does not let an older overview request force later turns to send all knowledge', () => {
    const selected = selectAssistantProductKnowledge([
      { role: 'user', text: 'Teach me how to start' },
      { role: 'model', text: 'Start by choosing a project.' },
      { role: 'user', text: 'Why is my extrusion thin?' },
    ]);
    expect(selected).toContain('3D extrusion');
    expect(selected).not.toContain('Libraries and storage');
  });

  it.each(['How do I get started?', 'Help me get started', 'What can you do?'])('recognizes onboarding phrasing: %s', phrase => {
    expect(selectAssistantProductKnowledge([{ role: 'user', text: phrase }])).toBe(SIGNAGEPRO_PRODUCT_KNOWLEDGE.trim());
  });

  it.each(['How big is my sign?', 'How is the actual size calculated?'])('routes natural size phrasing: %s', phrase => {
    const selected = selectAssistantProductKnowledge([{ role: 'user', text: phrase }]);
    expect(selected).toContain('Calibration and measurement');
    expect(selected).toContain('Professional sign placement');
  });

  it.each(['Teach me how extrusion works', 'Tell me everything about dimensions'])('keeps focused teaching requests topic-routed: %s', phrase => {
    const selected = selectAssistantProductKnowledge([{ role: 'user', text: phrase }]);
    expect(selected.length).toBeLessThan(SIGNAGEPRO_PRODUCT_KNOWLEDGE.length / 2);
    expect(selected).not.toContain('Libraries and storage');
  });
});
