// Frozen public test vector for the released account-security V1 meanings.
// These values are intentionally known and must never be replaced with live user data.
export const PROFILE_SECURITY_V1_FIXTURE = {
  password: 'profile-v1-vector',
  mnemonic:
    'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about',
  encryptionKeySaltHex: '000102030405060708090a0b0c0d0e0f',
  encryptedMnemonicHex:
    '6bd6920371fc73ace03e2229db2d67fe10d1127f908531eaca47cbf10a3bbf1f' +
    'fd954b07467b00dba1a684515fa12c5d8b88949bd6ee76d3737f3b4c7419dab5' +
    '83edc49b3e1903444473b3fb20d2f59102830b6f920bccc1a437543b96424e1b7' +
    '093d0d0b07fd6495fcbc35e5c',
  userId: 'gossip1ywzkutgadznd0509tsl4gs4xjvsudhzgjuxc46ytngvq0lacx5es2xyz5s',
  evmAddress: '0xd30d988A4F82A21C03aD5497E6b950beB5408538',
  massaAddress: 'AU1XfQoXydwZEcS2UF32PSjL8BwyHWruvDNZYCA5mhCnfZ5Daiyo',
} as const;
