import { useCallback } from 'react';
import { formatUserId } from '@massalabs/gossip-sdk';
import { useTranslation } from 'react-i18next';
import { useDiscussionStore } from '../stores/discussionStore';
import { useAccountStore } from '../stores/accountStore';
import { safeName } from '../utils/groupName';

/**
 * The name shown for a group member: "You", the contact's name (made safe,
 * §5.11), or the shortened user ID of a member who is not a contact.
 */
export function useGroupMemberName(): (userId: string) => string {
  const { t } = useTranslation('groups');
  const contacts = useDiscussionStore(s => s.contacts);
  const me = useAccountStore(s => s.userProfile?.userId);
  return useCallback(
    (userId: string) => {
      if (userId === me) return t('list.you');
      const contact = contacts.find(c => c.userId === userId);
      return safeName(contact?.name) || formatUserId(userId);
    },
    [contacts, me, t]
  );
}
