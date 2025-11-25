import React, { useCallback, useState } from 'react';
import { useAccountStore } from '../stores/accountStore';
import { useWalletStore } from '../stores/walletStore';
import SendModal from '../components/wallet/SendModal';
import ReceiveModal from '../components/wallet/ReceiveModal';
import sendIcon from '../assets/icons/send.svg';
import receiveIcon from '../assets/icons/receive.svg';
import swapIcon from '../assets/icons/swap.svg';
import { formatMassaAddress } from '../utils/addressUtils';
import { formatAmount } from '../utils/parseAmount';
import Button from '../components/ui/Button';
import CopyClipboard from '../components/ui/CopyClipboard';
// no-op

const Wallet: React.FC = () => {
  const { account } = useAccountStore();
  const tokens = useWalletStore.use.tokens();
  const isLoading = useWalletStore.use.isLoading();
  const refreshBalances = useWalletStore.use.refreshBalances();
  const totalValueUsd = tokens.reduce((sum, t) => sum + (t.valueUsd ?? 0), 0);

  const [isRefreshing, setIsRefreshing] = useState(false);
  const [isSendModalOpen, setIsSendModalOpen] = useState(false);
  const [isReceiveModalOpen, setIsReceiveModalOpen] = useState(false);

  const handleRefresh = useCallback(async () => {
    setIsRefreshing(true);
    try {
      await refreshBalances();
    } finally {
      setIsRefreshing(false);
    }
  }, [refreshBalances]);

  const handleSendSuccess = useCallback(() => {
    setIsSendModalOpen(false);
  }, []);

  const fullAddress = account?.address?.toString() ?? '';
  const displayAddress = formatMassaAddress(fullAddress);

  return (
    <div className="bg-background">
      <div className="max-w-md mx-auto">
        {/* Header */}
        <div className="px-6 py-4 flex justify-between items-center">
          <h1 className="text-2xl font-semibold text-black dark:text-white">
            WALLET
          </h1>
          <Button
            onClick={handleRefresh}
            disabled={isLoading || isRefreshing}
            variant="icon"
            size="custom"
            title="Refresh balance and prices"
            className="p-2"
          >
            <svg
              className={`w-5 h-5 text-gray-600 dark:text-gray-300 ${isRefreshing ? '-animate-spin' : ''}`}
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"
              />
            </svg>
          </Button>
        </div>

        {/* Address */}
        {fullAddress && (
          <div className="px-6 -mt-2">
            <div className="flex items-center justify-between text-xs text-gray-600 dark:text-gray-300">
              <span className="uppercase tracking-wide">Address</span>
              <div className="flex items-center gap-2">
                <span className="px-2 py-1 rounded-md bg-gray-100 dark:bg-gray-800">
                  {displayAddress}
                </span>
                <CopyClipboard text={fullAddress} title="Copy address" />
              </div>
            </div>
          </div>
        )}

        {/* Total Balance */}
        <div className="px-6 py-4 text-center">
          <div className="text-4xl font-semibold text-black dark:text-white">
            {isLoading ? 'Loading...' : `$${totalValueUsd.toFixed(2)}`}
          </div>
        </div>

        {/* Action Buttons */}
        <div className="px-6 py-4">
          <div className="flex justify-center gap-6">
            {/* Send Button */}
            <button
              onClick={() => setIsSendModalOpen(true)}
              className="flex flex-col items-center group bg-transparent hover:bg-transparent active:bg-transparent focus:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-blue-500"
            >
              <div className="w-10 h-10 bg-gray-200 dark:bg-gray-700 group-hover:bg-gray-300 dark:group-hover:bg-gray-600 rounded-full flex items-center justify-center mb-2 transition-colors">
                <img src={sendIcon} alt="Send" />
              </div>
              <span className="text-xs font-medium text-black dark:text-white">
                send
              </span>
            </button>

            {/* Receive Button */}
            <button
              onClick={() => setIsReceiveModalOpen(true)}
              className="flex flex-col items-center group bg-transparent hover:bg-transparent active:bg-transparent focus:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-blue-500"
            >
              <div className="w-10 h-10 bg-gray-200 dark:bg-gray-700 group-hover:bg-gray-300 dark:group-hover:bg-gray-600 rounded-full flex items-center justify-center mb-2 transition-colors">
                <img src={receiveIcon} alt="Receive" />
              </div>
              <span className="text-xs font-medium text-black dark:text-white">
                receive
              </span>
            </button>

            {/* Swap Button */}
            <button
              onClick={() =>
                alert('Swap functionality will be implemented soon!')
              }
              className="flex flex-col items-center group bg-transparent hover:bg-transparent active:bg-transparent focus:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-blue-500"
            >
              <div className="w-10 h-10 bg-gray-200 dark:bg-gray-700 group-hover:bg-gray-300 dark:group-hover:bg-gray-600 rounded-full flex items-center justify-center mb-2 transition-colors">
                <img src={swapIcon} alt="Swap" />
              </div>
              <span className="text-xs font-medium text-black dark:text-white">
                swap
              </span>
            </button>
          </div>
        </div>

        {/* Token List */}
        <div className="px-6">
          <div className="space-y-0">
            {tokens.map((token, index) => (
              <div key={index}>
                <div className="flex items-center py-4">
                  {/* Token Icon */}
                  <div className="mr-4">
                    <img
                      src={token.icon}
                      alt={token.name}
                      className="w-11 h-11 rounded-full"
                    />
                  </div>

                  {/* Token Info */}
                  <div className="flex-1">
                    <div className="text-base font-bold text-black dark:text-white">
                      {token.name}
                    </div>
                    <div className="text-sm font-medium text-[#b2b2b2] dark:text-gray-400">
                      {isLoading
                        ? 'Loading...'
                        : `${formatAmount(token.balance ?? 0n, token.decimals).preview} ${token.ticker}`}
                    </div>
                  </div>

                  {/* Token Value */}
                  <div className="text-sm font-semibold text-black dark:text-white">
                    {isLoading
                      ? 'Loading...'
                      : token.valueUsd != null
                        ? `$${token.valueUsd.toFixed(2)}`
                        : 'N/A'}
                  </div>
                </div>

                {/* Separator Line */}
                {index < tokens.length - 1 && (
                  <div className="h-px bg-gray-200 dark:bg-gray-700"></div>
                )}
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Send Modal */}
      <SendModal
        isOpen={isSendModalOpen}
        onClose={() => setIsSendModalOpen(false)}
        onSuccess={handleSendSuccess}
      />

      {/* Receive Modal */}
      <ReceiveModal
        isOpen={isReceiveModalOpen}
        onClose={() => setIsReceiveModalOpen(false)}
      />
    </div>
  );
};

export default Wallet;
