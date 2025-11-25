import { useCallback, useState } from 'react';
import * as yaml from 'js-yaml';

import { decodeFromBase64, encodeToBase64 } from '../utils/base64';

export interface FileContact {
  userPubKeys: Uint8Array;
  userName?: string;
}

type ImportableYaml = {
  // New schema
  userPubKeys?: number[] | string;
  userName?: string;
};

type fileState = {
  fileContact: FileContact | null;
  isLoading: boolean;
  error: string | null;
};

export function useFileShareContact() {
  const [fileState, setFileState] = useState<fileState>({
    fileContact: null,
    isLoading: false,
    error: null,
  });

  const exportFileContact = useCallback(async (contact: FileContact) => {
    try {
      setFileState(prev => ({ ...prev, error: null }));
      const doc = {
        // Export as base64 using Buffer (no btoa)
        userPubKeys: encodeToBase64(contact.userPubKeys),
        userName: contact.userName ?? undefined,
      };
      const yamlText = yaml.dump(doc, { noRefs: true });

      // Prefer a generic type for maximum compatibility in download fallbacks (iOS/Safari quirks)
      const blob = new Blob([yamlText], { type: 'application/octet-stream' });
      const base = (contact.userName || 'contact')
        .toString()
        .trim()
        .replace(/[^a-zA-Z0-9-_]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .toLowerCase();
      const filename = `${base || 'contact'}-gossip-contact.yaml`;

      // Try the Web Share API (files) if available and allowed
      try {
        type ShareData = {
          files?: File[];
          title?: string;
          text?: string;
          url?: string;
        };
        const nav = navigator as Navigator & {
          canShare?: (data?: ShareData) => boolean;
          share?: (data: ShareData) => Promise<void>;
        };

        // Create once and reuse for canShare and share
        const shareFile = new File([blob], filename, {
          type: 'text/yaml;charset=utf-8',
        });

        let canShareFiles = false;
        if (typeof navigator !== 'undefined' && !!nav.canShare) {
          try {
            canShareFiles = nav.canShare({ files: [shareFile] });
          } catch {
            canShareFiles = false;
          }
        }

        if (canShareFiles && nav.share) {
          await nav.share({ files: [shareFile] });
          return;
        }
      } catch {
        // Ignore share errors and fall back to download
      }

      // Fallback: programmatic download via Object URL
      const url = URL.createObjectURL(blob);
      try {
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        a.rel = 'noopener';
        document.body.appendChild(a);
        a.click();
        a.remove();
      } finally {
        URL.revokeObjectURL(url);
      }
    } catch (e) {
      setFileState(prev => ({
        ...prev,
        error:
          e instanceof Error
            ? `Failed to export file: ${e.message}`
            : 'Failed to export file',
      }));
    }
  }, []);

  const importFileContact = useCallback(
    async (file: File): Promise<FileContact | null> => {
      if (
        !file.name.toLowerCase().endsWith('.yaml') &&
        !file.name.toLowerCase().endsWith('.yml')
      ) {
        setFileState(prev => ({
          ...prev,
          error: 'Please select a .yaml or .yml file',
        }));
        return null;
      }

      try {
        setFileState(prev => ({ ...prev, isLoading: true, error: null }));
        const text = await file.text();
        const data = yaml.load(text) as ImportableYaml;

        let bytes: Uint8Array;
        if (typeof data.userPubKeys === 'string') {
          try {
            bytes = decodeFromBase64(data.userPubKeys);
          } catch (e) {
            setFileState(prev => ({
              ...prev,
              error: 'Invalid userPubKeys format. Expected base64 string: ' + e,
            }));
            return null;
          }
        } else if (Array.isArray(data.userPubKeys)) {
          bytes = Uint8Array.from(data.userPubKeys);
        } else {
          setFileState(prev => ({
            ...prev,
            error: 'Invalid userPubKeys format.',
          }));
          return null;
        }

        const contact = { userPubKeys: bytes, userName: data.userName };
        setFileState(prev => ({ ...prev, fileContact: contact }));
        return contact;
      } catch (e) {
        setFileState(prev => ({
          ...prev,
          error: `Failed to import file: ${e instanceof Error ? e.message : 'Unknown error'}`,
        }));
        return null;
      } finally {
        setFileState(prev => ({ ...prev, isLoading: false }));
      }
    },
    []
  );

  return {
    fileState,
    setFileState,
    exportFileContact,
    importFileContact,
  };
}
