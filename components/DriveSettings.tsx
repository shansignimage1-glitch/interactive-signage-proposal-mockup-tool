import React, { useState } from 'react';
import { ConnectorStatus } from '../types';
import { connectors, DriveConnector, getPreferredProvider, setPreferredProvider } from '../services/driveConnectors';
import { X, HardDrive, Check, Loader2, Unplug, CloudOff } from 'lucide-react';

interface DriveSettingsProps {
  isOpen: boolean;
  onClose: () => void;
  onStatusChange: (status: ConnectorStatus) => void;
}

// Cloud-storage settings: connect the user's own drive so project photos are
// stored there instead of the app's Firebase bucket. connect() runs directly
// in the click handler — the OAuth popup needs a user gesture (iPad Safari).
const DriveSettings: React.FC<DriveSettingsProps> = ({ isOpen, onClose, onStatusChange }) => {
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Bump to re-read connector state after connect/disconnect
  const [, setVersion] = useState(0);

  if (!isOpen) return null;

  const handleConnect = async (connector: DriveConnector) => {
    setBusyId(connector.id);
    setError(null);
    try {
      await connector.connect();
      setPreferredProvider(connector.id);
      onStatusChange('connected');
    } catch (e: any) {
      setError(e?.message ?? 'Connection failed.');
    } finally {
      setBusyId(null);
      setVersion(v => v + 1);
    }
  };

  const handleDisconnect = async (connector: DriveConnector) => {
    setBusyId(connector.id);
    setError(null);
    try {
      await connector.disconnect();
      onStatusChange('disconnected');
    } finally {
      setBusyId(null);
      setVersion(v => v + 1);
    }
  };

  return (
    <div className="fixed inset-0 z-[150] bg-black/80 backdrop-blur-sm flex items-center justify-center p-4">
      <div className="bg-gray-900 border border-gray-700 rounded-2xl shadow-2xl w-full max-w-md flex flex-col overflow-hidden">
        <div className="flex items-center justify-between p-4 border-b border-gray-700 bg-gray-800">
          <h2 className="text-white font-bold text-lg flex items-center gap-2">
            <HardDrive className="w-5 h-5 text-blue-400" /> Cloud Storage
          </h2>
          <button onClick={onClose} className="p-2 text-gray-400 hover:text-white hover:bg-gray-700 rounded">
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="p-4 space-y-3">
          <p className="text-xs text-gray-400">
            Connect your own cloud drive and this app will store your project photos in a
            <span className="text-gray-200 font-semibold"> "SignagePro" </span>
            folder there. When no drive is connected, photos are stored with the app.
          </p>
          <p className="text-xs text-amber-300/80 bg-amber-950/30 border border-amber-900 rounded-lg p-2">Disconnecting revokes this app's access. Files already created in your SignagePro folder remain in the provider until you delete the project data or remove those files yourself.</p>

          {connectors.map(connector => {
            const connected = connector.available && connector.isConnected();
            const preferred = getPreferredProvider() === connector.id;
            const busy = busyId === connector.id;
            return (
              <div
                key={connector.id}
                className={`flex items-center justify-between p-3 rounded-lg border ${connector.available ? 'bg-gray-800 border-gray-700' : 'bg-gray-800/40 border-gray-800'}`}
              >
                <div className="flex items-center gap-3">
                  {connector.available
                    ? <HardDrive className="w-5 h-5 text-blue-400" />
                    : <CloudOff className="w-5 h-5 text-gray-600" />}
                  <div>
                    <p className={`text-sm font-semibold ${connector.available ? 'text-gray-100' : 'text-gray-500'}`}>{connector.label}</p>
                    {connected && (
                      <p className="text-[11px] text-green-400 flex items-center gap-1"><Check className="w-3 h-3" /> Connected</p>
                    )}
                    {connected && preferred && <p className="text-[11px] text-blue-400">Selected for new files</p>}
                    {!connector.available && <p className="text-[11px] text-amber-600">OAuth setup required</p>}
                  </div>
                </div>

                {connector.available && (
                  busy ? (
                    <Loader2 className="w-4 h-4 text-blue-400 animate-spin" />
                  ) : connected ? (
                    <div className="flex gap-1">
                      {!preferred && <button onClick={() => { setPreferredProvider(connector.id); onStatusChange('connected'); setVersion(v => v + 1); }} className="text-xs text-blue-300 bg-blue-950 border border-blue-800 px-2 py-1.5 rounded-lg">Use</button>}
                      <button
                        onClick={() => handleDisconnect(connector)}
                        className="text-xs flex items-center gap-1 text-red-400 hover:text-red-300 bg-gray-900 border border-gray-700 px-3 py-1.5 rounded-lg"
                      >
                        <Unplug className="w-3 h-3" /> Disconnect
                      </button>
                    </div>
                  ) : (
                    <button
                      onClick={() => handleConnect(connector)}
                      className="text-xs font-semibold bg-blue-600 hover:bg-blue-500 text-white px-3 py-1.5 rounded-lg"
                    >
                      Connect
                    </button>
                  )
                )}
              </div>
            );
          })}

          {error && (
            <p className="text-xs text-red-400 bg-red-950/40 border border-red-900 rounded-lg p-2">{error}</p>
          )}
        </div>
      </div>
    </div>
  );
};

export default DriveSettings;
