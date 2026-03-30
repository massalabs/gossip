import { useState, useRef, useCallback, useEffect } from 'react';

export function useAutoResizeTextarea(initialValue = '') {
  const [value, setValue] = useState(initialValue);
  const [isMultiline, setIsMultiline] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const cursorPositionRef = useRef<number | null>(null);

  const resize = useCallback(() => {
    const el = textareaRef.current;
    if (!el) return;

    el.style.height = 'auto';
    const maxHeight = 128;
    el.style.height = `${Math.min(el.scrollHeight, maxHeight)}px`;

    const lineHeight = parseFloat(getComputedStyle(el).lineHeight || '20');
    setIsMultiline(el.scrollHeight > lineHeight * 1.2);
  }, []);

  const reset = useCallback(() => {
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
    }
    setIsMultiline(false);
    setValue('');
  }, []);

  const handleChange = useCallback(
    (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      cursorPositionRef.current = e.target.selectionStart;
      setValue(e.target.value);
      resize();
    },
    [resize]
  );

  const focusOnBackground = useCallback((e: React.MouseEvent) => {
    if (e.target === e.currentTarget) {
      e.preventDefault();
      textareaRef.current?.focus();
    }
  }, []);

  useEffect(() => {
    if (textareaRef.current && cursorPositionRef.current !== null) {
      textareaRef.current.setSelectionRange(
        cursorPositionRef.current,
        cursorPositionRef.current
      );
    }
  }, [value]);

  return {
    textareaRef,
    value,
    setValue,
    isMultiline,
    resize,
    reset,
    handleChange,
    focusOnBackground,
  };
}
