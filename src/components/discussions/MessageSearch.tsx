import React, { useState, useCallback, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronUp, ChevronDown, X } from 'react-feather';
import { Message } from '@massalabs/gossip-sdk';

interface MessageSearchProps {
  messages: Message[];
  onScrollToMessage: (id: number) => void;
  onHighlightChange: (id: number | null) => void;
  onClose: () => void;
}

const DEBOUNCE_MS = 300;

const MessageSearch: React.FC<MessageSearchProps> = ({
  messages,
  onScrollToMessage,
  onHighlightChange,
  onClose,
}) => {
  const { t } = useTranslation('discussions');
  const [query, setQuery] = useState('');
  const [debouncedQuery, setDebouncedQuery] = useState('');
  const [matches, setMatches] = useState<Message[]>([]);
  const [currentIndex, setCurrentIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const prevQueryRef = useRef('');

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // Debounce the query to avoid filtering on every keystroke
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedQuery(query), DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [query]);

  const navigateTo = useCallback(
    (msg: Message) => {
      if (msg.id != null) {
        onScrollToMessage(msg.id);
        onHighlightChange(msg.id);
      }
    },
    [onScrollToMessage, onHighlightChange]
  );

  // Filter matches on query or message changes; auto-navigate only when query changes
  useEffect(() => {
    if (!debouncedQuery.trim()) {
      setMatches([]);
      setCurrentIndex(0);
      onHighlightChange(null);
      prevQueryRef.current = debouncedQuery;
      return;
    }

    const lowerQuery = debouncedQuery.toLowerCase();
    const found = messages.filter(
      m => m.id != null && m.content.toLowerCase().includes(lowerQuery)
    );
    setMatches(found);

    // Only auto-navigate when the query changed, not on message updates
    if (debouncedQuery !== prevQueryRef.current) {
      if (found.length > 0) {
        const lastIndex = found.length - 1;
        setCurrentIndex(lastIndex);
        navigateTo(found[lastIndex]);
      } else {
        onHighlightChange(null);
      }
    }

    prevQueryRef.current = debouncedQuery;
  }, [debouncedQuery, messages, navigateTo, onHighlightChange]);

  const navigatePrev = useCallback(() => {
    if (matches.length === 0) return;
    const newIndex = currentIndex > 0 ? currentIndex - 1 : matches.length - 1;
    setCurrentIndex(newIndex);
    navigateTo(matches[newIndex]);
  }, [matches, currentIndex, navigateTo]);

  const navigateNext = useCallback(() => {
    if (matches.length === 0) return;
    const newIndex = currentIndex < matches.length - 1 ? currentIndex + 1 : 0;
    setCurrentIndex(newIndex);
    navigateTo(matches[newIndex]);
  }, [matches, currentIndex, navigateTo]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        if (e.shiftKey) {
          navigatePrev();
        } else {
          navigateNext();
        }
      } else if (e.key === 'Escape') {
        onClose();
      }
    },
    [navigateNext, navigatePrev, onClose]
  );

  return (
    <div className="flex items-center gap-2 px-3 py-2 bg-card border-b border-border">
      <input
        ref={inputRef}
        type="text"
        value={query}
        onChange={e => setQuery(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder={t('search.placeholder')}
        className="flex-1 min-w-0 px-3 py-1.5 text-sm bg-muted rounded-lg border border-border text-foreground placeholder-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring"
      />
      {query && (
        <span className="text-xs text-muted-foreground whitespace-nowrap">
          {matches.length > 0
            ? t('search.result_count', {
                current: currentIndex + 1,
                total: matches.length,
              })
            : t('search.no_results')}
        </span>
      )}
      <button
        onPointerDown={e => e.preventDefault()}
        onClick={navigatePrev}
        disabled={matches.length === 0}
        className="p-1.5 rounded-lg hover:bg-muted disabled:opacity-30 transition-colors"
        aria-label={t('search.previous')}
      >
        <ChevronUp className="w-4 h-4 text-foreground" />
      </button>
      <button
        onPointerDown={e => e.preventDefault()}
        onClick={navigateNext}
        disabled={matches.length === 0}
        className="p-1.5 rounded-lg hover:bg-muted disabled:opacity-30 transition-colors"
        aria-label={t('search.next')}
      >
        <ChevronDown className="w-4 h-4 text-foreground" />
      </button>
      <button
        onPointerDown={e => {
          e.preventDefault();
          onClose();
        }}
        className="p-1.5 rounded-lg hover:bg-muted transition-colors"
        aria-label={t('search.close')}
      >
        <X className="w-4 h-4 text-foreground" />
      </button>
    </div>
  );
};

export default MessageSearch;
