/**
 * User Profile Factory
 *
 * Creates test UserProfile instances using Dexie schema validation.
 * This ensures mocks stay in sync with the actual database schema.
 */
import { UserProfile, AuthMethod } from '../../../src/db';
import { encodeUserId } from '../../../src/utils';

/**
 * Default values for creating test user profiles
 */
const defaultUserProfile: UserProfile = {
  userId: 'gossip1gcqd2ssurzah4w2uxag2mlhpgpppv8aghl9vsu9x4ru9u5pg7ssq6g7jn2',
  username: 'Test User',
  security: {
    encKeySalt: new Uint8Array(32).fill(1),
    authMethod: 'password',
    mnemonicBackup: {
      encryptedMnemonic: new Uint8Array(64).fill(2),
      createdAt: new Date(),
      backedUp: true,
    },
  },
  session: new Uint8Array(32).fill(3),
  status: 'online',
  lastSeen: new Date(),
  createdAt: new Date(),
  updatedAt: new Date(),
};

/**
 * UserProfile Builder
 * Provides a fluent interface for creating test user profiles
 *
 * @example
 * const user = userProfile()
 *   .userId('AU12alice123456789')
 *   .username('Alice')
 *   .status('online')
 *   .build();
 */
class UserProfileBuilder {
  private profile: UserProfile;

  constructor() {
    this.profile = { ...defaultUserProfile };
  }

  userId(value: string): this {
    this.profile.userId = value;
    return this;
  }

  username(value: string): this {
    this.profile.username = value;
    return this;
  }

  avatar(value: string): this {
    this.profile.avatar = value;
    return this;
  }

  bio(value: string): this {
    this.profile.bio = value;
    return this;
  }

  status(value: UserProfile['status']): this {
    this.profile.status = value;
    return this;
  }

  session(value: Uint8Array): this {
    this.profile.session = value;
    return this;
  }

  authMethod(value: AuthMethod): this {
    this.profile.security.authMethod = value;
    return this;
  }

  encKeySalt(value: Uint8Array): this {
    this.profile.security.encKeySalt = value;
    return this;
  }

  webauthn(credentialId: string): this {
    this.profile.security.webauthn = { credentialId };
    return this;
  }

  iCloudSync(value: boolean): this {
    this.profile.security.iCloudSync = value;
    return this;
  }

  mnemonicBackup(options: {
    encryptedMnemonic?: Uint8Array;
    createdAt?: Date;
    backedUp?: boolean;
  }): this {
    this.profile.security.mnemonicBackup = {
      ...this.profile.security.mnemonicBackup,
      ...options,
    };
    return this;
  }

  security(value: Partial<UserProfile['security']>): this {
    this.profile.security = {
      ...this.profile.security,
      ...value,
      mnemonicBackup: {
        ...this.profile.security.mnemonicBackup,
        ...(value.mnemonicBackup || {}),
      },
    };
    return this;
  }

  lastSeen(value: Date): this {
    this.profile.lastSeen = value;
    return this;
  }

  createdAt(value: Date): this {
    this.profile.createdAt = value;
    return this;
  }

  updatedAt(value: Date): this {
    this.profile.updatedAt = value;
    return this;
  }

  lastPublicKeyPush(value: Date): this {
    this.profile.lastPublicKeyPush = value;
    return this;
  }

  build(): UserProfile {
    return { ...this.profile };
  }
}

/**
 * Create a UserProfile builder
 */
export const userProfile = (): UserProfileBuilder => new UserProfileBuilder();

/**
 * Pre-configured test users for common scenarios
 */
export const testUsers = {
  alice: (): UserProfile =>
    userProfile()
      .userId(
        'gossip1yk45a3klcq2f0t0qgpcwg5v7xtvkxfwz4pncn0xcalkf9dsz60lqdfzpeh'
      )
      .username('Alice')
      .status('online')
      .bio('Test user Alice')
      .build(),

  bob: (): UserProfile =>
    userProfile()
      .userId(
        'gossip1uw8msn2f5v28peqc2zuam90am0xhs7fak2j6whjckfx54ynn36gs8ugayy'
      )
      .username('Bob')
      .authMethod('webauthn')
      .webauthn('mock-credential-id')
      .encKeySalt(new Uint8Array(32).fill(4))
      .mnemonicBackup({
        encryptedMnemonic: new Uint8Array(64).fill(5),
        createdAt: new Date(Date.now() - 172800000),
        backedUp: false,
      })
      .status('away')
      .build(),

  charlie: (): UserProfile =>
    userProfile()
      .userId(
        'gossip1wackhrryxewr3x9246ke0esj29wfu9tdqxkx90rkgq73xuaarcuqczx2y3'
      )
      .username('Charlie')
      .authMethod('capacitor')
      .iCloudSync(true)
      .encKeySalt(new Uint8Array(32).fill(7))
      .mnemonicBackup({
        encryptedMnemonic: new Uint8Array(64).fill(8),
        createdAt: new Date(Date.now() - 259200000),
        backedUp: true,
      })
      .status('offline')
      .bio('Test user Charlie')
      .build(),
};

// Helper to generate valid test user IDs (gossip1... format)
const createTestUserId = (seed: number): string => {
  const bytes = new Uint8Array(32);
  // Fill with seed value to create deterministic test IDs
  bytes.fill(seed % 256);

  return encodeUserId(bytes);
};

/**
 * Create multiple test users at once
 */
export const createTestUsers = (count: number): UserProfile[] => {
  return Array.from({ length: count }, (_, i) =>
    userProfile()
      .userId(createTestUserId(i))
      .username(`Test User ${i + 1}`)
      .build()
  );
};
