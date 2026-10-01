import React, { useState } from 'react';
import { Check, Download, Loader2, Ruler, X } from 'lucide-react';
import { LEAN_MAX_DIMENSION, type FinishMeasuringInfo } from '../utils/precisionPhoto';

interface FinishMeasuringDialogProps {
  info: FinishMeasuringInfo;
  viewName: string;
  /** The full-resolution original, preloaded so saving can run inside the tap
   *  (iOS only opens the share sheet during the user's gesture). */
  original: { status: 'loading' } | { status: 'ready'; file: File } | { status: 'unavailable'; reason: string };
  onConfirm: () => Promise<void>;
  onClose: () => void;
}

type SaveState = 'idle' | 'saving' | 'saved' | 'failed';

// Share sheet on phones/tablets ("Save Image" puts it in Photos; "Save to
// Files" keeps the original format); a normal download everywhere else.
const saveFileToDevice = async (file: File): Promise<void> => {
  if (typeof navigator.canShare === 'function' && navigator.canShare({ files: [file] })) {
    await navigator.share({ files: [file], title: file.name });
    return;
  }
  const url = URL.createObjectURL(file);
  const link = document.createElement('a');
  link.href = url;
  link.download = file.name;
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
};

const FinishMeasuringDialog: React.FC<FinishMeasuringDialogProps> = ({ info, viewName, original, onConfirm, onClose }) => {
  const [saveState, setSaveState] = useState<SaveState>('idle');
  const [isFinishing, setIsFinishing] = useState(false);

  const handleSave = async () => {
    if (original.status !== 'ready') return;
    setSaveState('saving');
    try {
      await saveFileToDevice(original.file);
      setSaveState('saved');
    } catch (error) {
      // Dismissing the share sheet is a choice, not a failure.
      setSaveState(error instanceof DOMException && error.name === 'AbortError' ? 'idle' : 'failed');
    }
  };

  const handleConfirm = async () => {
    setIsFinishing(true);
    try { await onConfirm(); }
    finally { setIsFinishing(false); }
  };

  const sizeLabel = `${info.width.toLocaleString()} × ${info.height.toLocaleString()} px`;

  return (
    <div className="fixed inset-0 z-[210] flex items-center justify-center bg-black/75 p-4 backdrop-blur-sm" onClick={isFinishing ? undefined : onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="finish-measuring-title"
        className="w-full max-w-md rounded-2xl border border-gray-700 bg-gray-900 p-6 shadow-2xl"
        onClick={event => event.stopPropagation()}
      >
        <div className="mb-4 flex items-start justify-between gap-3">
          <h2 id="finish-measuring-title" className="flex items-center gap-2 text-lg font-bold text-white">
            <Ruler className="h-5 w-5 text-amber-400" /> Finish measuring
          </h2>
          <button onClick={onClose} disabled={isFinishing} className="text-gray-400 hover:text-white disabled:opacity-40" aria-label="Close">
            <X className="h-5 w-5" />
          </button>
        </div>

        <p className="mb-3 text-sm text-gray-300">
          <strong className="text-white">{viewName}</strong> was measured on the full-resolution photo ({sizeLabel}).
          Finishing keeps only the lighter working copy (at most {LEAN_MAX_DIMENSION.toLocaleString()} px) for this view.
        </p>
        <ul className="mb-5 space-y-1.5 text-xs text-gray-400">
          <li>• Every dimension, calibration and sign keeps its real-world size.</li>
          <li>• The full-resolution original is removed from the project and the cloud.</li>
          <li>• New measurements after this use the working copy. This can't be undone.</li>
        </ul>

        <div className="mb-5 rounded-xl border border-gray-700 bg-gray-800/60 p-3">
          <p className="mb-2 text-xs font-bold uppercase tracking-wider text-gray-400">Keep the original on this device</p>
          {original.status === 'loading' && (
            <p className="flex items-center gap-2 text-xs text-gray-400"><Loader2 className="h-3.5 w-3.5 animate-spin" /> Preparing the original…</p>
          )}
          {original.status === 'unavailable' && <p className="text-xs text-gray-400">{original.reason}</p>}
          {original.status === 'ready' && (
            <button
              onClick={handleSave}
              disabled={saveState === 'saving'}
              className="flex min-h-11 w-full items-center justify-center gap-2 rounded-lg bg-gray-700 px-4 text-sm font-semibold text-white hover:bg-gray-600 disabled:opacity-60"
            >
              {saveState === 'saving' ? <Loader2 className="h-4 w-4 animate-spin" />
                : saveState === 'saved' ? <Check className="h-4 w-4 text-green-400" />
                : <Download className="h-4 w-4" />}
              {saveState === 'saved' ? 'Original saved' : 'Save original to Photos / Files'}
            </button>
          )}
          {saveState === 'failed' && <p className="mt-2 text-xs text-red-400">The original could not be saved. You can try again before finishing.</p>}
        </div>

        <div className="flex gap-2">
          <button onClick={onClose} disabled={isFinishing} className="flex-1 rounded-lg bg-gray-700 py-2.5 text-sm text-gray-200 hover:bg-gray-600 disabled:opacity-40">
            Cancel
          </button>
          <button
            onClick={handleConfirm}
            disabled={isFinishing || original.status === 'loading'}
            className="flex flex-1 items-center justify-center gap-2 rounded-lg bg-amber-500 py-2.5 text-sm font-bold text-gray-950 hover:bg-amber-400 disabled:opacity-50"
          >
            {isFinishing && <Loader2 className="h-4 w-4 animate-spin" />} Finish measuring
          </button>
        </div>
      </div>
    </div>
  );
};

export default FinishMeasuringDialog;
