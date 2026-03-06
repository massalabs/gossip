import type { UserProfile } from '../../src/db/db';
import { userProfileToRow, type UserProfileInsert } from '../../src/db/queries';

const defaultUserProfile: UserProfile = {
  userId: 'gossip1gcqd2ssurzah4w2uxag2mlhpgpppv8aghl9vsu9x4ru9u5pg7ssq6g7jn2',
  username: 'testuser',
  security: {
    encKeySalt: new Uint8Array(32).fill(1),
    authMethod: 'password',
    mnemonicBackup: {
      encryptedMnemonic: new Uint8Array(64).fill(2),
      createdAt: new Date('2025-01-01'),
      backedUp: false,
    },
  },
  session: new Uint8Array(32).fill(3),
  status: 'online',
  lastSeen: new Date('2025-01-01'),
  createdAt: new Date('2025-01-01'),
  updatedAt: new Date('2025-01-01'),
};

export function makeUserProfile(
  overrides: Partial<UserProfile> = {}
): UserProfile {
  return {
    ...defaultUserProfile,
    security: {
      ...defaultUserProfile.security,
      mnemonicBackup: { ...defaultUserProfile.security.mnemonicBackup },
    },
    ...overrides,
  };
}

export function makeUserProfileRow(
  overrides: Partial<UserProfile> = {}
): UserProfileInsert {
  return userProfileToRow(makeUserProfile(overrides));
}
