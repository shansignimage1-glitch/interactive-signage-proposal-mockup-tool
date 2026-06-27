
import { TitleBlockTemplate } from '../types';

export const TITLE_BLOCK_TEMPLATES: TitleBlockTemplate[] = [
  {
    id: 'classic-vertical',
    name: 'Classic Vertical',
    layout: 'vertical-right',
    headerColor: '#000000',
    textColor: '#000000',
    backgroundColor: '#ffffff',
    fontFamily: 'sans-serif',
    logoPosition: 'top'
  },
  {
    id: 'modern-dark',
    name: 'Modern Dark',
    layout: 'vertical-right',
    headerColor: '#3b82f6', // blue-500
    textColor: '#ffffff',
    backgroundColor: '#1f2937', // gray-800
    fontFamily: 'monospace',
    logoPosition: 'bottom'
  },
  {
    id: 'architectural-bottom',
    name: 'Architectural Bar',
    layout: 'horizontal-bottom',
    headerColor: '#444444',
    textColor: '#000000',
    backgroundColor: '#f3f4f6', // gray-100
    fontFamily: 'serif',
    logoPosition: 'top' // Left side in horizontal mode usually
  },
  {
      id: 'blueprint-blue',
      name: 'Blueprint Style',
      layout: 'vertical-right',
      headerColor: '#1e3a8a',
      textColor: '#1e3a8a',
      backgroundColor: '#eff6ff',
      fontFamily: 'monospace',
      logoPosition: 'top'
  }
];
