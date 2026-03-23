import { useState, useCallback, useMemo } from 'react';
import { Operation, OperationStatus } from '@massalabs/massa-web3';
import { OperationError } from './types';

interface HandleOperationOptions {
  final?: boolean;
}

interface UseHandleOperationResult {
  isPending: boolean;
  error: OperationError | null;
  operation: Operation | null;
  handleOperation: (
    operation: Operation,
    options?: HandleOperationOptions
  ) => Promise<OperationError | null>;
  reset: () => void;
}

/**
 * A custom React hook to manage blockchain operations using massa-web3.
 * Tracks the operation's lifecycle (pending, success, error) and provides utilities for execution and state reset.
 *
 * @returns An object containing operation state and control functions.
 */
export function useHandleOperation(): UseHandleOperationResult {
  const [state, setState] = useState<{
    isPending: boolean;
    error: OperationError | null;
    operation: Operation | null;
  }>({
    isPending: false,
    error: null,
    operation: null,
  });

  const reset = useCallback(() => {
    setState({
      isPending: false,
      error: null,
      operation: null,
    });
  }, []);

  const handleOperation = useCallback(
    async (
      operation: Operation,
      options: HandleOperationOptions = {}
    ): Promise<OperationError | null> => {
      const { final = false } = options;

      if (state.isPending) {
        throw new Error('An operation is already pending');
      }

      reset();

      setState(prev => ({
        ...prev,
        isPending: true,
        operation,
      }));

      try {
        const status = final
          ? await operation.waitFinalExecution()
          : await operation.waitSpeculativeExecution();

        if (status === OperationStatus.NotFound) {
          const error = { message: 'Operation not found', status };
          setState(prev => ({ ...prev, isPending: false, error }));
          return error;
        }

        if (
          status === OperationStatus.Error ||
          status === OperationStatus.SpeculativeError
        ) {
          const error = {
            message: `Operation failed with status: ${status}`,
            status,
          };
          setState(prev => ({ ...prev, isPending: false, error }));
          return error;
        }

        reset();
        return null;
      } catch (err) {
        const error = {
          message: err instanceof Error ? err.message : 'Unexpected error',
        };

        setState(prev => ({ ...prev, isPending: false, error }));
        return error;
      }
    },

    [reset, state.isPending]
  );

  return useMemo(
    () => ({
      isPending: state.isPending,
      error: state.error,
      operation: state.operation,
      handleOperation,
      reset,
    }),
    [state, handleOperation, reset]
  );
}
