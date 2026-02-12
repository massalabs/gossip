import { GossipSdk } from '@massalabs/gossip-sdk';
import { useSdkStore } from '../stores/sdkStore';

export function useGossipSdk(): GossipSdk {
  const sdk = useSdkStore.use.sdk();
  if (!sdk) throw new Error('useGossipSdk must be used within SdkProvider');
  return sdk;
}
