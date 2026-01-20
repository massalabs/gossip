/**
 * MNS (Massa Name System) Service
 *
 * Handles resolving .massa domain names to gossip user IDs.
 * Uses @massalabs/massa-web3 MNS wrapper to interact with the Massa blockchain.
 */

import { MNS } from '@massalabs/massa-web3';
import { useAccountStore } from '../stores/accountStore';
import { isValidUserId } from 'gossip-sdk';

const MNS_SUFFIX = '.massa';

/**
 * Check if a string looks like an MNS domain (ends with .massa)
 */
export function isMnsDomain(value: string): boolean {
  const trimmed = value.trim().toLowerCase();
  return trimmed.endsWith(MNS_SUFFIX) && trimmed.length > MNS_SUFFIX.length;
}

/**
 * Extract the domain name without the .massa suffix
 */
export function extractMnsDomainName(domain: string): string {
  const trimmed = domain.trim().toLowerCase();
  if (trimmed.endsWith(MNS_SUFFIX)) {
    return trimmed.slice(0, -MNS_SUFFIX.length);
  }
  return trimmed;
}

export type MnsResolutionResult =
  | { success: true; gossipId: string }
  | { success: false; error: string };

/**
 * MNS Service class for resolving .massa domains
 */
class MnsService {
  private cachedMns: MNS | null = null;

  /**
   * Get or create an MNS instance using the provider from AccountStore.
   * Caches the instance to avoid recreating it on every call.
   */
  private async getMnsInstance(): Promise<MNS> {
    const provider = useAccountStore.getState().provider;

    if (!provider) {
      throw new Error('No provider available. Please log in first.');
    }

    // Return cached instance if provider hasn't changed
    if (this.cachedMns && this.cachedMns.provider === provider) {
      return this.cachedMns;
    }

    // Create new instance and cache it
    this.cachedMns = await MNS.init(provider);

    return this.cachedMns;
  }

  /**
   * Resolve an MNS domain to a gossip user ID
   *
   * The MNS target should contain a valid gossip1... user ID.
   * If the target is a Massa address (AS...), this will return an error
   * since we need the gossip ID, not the Massa address.
   *
   * @param domain - The MNS domain (e.g., "alice.massa" or "alice")
   * @returns The resolved gossip user ID or an error
   */
  async resolveToGossipId(domain: string): Promise<MnsResolutionResult> {
    try {
      const mns = await this.getMnsInstance();

      // Extract domain name without .massa suffix
      const domainName = extractMnsDomainName(domain);

      if (!domainName || domainName.length === 0) {
        return {
          success: false,
          error: 'Invalid MNS domain name',
        };
      }

      // Resolve the domain to its target
      const target = await mns.resolve(domainName);

      if (!target || target.length === 0) {
        return {
          success: false,
          error: 'MNS domain not found or has no target',
        };
      }

      // Check if the target is a valid gossip user ID
      if (isValidUserId(target)) {
        return {
          success: true,
          gossipId: target,
        };
      }

      // Target exists but is not a gossip ID (likely a Massa address)
      return {
        success: false,
        error: 'MNS domain is not linked to a Gossip ID',
      };
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Unknown error occurred';

      // Handle common MNS errors
      if (
        message.includes('not found') ||
        message.includes('domain does not exist')
      ) {
        return {
          success: false,
          error: 'MNS domain not found',
        };
      }

      if (message.includes('network') || message.includes('fetch')) {
        return {
          success: false,
          error: 'Network error while resolving MNS domain',
        };
      }

      return {
        success: false,
        error: `Failed to resolve MNS domain: ${message}`,
      };
    }
  }

  /**
   * Reverse resolve a gossip ID to get MNS domains pointing to it
   *
   * @param gossipId - The gossip user ID (e.g., "gossip1...")
   * @returns Array of MNS domain names (without .massa suffix), or empty array if none found
   */
  async getDomainsFromGossipId(gossipId: string): Promise<string[]> {
    try {
      const mns = await this.getMnsInstance();
      const domains = await mns.getDomainsFromTarget(gossipId);
      // Filter out empty strings and return valid domains
      return (domains || []).filter(
        domain => domain && domain.trim().length > 0
      );
    } catch (_error) {
      // If gossip ID has no domains, getDomainsFromTarget might throw or return empty
      // Return empty array to indicate no domains found
      return [];
    }
  }
}

// Export singleton instance
export const mnsService = new MnsService();
