const COLOR_PROPERTIES = [
  'color', 'background-color', 'border-top-color', 'border-right-color',
  'border-bottom-color', 'border-left-color', 'outline-color', 'text-decoration-color',
  'caret-color', 'fill', 'stroke', 'box-shadow',
];

const normalizeModernColors = (doc: Document, root: HTMLElement): void => {
  const canvas = doc.createElement('canvas');
  canvas.width = canvas.height = 1;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return;
  const cache = new Map<string, string>();
  const convert = (value: string): string => value.replace(/oklch\([^)]*\)/gi, color => {
    const cached = cache.get(color); if (cached) return cached;
    ctx.clearRect(0, 0, 1, 1); ctx.fillStyle = color; ctx.fillRect(0, 0, 1, 1);
    const [r, g, b, a] = ctx.getImageData(0, 0, 1, 1).data;
    const rgba = `rgba(${r}, ${g}, ${b}, ${a / 255})`; cache.set(color, rgba); return rgba;
  });

  const elements = [doc.documentElement, doc.body, root, ...Array.from(root.querySelectorAll<HTMLElement>('*'))];
  for (const element of elements) {
    const computed = doc.defaultView?.getComputedStyle(element); if (!computed) continue;
    for (const property of COLOR_PROPERTIES) {
      const value = computed.getPropertyValue(property);
      if (value.includes('oklch(')) element.style.setProperty(property, convert(value), 'important');
    }
  }
};

export const captureElement = async (element: HTMLElement, scale: number): Promise<HTMLCanvasElement> => {
  const { default: html2canvas } = await import('html2canvas');
  return html2canvas(element, {
    useCORS: true, allowTaint: true, backgroundColor: null, scale, logging: false,
    onclone: clonedDoc => {
      const clonedElement = clonedDoc.getElementById(element.id) as HTMLElement | null;
      if (!clonedElement) return;
      clonedElement.style.transform = 'none';
      clonedElement.style.margin = '0';
      clonedElement.style.boxShadow = 'none';
      normalizeModernColors(clonedDoc, clonedElement);
    },
  });
};
