import { useState, useEffect, useRef, useCallback, useMemo } from 'react';

interface UseSearchOptions {
  debounceMs?: number; // Default 300ms
  onSearch?: (query: string) => void; // Optional callback for debounced search
  initialQuery?: string; // Initial search query
}

interface UseSearchReturn {
  query: string;
  debouncedQuery: string;
  setQuery: (query: string) => void;
  clearQuery: () => void;
  isSearching: boolean; // true when query is not empty
}

/**
 * Hook for managing search state with debouncing
 * Follows React best practices for performance:
 * - Uses useRef for timeout management to avoid stale closures
 * - Proper cleanup in useEffect to prevent memory leaks
 * - Memoized return values to prevent unnecessary re-renders
 * - Stable function references with useCallback
 */
export const useSearch = (options: UseSearchOptions = {}): UseSearchReturn => {
  const { debounceMs = 300, onSearch, initialQuery = '' } = options;

  const [query, setQueryState] = useState<string>(initialQuery);
  const [debouncedQuery, setDebouncedQuery] = useState<string>(initialQuery);
  const timeoutRef = useRef<NodeJS.Timeout | null>(null);
  const onSearchRef = useRef(onSearch);

  // Keep onSearch ref up to date without causing re-renders
  useEffect(() => {
    onSearchRef.current = onSearch;
  }, [onSearch]);

  // Debounce the search query
  useEffect(() => {
    // Clear any existing timeout
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current);
    }

    // Set new timeout
    timeoutRef.current = setTimeout(() => {
      setDebouncedQuery(query);
      // Call onSearch callback with debounced value
      if (onSearchRef.current) {
        onSearchRef.current(query);
      }
    }, debounceMs);

    // Cleanup function
    return () => {
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current);
        timeoutRef.current = null;
      }
    };
  }, [query, debounceMs]);

  // Stable setQuery function
  const setQuery = useCallback((newQuery: string) => {
    setQueryState(newQuery);
  }, []);

  // Stable clearQuery function
  const clearQuery = useCallback(() => {
    setQueryState('');
    setDebouncedQuery('');
    // Clear timeout if query is cleared
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
    }
    // Call onSearch with empty string immediately when cleared
    if (onSearchRef.current) {
      onSearchRef.current('');
    }
  }, []);

  // Memoized isSearching value
  const isSearching = useMemo(() => query.trim().length > 0, [query]);

  return {
    query,
    debouncedQuery,
    setQuery,
    clearQuery,
    isSearching,
  };
};
