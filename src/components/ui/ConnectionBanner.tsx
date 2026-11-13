import React from 'react';
import { Bluetooth, WifiOff } from 'react-feather';
import { useOnlineStore } from '../../stores/useOnlineStore';
import { useOfflineLabel } from '../../hooks/useMeshLinks';

const ConnectionBanner: React.FC = () => {
  const isOnline = useOnlineStore(s => s.isOnline);
  const offline = useOfflineLabel();

  if (isOnline) return null;

  const Icon = offline.mesh ? Bluetooth : WifiOff;
  return (
    <div className="flex items-center justify-center gap-2 px-4 py-1.5 bg-warning/15 text-warning text-xs font-medium">
      <Icon className="w-3.5 h-3.5 shrink-0" />
      <span>{offline.label}</span>
    </div>
  );
};

export default ConnectionBanner;
