/**
 * Auto-Accept Tests
 *
 * Tests to ensure auto-accept only triggers for existing contacts (session recovery),
 * NOT for new contact requests.
 */

import { describe, it, expect } from 'vitest';
import { SessionStatus } from '../src/assets/generated/wasm/gossip_wasm';

describe('Auto-Accept Logic', () => {
  /**
   * This simulates the announcement processing logic.
   * Key rules:
   * 1. New contacts (isNewContact=true) should NOT auto-accept
   * 2. Existing contacts (isNewContact=false) with PeerRequested status SHOULD auto-accept
   */

  interface ProcessAnnouncementParams {
    isNewContact: boolean;
    sessionStatus: SessionStatus;
  }

  function shouldAutoAccept(params: ProcessAnnouncementParams): boolean {
    // Auto-accept ONLY for existing contacts (session recovery scenario).
    // For NEW contacts, the user must manually accept the discussion request.
    return (
      params.sessionStatus === SessionStatus.PeerRequested &&
      !params.isNewContact
    );
  }

  describe('New contact requests', () => {
    it('should NOT auto-accept for new contact with PeerRequested status', () => {
      const result = shouldAutoAccept({
        isNewContact: true,
        sessionStatus: SessionStatus.PeerRequested,
      });
      expect(result).toBe(false);
    });

    it('should NOT auto-accept for new contact with any status', () => {
      const statuses = [
        SessionStatus.Active,
        SessionStatus.NoSession,
        SessionStatus.SelfRequested,
        SessionStatus.UnknownPeer,
        SessionStatus.Killed,
        SessionStatus.Saturated,
      ];

      for (const status of statuses) {
        const result = shouldAutoAccept({
          isNewContact: true,
          sessionStatus: status,
        });
        expect(result).toBe(false);
      }
    });
  });

  describe('Existing contact session recovery', () => {
    it('should auto-accept for existing contact with PeerRequested status', () => {
      const result = shouldAutoAccept({
        isNewContact: false,
        sessionStatus: SessionStatus.PeerRequested,
      });
      expect(result).toBe(true);
    });

    it('should NOT auto-accept for existing contact with non-PeerRequested status', () => {
      const statuses = [
        SessionStatus.Active,
        SessionStatus.NoSession,
        SessionStatus.SelfRequested,
        SessionStatus.UnknownPeer,
        SessionStatus.Killed,
        SessionStatus.Saturated,
      ];

      for (const status of statuses) {
        const result = shouldAutoAccept({
          isNewContact: false,
          sessionStatus: status,
        });
        expect(result).toBe(false);
      }
    });
  });
});

describe('Discussion Status After Renewal', () => {
  /**
   * Discussion status after renew() depends on:
   * 1. Whether the send succeeded
   * 2. The session status (Active vs SelfRequested)
   * 3. The previous discussion status (was it ACTIVE before?)
   *
   * - SEND_FAILED: announcement couldn't be sent
   * - ACTIVE: session fully established (peer responded)
   * - RECONNECTING: true renewal (was ACTIVE), waiting for peer
   * - PENDING: first contact retry (was not ACTIVE), waiting for peer
   */

  enum DiscussionStatus {
    PENDING = 'pending',
    ACTIVE = 'active',
    BROKEN = 'broken',
    SEND_FAILED = 'send_failed',
    RECONNECTING = 'reconnecting',
  }

  interface RenewResult {
    success: boolean;
    sessionStatus: SessionStatus;
    previousDiscussionStatus: DiscussionStatus;
  }

  function getStatusAfterRenewal(result: RenewResult): DiscussionStatus {
    if (!result.success) {
      return DiscussionStatus.SEND_FAILED;
    } else if (result.sessionStatus === SessionStatus.Active) {
      // Session fully established (peer already responded)
      return DiscussionStatus.ACTIVE;
    } else if (result.previousDiscussionStatus === DiscussionStatus.ACTIVE) {
      // True renewal: had working session before, now recovering
      return DiscussionStatus.RECONNECTING;
    } else {
      // First contact retry: never had working session
      return DiscussionStatus.PENDING;
    }
  }

  describe('True renewal (previously ACTIVE discussion)', () => {
    it('should set RECONNECTING when session is SelfRequested', () => {
      const status = getStatusAfterRenewal({
        success: true,
        sessionStatus: SessionStatus.SelfRequested,
        previousDiscussionStatus: DiscussionStatus.ACTIVE,
      });
      expect(status).toBe(DiscussionStatus.RECONNECTING);
    });

    it('should set ACTIVE when session is already Active', () => {
      const status = getStatusAfterRenewal({
        success: true,
        sessionStatus: SessionStatus.Active,
        previousDiscussionStatus: DiscussionStatus.ACTIVE,
      });
      expect(status).toBe(DiscussionStatus.ACTIVE);
    });

    it('should set SEND_FAILED if send fails', () => {
      const status = getStatusAfterRenewal({
        success: false,
        sessionStatus: SessionStatus.SelfRequested,
        previousDiscussionStatus: DiscussionStatus.ACTIVE,
      });
      expect(status).toBe(DiscussionStatus.SEND_FAILED);
    });
  });

  describe('First contact retry (previously PENDING/SEND_FAILED discussion)', () => {
    it('should set PENDING when session is SelfRequested (from PENDING)', () => {
      const status = getStatusAfterRenewal({
        success: true,
        sessionStatus: SessionStatus.SelfRequested,
        previousDiscussionStatus: DiscussionStatus.PENDING,
      });
      expect(status).toBe(DiscussionStatus.PENDING);
    });

    it('should set PENDING when session is SelfRequested (from SEND_FAILED)', () => {
      const status = getStatusAfterRenewal({
        success: true,
        sessionStatus: SessionStatus.SelfRequested,
        previousDiscussionStatus: DiscussionStatus.SEND_FAILED,
      });
      expect(status).toBe(DiscussionStatus.PENDING);
    });

    it('should set ACTIVE when session is already Active (peer responded)', () => {
      const status = getStatusAfterRenewal({
        success: true,
        sessionStatus: SessionStatus.Active,
        previousDiscussionStatus: DiscussionStatus.PENDING,
      });
      expect(status).toBe(DiscussionStatus.ACTIVE);
    });

    it('should set SEND_FAILED if send fails', () => {
      const status = getStatusAfterRenewal({
        success: false,
        sessionStatus: SessionStatus.SelfRequested,
        previousDiscussionStatus: DiscussionStatus.PENDING,
      });
      expect(status).toBe(DiscussionStatus.SEND_FAILED);
    });
  });

  describe('Edge case: renewal from BROKEN status', () => {
    it('should set PENDING when renewing from BROKEN (no previous active session)', () => {
      const status = getStatusAfterRenewal({
        success: true,
        sessionStatus: SessionStatus.SelfRequested,
        previousDiscussionStatus: DiscussionStatus.BROKEN,
      });
      expect(status).toBe(DiscussionStatus.PENDING);
    });
  });
});
