import { GossipSdk, type GossipSdkInitOptions } from '@massalabs/gossip-sdk';

export async function createSdk(options: GossipSdkInitOptions) {
  const sdk = new GossipSdk();
  await sdk.init(options);
  return sdk;
}
