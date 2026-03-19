import { useRef, useEffect } from 'react';

interface UseInitialValueOptions {
  initialValue: string | undefined;
  textareaRef: React.RefObject<HTMLTextAreaElement | null>;
  setValue: (v: string) => void;
  currentValue: string;
  resize: () => void;
}

export function useInitialValue({
  initialValue,
  textareaRef,
  setValue,
  currentValue,
  resize,
}: UseInitialValueOptions) {
  const prevRef = useRef(initialValue);
  const hasFocusedRef = useRef(false);

  useEffect(() => {
    if (initialValue !== prevRef.current) {
      prevRef.current = initialValue;
      if (initialValue !== undefined) {
        setValue(initialValue);
        hasFocusedRef.current = false;
      }
    }
  }, [initialValue, setValue]);

  useEffect(() => {
    if (
      initialValue &&
      !hasFocusedRef.current &&
      textareaRef.current &&
      currentValue === initialValue
    ) {
      hasFocusedRef.current = true;

      const id = setTimeout(() => {
        if (textareaRef.current) {
          resize();
          textareaRef.current.focus();
          textareaRef.current.setSelectionRange(
            initialValue.length,
            initialValue.length
          );
        }
      }, 100);

      return () => clearTimeout(id);
    }
  }, [initialValue, currentValue, resize, textareaRef]);
}
