import React, { useState, useCallback, useEffect, useRef } from 'react';

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
      className={`shrink-0 p-1 hover:bg-gray-100 dark:hover:bg-gray-700 rounded transition-colors ${className}`}
      title={title}
    >
      {isCopied ? (
        <svg
          className={`${iconSize} text-success`}
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M5 13l4 4L19 7"
          />
        </svg>
      ) : (
        <svg
          className={`${iconSize} text-gray-500 dark:text-gray-400`}
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z"
          />
        </svg>
      )}
    </button>
  );
};

export default CopyClipboard;
