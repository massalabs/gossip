/**
 * WebAuthn/FIDO2 utilities for biometric authentication and key generation
 */

import {
  BiometricCreationData,
  BiometricCredentials,
} from '../services/biometricService';
import {
  generateEncryptionKeyFromSeed,
  decodeFromBase64Url,
  encodeToBase64,
  encodeToBase64Url,
} from '@massalabs/gossip-sdk';

export const WEBAUTHN_PRF_UNSUPPORTED_ERROR_CODE = 'webauthn_prf_unsupported';
/**
 * Check if WebAuthn is supported in the current browser
 */
export function isWebAuthnSupported(): boolean {
  const supported =
    typeof window !== 'undefined' &&
    typeof window.navigator !== 'undefined' &&
    typeof window.navigator.credentials !== 'undefined' &&
    typeof window.navigator.credentials.create !== 'undefined' &&
    typeof window.navigator.credentials.get !== 'undefined' &&
    typeof (window as unknown as { PublicKeyCredential?: unknown })
      .PublicKeyCredential !== 'undefined';

  return supported;
}

/**
 * Check if platform authenticator (biometric) is available
 */
export async function isPlatformAuthenticatorAvailable(): Promise<boolean> {
  if (!isWebAuthnSupported()) {
    return false;
  }

  try {
    const pkc = window.PublicKeyCredential as {
      isUserVerifyingPlatformAuthenticatorAvailable?: () => Promise<boolean>;
    };
    if (
      !pkc ||
      typeof pkc.isUserVerifyingPlatformAuthenticatorAvailable !== 'function'
    ) {
      return false;
    }
    const available = await pkc.isUserVerifyingPlatformAuthenticatorAvailable();
    return available;
  } catch (error) {
    console.error('Error checking platform authenticator availability:', error);
    return false;
  }
}

/**
 * Check if client supports WebAuthn PRF extension.
 * This is required for deterministic encryption-key derivation.
 */
export async function isWebAuthnPrfSupported(): Promise<boolean> {
  if (!isWebAuthnSupported()) {
    return false;
  }

  try {
    const pkc = window.PublicKeyCredential as unknown as {
      getClientCapabilities?: (
        credentialType?: string
      ) => Promise<unknown> | unknown;
    };

    if (!pkc || typeof pkc.getClientCapabilities !== 'function') {
      return false;
    }

    // Browser implementations differ: some expose top-level `prf`,
    // others expose an `extensions` list/object.
    const capabilities = (await pkc.getClientCapabilities(
      'public-key'
    )) as Record<string, unknown>;

    const topLevelPrf = capabilities?.prf;
    if (typeof topLevelPrf === 'boolean') {
      return topLevelPrf;
    }

    const extensions = capabilities?.extensions;
    if (Array.isArray(extensions)) {
      return extensions.includes('prf');
    }
    if (extensions && typeof extensions === 'object') {
      return Boolean((extensions as Record<string, unknown>).prf);
    }

    // Safari may not currently expose extension-level PRF capabilities in
    // getClientCapabilities(), even when platform passkeys are available.
    // In this case we treat PRF as "unknown" and allow the flow; runtime
    // create/get checks still enforce PRF support before key derivation.
    if (capabilities?.passkeyPlatformAuthenticator === true) {
      console.info(
        '[biometric][preflight] PRF capability unknown; allowing via platform passkey fallback'
      );
      return true;
    }

    console.info(
      '[biometric][preflight] PRF capability not advertised by browser API'
    );
    return false;
  } catch (error) {
    console.warn('[biometric][preflight] PRF capability check failed', error);
    return false;
  }
}

/**
 * Generate a new WebAuthn credential for account creation
 * @param username - Display name for the user
 * @param userId - Binary user ID (must be <= 64 bytes, typically 32 bytes)
 */
