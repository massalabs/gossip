import React, { useState, useCallback, useEffect, useRef } from 'react';
import { Check, Copy } from 'react-feather';

interface CopyClipboardProps {
  text: string;
  className?: string;
  iconSize?: string;
  title?: string;
}

const CopyClipboard: React.FC<CopyClipboardProps> = ({
  text,
  className = '',
  iconSize = 'w-4 h-4',
  title = 'Copy to clipboard',
}) => {
  const [isCopied, setIsCopied] = useState(false);
  const timeoutRef = useRef<NodeJS.Timeout | null>(null);

  useEffect(() => {
    return () => {
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current);
      }
    };
  }, []);

  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(text);
      setIsCopied(true);

      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current);
      }
      timeoutRef.current = setTimeout(() => setIsCopied(false), 2000);
    } catch (err) {
      console.error('Failed to copy:', err);
    }
  }, [text]);

  return (
    <button
      onClick={handleCopy}
      className={`shrink-0 p-1 hover:bg-gray-100 dark:hover:bg-gray-700 rounded transition-colors touch-manipulation ${className}`}
      title={title}
    >
      {isCopied ? (
        <Check className={`${iconSize} text-success`} />
      ) : (
        <Copy className={`${iconSize} text-gray-500 dark:text-gray-400`} />
      )}
    </button>
  );
};

export default CopyClipboard;
