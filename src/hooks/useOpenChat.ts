import { useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import toast from 'react-hot-toast';
import { useTranslation } from 'react-i18next';
import { SELF_CONTACT_ID } from '@massalabs/gossip-sdk';
import { useGossipSdk } from './useGossipSdk';
import { ROUTES } from '../constants/routes';
import { logger } from '../utils/logger.ts';

/**
 * Opens the conversation with a contact (§5.12): its direct chat when one is
 * held; otherwise the contact's screen (its archive, request, pending
 * request, or "Start a chat"). Opening a contact never starts a chat by
 * itself and sends nothing: a chat is started only by the explicit action
 * on that screen. Resolves to where it went, or null.
 */
export function useOpenChat(): (
  contactUserId: string,
  navigateOptions?: { state?: unknown; replace?: boolean }
) => Promise<string | null> {
  const gossip = useGossipSdk();
  const navigate = useNavigate();
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
        const to = held
          ? ROUTES.group({ groupId: held })
          : ROUTES.discussion({ userId: contactUserId });
        navigate(to, navigateOptions);
        return to;
      } catch (error) {
        logger.error('Chat not opened', error);
        toast.error(t('start_chat.open_failed'));
        return null;
      }
    },
    [gossip, navigate, t]
  );
}
