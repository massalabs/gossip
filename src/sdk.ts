import {
  createGossipSdk,
  type GossipSdkInitOptions,
} from '@massalabs/gossip-sdk';

export async function createSdk(options: GossipSdkInitOptions) {
  const sdk = createGossipSdk();
  await sdk.init(options);
  return sdk;
}
