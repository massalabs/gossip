import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { getMeshStatus, isMeshActive } from '../services/meshNode';

const REFRESH_MS = 5_000;

/**
 * Phones the mesh node is linked with, refreshed every few seconds; null
 * while the mesh is off. Lets the "no internet" states say that messages
 * still go over Bluetooth.
 */
export function useMeshLinks(): number | null {
  const [links, setLinks] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    const refresh = async () => {
      const status = isMeshActive() ? await getMeshStatus() : null;
      if (!cancelled) setLinks(status ? status.meshPeers : null);
    };
    void refresh();
    const timer = setInterval(() => void refresh(), REFRESH_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);

  return links;
}

/**
 * What to say while there is no internet: still connected through the mesh
 * (with how many phones), or waiting for a connection.
 */
export function useOfflineLabel(): { label: string; mesh: boolean } {
  const { t } = useTranslation('discussions');
  const links = useMeshLinks();
  if (links === null) return { label: t('waiting_connection'), mesh: false };
  return {
    label:
      links > 0 ? t('mesh_connected', { count: links }) : t('mesh_no_links'),
    mesh: true,
  };
}
