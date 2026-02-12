export type Ticker = string;

export interface TokenMeta {
  address: string;
  name: string;
  ticker: Ticker;
  icon: string;
  decimals: number;
  isNative: boolean;
}

export interface TokenState extends TokenMeta {
  balance: bigint | null;
  priceUsd: number | null;
  valueUsd: number | null;
}

export interface FeeConfig {
  type: 'preset' | 'custom';
  preset?: 'low' | 'standard' | 'high';
  customFee?: string;
}
