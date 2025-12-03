import React from 'react';
import { Check } from 'react-feather';
import Select from '../ui/Select';
import { TokenState } from '../../stores/walletStore';
import { formatAmount } from '../../utils/parseAmount';

interface TokenSelectProps {
  tokens: TokenState[];
  selectedToken: TokenState | null;
  onSelect: (token: TokenState) => void;
  className?: string;
}

const TokenSelect: React.FC<TokenSelectProps> = ({
  tokens,
  selectedToken,
  onSelect,
  className = '',
}) => {
  const renderSelectedToken = (token: TokenState) => (
    <>
      <img
        src={token.icon}
        alt={token.name}
        className="w-8 h-8 rounded-full mr-3"
        loading="lazy"
      />
      <div className="flex-1 text-left">
        <div className="font-medium text-gray-900 dark:text-white">
          {token.name}
        </div>
        <div className="text-sm text-gray-500 dark:text-gray-400">
          {formatAmount(token.balance ?? 0n, token.decimals).preview}{' '}
          {token.ticker}
        </div>
      </div>
    </>
  );

  const renderTokenItem = (token: TokenState) => (
    <>
      <img
        src={token.icon}
        alt={token.name}
        className="w-8 h-8 rounded-full mr-3"
        loading="lazy"
      />
      <div className="flex-1 text-left">
        <div className="font-medium text-gray-900 dark:text-white">
          {token.name}
        </div>
        <div className="text-sm text-gray-500 dark:text-gray-400">
          {formatAmount(token.balance ?? 0n, token.decimals).preview}{' '}
          {token.ticker}
        </div>
      </div>
      {selectedToken && selectedToken.address === token.address && (
        <div className="w-5 h-5 bg-blue-500 rounded-full flex items-center justify-center">
          <Check className="w-3 h-3 text-white" />
        </div>
      )}
    </>
  );

  return (
    <Select
      items={tokens}
      selectedItem={selectedToken}
      onSelect={onSelect}
      placeholder="Select a token"
      searchPlaceholder="Search tokens..."
      itemHeight={72}
      searchFields={['name', 'ticker', 'address']}
      renderSelected={renderSelectedToken}
      renderItem={renderTokenItem}
      getItemId={token => token.address}
      className={className}
    />
  );
};

export default TokenSelect;
