import { useState, useEffect, useCallback, useMemo } from 'react';
import { getSdk } from '../stores/sdkStore';

const RETENTION_HEADER_LABELS: Record<number, string> = {
  300: 'settings.auto_delete_5m',
  3600: 'settings.auto_delete_1h',
  28800: 'settings.auto_delete_8h',
  86400: 'settings.auto_delete_1d',
  604800: 'settings.auto_delete_1w',
  2592000: 'settings.auto_delete_1mo',
};

export function useRetentionPolicy(
  t: (key: string, opts?: Record<string, unknown>) => string
): {
  retentionDuration: number | null;
  retentionPolicySetAt: number | null;
  isRetentionModalOpen: boolean;
  setIsRetentionModalOpen: (open: boolean) => void;
  handleSelectRetention: (value: number | null) => Promise<void>;
  retentionHeaderLabel: string | null;
  retentionInfo: { setAt: number; duration: number } | null;
} {
  const [isRetentionModalOpen, setIsRetentionModalOpen] = useState(false);
  const [retentionDuration, setRetentionDuration] = useState<number | null>(
    null
  );
  const [retentionPolicySetAt, setRetentionPolicySetAt] = useState<
    number | null
  >(null);

  useEffect(() => {
    const sdk = getSdk();
    if (!sdk.isSessionOpen) return;
    void sdk.selfMessages.getRetentionInfo().then(info => {
      setRetentionDuration(info.duration);
      setRetentionPolicySetAt(info.setAt);
    });
  }, []);

  const handleSelectRetention = useCallback(async (value: number | null) => {
    const sdk = getSdk();
    if (!sdk.isSessionOpen) return;
    await sdk.selfMessages.setRetentionPolicy(value);
    setRetentionDuration(value);
    setRetentionPolicySetAt(value ? Date.now() : null);
    setIsRetentionModalOpen(false);
  }, []);

  const retentionHeaderLabel = useMemo(() => {
    if (!retentionDuration) return null;
    const key = RETENTION_HEADER_LABELS[retentionDuration];
    return key ? t(key) : null;
  }, [retentionDuration, t]);

  const retentionInfo = useMemo(
    () =>
      retentionDuration && retentionPolicySetAt
        ? { setAt: retentionPolicySetAt, duration: retentionDuration }
        : null,
    [retentionDuration, retentionPolicySetAt]
  );

  return {
    retentionDuration,
    retentionPolicySetAt,
    isRetentionModalOpen,
    setIsRetentionModalOpen,
    handleSelectRetention,
    retentionHeaderLabel,
    retentionInfo,
  };
}
