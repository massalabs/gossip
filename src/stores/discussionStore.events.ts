import {
  type Contact,
  type Discussion,
  SdkEventType,
  type SessionStatus,
} from '@massalabs/gossip-sdk';
import type { getSdk } from './sdkStore';

/** State fields touched by discussion list / session event handlers. */
export interface DiscussionStoreEventSlice {
  discussions: Discussion[];
  sessionsStatuses: Map<string, SessionStatus>;
  contacts: Contact[];
  lastMessages: Map<string, { content: string; timestamp: Date }>;
}

type SetFn = (
  partial:
    | Partial<DiscussionStoreEventSlice>
    | ((state: DiscussionStoreEventSlice) => Partial<DiscussionStoreEventSlice>)
) => void;

export function createDiscussionEventHandlers(
  sdk: ReturnType<typeof getSdk>,
  set: SetFn,
  fetchData: () => Promise<void>
) {
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;

  const debouncedFetch = () => {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      void fetchData();
    }, 100);
  };

  const onSessionStatusChanged = ({
    contactUserId,
    status,
  }: {
    contactUserId: string;
    status: SessionStatus;
  }) => {
    set(state => {
      const next = new Map(state.sessionsStatuses);
      next.set(contactUserId, status);
      return { sessionsStatuses: next };
    });
  };

  const onContactDeleted = ({ contactUserId }: { contactUserId: string }) => {
    set(state => {
      const nextContacts = state.contacts.filter(
        c => c.userId !== contactUserId
      );
      const nextDiscussions = state.discussions.filter(
        d => d.contactUserId !== contactUserId
      );
      const nextLastMessages = new Map(state.lastMessages);
      nextLastMessages.delete(contactUserId);

      const nextSessionsStatuses = new Map(state.sessionsStatuses);
      nextSessionsStatuses.delete(contactUserId);
      return {
        contacts: nextContacts,
        discussions: nextDiscussions,
        lastMessages: nextLastMessages,
        sessionsStatuses: nextSessionsStatuses,
      };
    });
  };

  sdk.on(SdkEventType.SESSION_CREATED, debouncedFetch);
  sdk.on(SdkEventType.SESSION_ACCEPTED, debouncedFetch);
  sdk.on(SdkEventType.SESSION_RENEWED, debouncedFetch);
  sdk.on(SdkEventType.SESSION_REQUESTED, debouncedFetch);
  sdk.on(SdkEventType.DISCUSSION_UPDATED, debouncedFetch);
  sdk.on(SdkEventType.CONTACT_DELETED, onContactDeleted);
  sdk.on(SdkEventType.SESSION_STATUS_CHANGED, onSessionStatusChanged);

  return () => {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = null;
    try {
      sdk.off(SdkEventType.SESSION_CREATED, debouncedFetch);
      sdk.off(SdkEventType.SESSION_ACCEPTED, debouncedFetch);
      sdk.off(SdkEventType.SESSION_RENEWED, debouncedFetch);
      sdk.off(SdkEventType.SESSION_REQUESTED, debouncedFetch);
      sdk.off(SdkEventType.DISCUSSION_UPDATED, debouncedFetch);
      sdk.off(SdkEventType.CONTACT_DELETED, onContactDeleted);
      sdk.off(SdkEventType.SESSION_STATUS_CHANGED, onSessionStatusChanged);
    } catch {
      // SDK might not be available during cleanup
    }
  };
}
