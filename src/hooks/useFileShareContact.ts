import { useCallback, useState } from 'react';
import * as yaml from 'js-yaml';

import { decodeFromBase64, encodeToBase64 } from '@massalabs/gossip-sdk';
import { shareFile } from '../services/shareService';

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

function buildContactFile(contact: FileContact) {
  const doc = {
    userPubKeys: encodeToBase64(contact.userPubKeys),
    userName: contact.userName ?? undefined,
  };
  const yamlText = yaml.dump(doc, { noRefs: true });
  const blob = new Blob([yamlText], { type: 'application/octet-stream' });
  const base = (contact.userName || 'contact')
    .toString()
    .trim()
    .replace(/[^a-zA-Z0-9-_]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase();
  const fileName = `${base || 'contact'}-gossip-contact.yaml`;
  return { blob, fileName };
}

export function useFileShareContact() {
  const [fileState, setFileState] = useState<fileState>({
    fileContact: null,
    isLoading: false,
    error: null,
  });

  const shareFileContact = useCallback(async (contact: FileContact) => {
    try {
      setFileState(prev => ({ ...prev, error: null }));
      const { blob, fileName } = buildContactFile(contact);
      await shareFile({
        blob,
        fileName,
        title: 'Gossip Contact',
        mimeType: 'text/yaml;charset=utf-8',
      });
    } catch (e) {
      setFileState(prev => ({
        ...prev,
        error:
          e instanceof Error
            ? `Failed to share file: ${e.message}`
            : 'Failed to share file',
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
    shareFileContact,
    importFileContact,
  };
}
