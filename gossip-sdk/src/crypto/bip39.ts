/**
 * BIP39 utilities for mnemonic generation, validation, and seed derivation
 * Using @scure/bip39 for browser compatibility
 */

import {
  generateMnemonic as generateMnemonicScure,
  mnemonicToSeedSync,
  validateMnemonic as validateMnemonicScure,
} from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english.js';
import { Account, PrivateKey } from '@massalabs/massa-web3';
import varint from 'varint';

export const PRIVATE_KEY_VERSION = 0;

/**
 * Generate a new BIP39 mnemonic phrase
 * @param strength - Entropy strength in bits (128, 160, 192, 224, 256)
 * @returns Generated mnemonic phrase
 */
export function generateMnemonic(strength = 256): string {
  // @scure/bip39 generateMnemonic expects strength in bits (128, 160, 192, 224, 256)
  return generateMnemonicScure(wordlist, strength);
}

/**
 * Validate a BIP39 mnemonic phrase
 * @param mnemonic - The mnemonic phrase to validate
 * @returns True if valid, false otherwise
 */
export function validateMnemonic(mnemonic: string): boolean {
  return validateMnemonicScure(mnemonic, wordlist);
}

/**
 * Generate a seed from mnemonic and optional passphrase
 * @param mnemonic - The BIP39 mnemonic phrase
 * @param passphrase - Optional passphrase (empty string if not provided)
 * @returns Uint8Array seed
 */
export function mnemonicToSeed(
  mnemonic: string,
  passphrase: string = ''
): Uint8Array {
  return mnemonicToSeedSync(mnemonic, passphrase);
}

/**
 * Create a Massa blockchain account from a mnemonic phrase
 *
 * @param mnemonic - The BIP39 mnemonic phrase
 * @param passphrase - Optional passphrase for additional security
 * @returns Massa Account object
 * @throws Error if mnemonic is invalid
 */
export async function accountFromMnemonic(
  mnemonic: string,
  passphrase?: string
): Promise<Account> {
  try {
    if (!validateMnemonic(mnemonic)) {
      throw new Error('Invalid mnemonic phrase');
    }

    const seed = mnemonicToSeed(mnemonic, passphrase);

    const versionArray = varint.encode(PRIVATE_KEY_VERSION);

    const privateKeyBytes = seed.slice(0, 32);
    const privateKey = new Uint8Array([...versionArray, ...privateKeyBytes]);

    const pkey = PrivateKey.fromBytes(privateKey);
    const account = await Account.fromPrivateKey(pkey);
    return account;
  } catch (error) {
    console.error('Error in accountFromMnemonic:', error);
    console.error(
      'Error stack:',
      error instanceof Error ? error.stack : 'No stack'
    );
    throw error;
  }
}
