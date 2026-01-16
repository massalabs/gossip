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
   * When renewing a discussion (session recovery), the discussion should stay ACTIVE.
   * It should NOT go to PENDING status because:
   * 1. PENDING shows "waiting for approval" to the user
   * 2. Renewal is NOT a new contact request - it's recovering an existing session
   * 3. The user has already established the connection before
   */

  enum DiscussionStatus {
    PENDING = 'pending',
    ACTIVE = 'active',
    BROKEN = 'broken',
    SEND_FAILED = 'send_failed',
  }

  interface RenewResult {
    success: boolean;
    sessionStatus: SessionStatus;
  }

  function getStatusAfterRenewal(result: RenewResult): DiscussionStatus {
    // For renewals, keep discussion ACTIVE unless send actually failed.
    // SelfRequested means we're waiting for peer to respond - that's expected for renewal.
    // PENDING should only be used for FIRST TIME contact requests, not renewals.
    return !result.success
      ? DiscussionStatus.SEND_FAILED
      : DiscussionStatus.ACTIVE;
  }

  it('should keep discussion ACTIVE after successful renewal with SelfRequested', () => {
    const status = getStatusAfterRenewal({
      success: true,
      sessionStatus: SessionStatus.SelfRequested,
    });
    expect(status).toBe(DiscussionStatus.ACTIVE);
  });

  it('should keep discussion ACTIVE after successful renewal with Active', () => {
    const status = getStatusAfterRenewal({
      success: true,
      sessionStatus: SessionStatus.Active,
    });
    expect(status).toBe(DiscussionStatus.ACTIVE);
  });

  it('should set SEND_FAILED if renewal send fails', () => {
    const status = getStatusAfterRenewal({
      success: false,
      sessionStatus: SessionStatus.SelfRequested,
    });
    expect(status).toBe(DiscussionStatus.SEND_FAILED);
  });

  it('should NEVER set PENDING for renewals (no waiting for approval)', () => {
    // Test all possible session statuses after renewal
    const statuses = [
      SessionStatus.Active,
      SessionStatus.SelfRequested,
      SessionStatus.PeerRequested,
      SessionStatus.NoSession,
      SessionStatus.UnknownPeer,
      SessionStatus.Killed,
      SessionStatus.Saturated,
    ];

    for (const sessionStatus of statuses) {
      const result = getStatusAfterRenewal({
        success: true,
        sessionStatus,
      });
      // Result should be ACTIVE, never PENDING
      expect(result).toBe(DiscussionStatus.ACTIVE);
      expect(result).not.toBe(DiscussionStatus.PENDING);
    }
  });
});
