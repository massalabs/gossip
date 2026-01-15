import type { TokenState } from '../../../gossip-sdk/src/wallet';
import masIcon from '../../assets/MAS.svg';

export const initialTokens: TokenState[] = [
  {
    address: 'MASSA',
    name: 'Massa',
    ticker: 'MAS',
    icon: masIcon,
    balance: null,
    priceUsd: null,
    valueUsd: null,
    isNative: true,
    decimals: 9,
  },
  // {
  //   address: 'AS12LpYyAjYRJfYhyu7fkrS224gMdvFHVEeVWoeHZzMdhis7UZ3Eb',
  //   name: 'Dai Stablecoin',
  //   ticker: 'DAI',
  //   icon: masIcon, // TODO: Add DAI icon
  //   balance: null,
  //   priceUsd: null,
  //   valueUsd: null,
  //   isNative: false,
  //   decimals: 18,
  // },
  // {
  //   address: 'AS1gt69gqYD92dqPyE6DBRJ7KjpnQHqFzFs2YCkBcSnuxX5bGhBC',
  //   name: 'Wrapped Ether',
  //   ticker: 'WETH',
  //   icon: masIcon, // TODO: Add WETH icon
  //   balance: null,
  //   priceUsd: null,
  //   valueUsd: null,
  //   isNative: false,
  //   decimals: 18,
  // },
  // {
  //   address: 'AS12k8viVmqPtRuXzCm6rKXjLgpQWqbuMjc37YHhB452KSUUb9FgL',
  //   name: 'USD Coin',
  //   ticker: 'USDC',
  //   icon: masIcon, // TODO: Add USDC icon
  //   balance: null,
  //   priceUsd: null,
  //   valueUsd: null,
  //   isNative: false,
  //   decimals: 6,
  // },
  // {
  //   address: 'AS12ix1Qfpue7BB8q6mWVtjNdNE9UV3x4MaUo7WhdUubov8sJ3CuP',
  //   name: 'Tether USD',
  //   ticker: 'USDT',
  //   icon: masIcon, // TODO: Add USDT icon
  //   balance: null,
  //   priceUsd: null,
  //   valueUsd: null,
  //   isNative: false,
  //   decimals: 6,
  // },
  // {
  //   address: 'AS12RmCXTA9NZaTBUBnRJuH66AGNmtEfEoqXKxLdmrTybS6GFJPFs',
  //   name: 'Wrapped Ether (Base)',
  //   ticker: 'WETHbt',
  //   icon: masIcon, // TODO: Add WETHbt icon
  //   balance: null,
  //   priceUsd: null,
  //   valueUsd: null,
  //   isNative: false,
  //   decimals: 18,
  // },
  // {
  //   address: 'AS12FW5Rs5YN2zdpEnqwj4iHUUPt9R4Eqjq2qtpJFNKW3mn33RuLU',
  //   name: 'Wrapped Massa',
  //   ticker: 'WMAS',
  //   icon: masIcon, // TODO: Add WMAS icon
  //   balance: null,
  //   priceUsd: null,
  //   valueUsd: null,
  //   isNative: false,
  //   decimals: 9,
  // },
  // {
  //   address: 'AS1ZXy3nvqXAMm2w6viAg7frte6cZfJM8hoMvWf4KoKDzvLzYKqE',
  //   name: 'Wrapped Bitcoin',
  //   ticker: 'WBTC',
  //   icon: masIcon, // TODO: Add WBTC icon
  //   balance: null,
  //   priceUsd: null,
  //   valueUsd: null,
  //   isNative: false,
  //   decimals: 8,
  // },
];
