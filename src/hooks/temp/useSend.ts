import { useCallback, useMemo, useState } from 'react';
import { Address, MRC20, Operation, Provider } from '@massalabs/massa-web3';
import { useHandleOperation } from './useHandleOperation';
import { Asset, OperationError } from './types';

export interface SendParams {
  recipient: string;
  amount: bigint;
  asset: Asset;
  final: boolean;
  fee?: bigint;
}

export interface UseSendOptions {
  provider: Provider | null;
}

export function useSend(options: UseSendOptions) {
  const { provider } = options;
  const { handleOperation, operation } = useHandleOperation();

  const [state, setState] = useState<{
    isPending: boolean;
    error: OperationError | null;
  }>({
    isPending: false,
    error: null,
  });

  /**
   * Executes a send operation
   * @param sendFn - The function to send the asset
   * @param asset - The asset to send
   * @param amount - The amount to send
   * @param recipient - The recipient address
   * @returns The operation on success, null on failure
   */
  const execute = useCallback(
    async (
      sendFn: () => Promise<Operation>,
      params: SendParams
    ): Promise<Operation | null> => {
      const { recipient, amount, asset, final } = params;
      setState(prev => ({ ...prev, isPending: true }));

      try {
        Address.fromString(recipient);
      } catch {
        setState(prev => ({
          ...prev,
          isPending: false,
          error: { message: 'Invalid address' },
        }));
        return null;
      }

      if (amount > asset.balance) {
        setState(prev => ({
          ...prev,
          isPending: false,
          error: { message: 'Insufficient balance' },
        }));
        return null;
      }

      try {
        const op = await sendFn();

        const error = await handleOperation(op, {
          final,
        });

        if (error) {
          setState(prev => ({ ...prev, error }));
          return null;
        }

        setState(prev => ({ ...prev, error: null }));
        return op;
      } finally {
        setState(prev => ({ ...prev, isPending: false }));
      }
    },
    [handleOperation]
  );

  /**
   * Sends a native Massa coin to a recipient
   * @param recipient - The recipient address
   * @param amount - The amount to send
   * @param asset - The asset to send
   * @returns The operation on success, null on failure
   */
  const sendMassa = useCallback(
    async (params: SendParams): Promise<Operation | null> => {
      if (!provider) throw new Error('No provider');
      return execute(
        () =>
          provider.transfer(params.recipient, params.amount, {
            fee: params.fee,
          }),
        params
      );
    },
    [provider, execute]
  );

  /**
   * Sends a mrc20 token to a recipient
   * @param recipient - The recipient address
   * @param amount - The amount to send
   * @param asset - The token to send
   * @returns The operation on success, null on failure
   */
  const sendToken = useCallback(
    async (params: SendParams): Promise<Operation | null> => {
      if (!provider) throw new Error('No provider');
      const { recipient, amount, asset, fee } = params;
      if (!asset.address) throw new Error('Token address required');
      const mrc20 = new MRC20(provider, asset.address);
      return execute(() => mrc20.transfer(recipient, amount, { fee }), params);
    },
    [provider, execute]
  );

  /**
   * Sends an asset to a recipient
   * The Asset can be a native Massa coin or a mrc20 token
   * @param recipient - The recipient address
   * @param amount - The amount to send
   * @param asset - The asset to send
   * @returns The operation on success, null on failure
   */
  const sendAsset = useCallback(
    async (params: SendParams): Promise<Operation | null> => {
      if (params.asset.isNative) {
        return sendMassa(params);
      }
      return sendToken(params);
    },
    [sendMassa, sendToken]
  );

  return useMemo(
    () => ({
      isPending: state.isPending,
      error: state.error,
      operation,
      sendAsset,
      sendMassa,
      sendToken,
    }),
    [state.isPending, state.error, operation, sendAsset, sendMassa, sendToken]
  );
}