export async function createWebAuthnCredential(
  username: string,
  userId: Uint8Array,
  salt: Uint8Array
): Promise<BiometricCreationData> {
  if (!isWebAuthnSupported()) {
    throw new Error('WebAuthn is not supported in this browser');
  }

  const isPlatformAvailable = await isPlatformAuthenticatorAvailable();
  if (!isPlatformAvailable) {
    throw new Error('Platform authenticator (biometric) is not available');
  }

  // Generate a random challenge
  const challenge = crypto.getRandomValues(new Uint8Array(32));

  // Create credential creation options
  const rpId = window.location.hostname;
  const createOptions: CredentialCreationOptions = {
    publicKey: {
      challenge,
      rp: {
        name: 'Gossip',
        id: rpId,
      },
      user: {
        id: userId as BufferSource,
        name: username,
        displayName: username,
      },
      pubKeyCredParams: [
        { type: 'public-key', alg: -7 }, // ES256 (ECDSA P-256)
        { type: 'public-key', alg: -257 }, // RS256 (RSASSA-PKCS1-v1_5 with SHA-256)
      ],
      authenticatorSelection: {
        authenticatorAttachment: 'platform', // Force platform authenticator (biometric)
        userVerification: 'required',
        residentKey: 'preferred',
      },
      timeout: 60000, // 60 seconds
      attestation: 'none', // We don't need attestation for our use case
      extensions: {
        prf: {
          eval: {
            first: salt as BufferSource,
          },
        },
      },
    },
  };

  try {
    const credential = (await navigator.credentials.create(
      createOptions
    )) as PublicKeyCredential;

    if (!credential) {
      throw new Error('Failed to create WebAuthn credential');
    }

    // Extract PRF output from client extension results
    const clientExt = credential.getClientExtensionResults?.() ?? {};
    if (!clientExt.prf || !clientExt.prf.enabled) {
      throw new Error(WEBAUTHN_PRF_UNSUPPORTED_ERROR_CODE);
    }
    const prfOutput: ArrayBuffer | undefined = clientExt.prf.results
      ?.first as ArrayBuffer;

    if (!prfOutput) {
      throw new Error(WEBAUTHN_PRF_UNSUPPORTED_ERROR_CODE);
    }

    const seed = encodeToBase64(new Uint8Array(prfOutput));
    const encryptionKey = await generateEncryptionKeyFromSeed(seed, salt);
    const credentialId = encodeToBase64Url(new Uint8Array(credential.rawId));

    return {
      credentialId,
      encryptionKey,
      authMethod: 'webauthn',
    };
  } catch (error) {
    console.error('Error creating WebAuthn credential:', error);
    throw new Error(
      `Failed to create biometric credential: ${error instanceof Error ? error.message : 'Unknown error'}`
    );
  }
}

/**
 * Authenticate using existing WebAuthn credential
 * @param credentialId - The credential ID to authenticate with
 * @param salt - The same salt used during credential creation (for PRF extension)
 * @param challenge - Optional challenge (random if not provided)
 */
export async function authenticateWithWebAuthn(
  credentialId: string,
  salt: Uint8Array
): Promise<BiometricCredentials> {
  if (!isWebAuthnSupported()) {
    throw new Error('WebAuthn is not supported in this browser');
  }

  const actualChallenge = crypto.getRandomValues(new Uint8Array(32));
  const rpId = window.location.hostname;

  // Convert credentialId from base64url string back to ArrayBuffer (if provided)
  let allowCredentials: PublicKeyCredentialDescriptor[] | undefined = undefined;
  if (credentialId) {
    try {
      allowCredentials = [
        {
          id: decodeFromBase64Url(credentialId) as BufferSource,
          type: 'public-key' as const,
        },
      ];
    } catch {
      throw new Error('Stored WebAuthn credential ID is invalid');
    }
  }

  const getOptions: CredentialRequestOptions = {
    publicKey: {
      challenge: actualChallenge as BufferSource,
      allowCredentials,
      userVerification: 'required',
      timeout: 60000,
      // Add rpId to match the one used during creation
      rpId,
      extensions: {
        prf: {
          eval: {
            first: salt as BufferSource,
          },
        },
      },
    },
  };

  try {
    const credential = (await navigator.credentials.get(
      getOptions
    )) as PublicKeyCredential;

    if (!credential) {
      throw new Error('Authentication failed - no credential returned');
    }

    // Extract PRF output from client extension results
    const clientExt = credential.getClientExtensionResults?.() ?? {};
    if (!clientExt.prf) {
      throw new Error(WEBAUTHN_PRF_UNSUPPORTED_ERROR_CODE);
    }
    const prfOutput: ArrayBuffer | undefined = clientExt.prf.results
      ?.first as ArrayBuffer;

    if (!prfOutput) {
      throw new Error(WEBAUTHN_PRF_UNSUPPORTED_ERROR_CODE);
    }

    const seed = encodeToBase64(new Uint8Array(prfOutput));
    const encryptionKey = await generateEncryptionKeyFromSeed(seed, salt);

    return {
      encryptionKey,
    };
  } catch (error) {
    console.error('Error authenticating with WebAuthn:', error);
    throw new Error(
      `Biometric authentication failed: ${error instanceof Error ? error.message : 'Unknown error'}`
    );
  }
}
