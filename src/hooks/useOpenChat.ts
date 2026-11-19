import { useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import toast from 'react-hot-toast';
import { useTranslation } from 'react-i18next';
import { SELF_CONTACT_ID } from '@massalabs/gossip-sdk';
import { useGossipSdk } from './useGossipSdk';
import { useGroupStore } from '../stores/groupStore';
import { ROUTES } from '../constants/routes';
import { logger } from '../utils/logger.ts';

/**
 * Opens the conversation with a contact (§5.12): its direct chat when one is
 * held; its archive, contact request or pending request when there is no
 * chat yet; otherwise a direct chat is founded (`migrate_from = 0`).
 * Resolves to where it went, or null.
 */
export function useOpenChat(): (
  contactUserId: string,
  navigateOptions?: { state?: unknown; replace?: boolean }
) => Promise<string | null> {
  const gossip = useGossipSdk();
  const navigate = useNavigate();
  const refresh = useGroupStore(s => s.refresh);
  const { t } = useTranslation('groups');

  return useCallback(
    async (contactUserId, navigateOptions) => {
      if (contactUserId === SELF_CONTACT_ID) {
        const to = ROUTES.selfDiscussion();
        navigate(to, navigateOptions);
        return to;
      }
      try {
        const held = await gossip.conversations.directChatWith(contactUserId);
        if (held) {
          const to = ROUTES.group({ groupId: held });
          navigate(to, navigateOptions);
          return to;
        }
        const d = await gossip.discussions.get(contactUserId);
        if (d && (d.isArchive || !d.weAccepted || d.directChatOwed)) {
          const to = ROUTES.discussion({ userId: contactUserId });
          navigate(to, navigateOptions);
          return to;
        }
        const groupId =
          await gossip.conversations.startDirectChat(contactUserId);
        await refresh();
        const to = ROUTES.group({ groupId });
        navigate(to, navigateOptions);
        return to;
      } catch (error) {
        logger.error('Chat not opened', error);
        toast.error(t('archive.migrate_failed'));
        return null;
      }
    },
    [gossip, navigate, refresh, t]
  );
}
