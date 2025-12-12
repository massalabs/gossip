import React, { useCallback, useRef, useEffect, useMemo } from 'react';
import { Search, X, Loader } from 'react-feather';
import { useSearch } from '../../hooks/useSearch';

interface SearchBarProps {
  value: string;
  onChange: (query: string) => void;
  onSearch?: (query: string) => void; // Called with debounced value
  placeholder?: string;
  isLoading?: boolean;
  className?: string;
  autoFocus?: boolean; // Default: false
  debounceMs?: number; // Default: 300ms
  disabled?: boolean;
  'aria-label'?: string;
}

/**
 * Reusable SearchBar component with debouncing, clear button, and loading state
 * Follows app design system with rounded-full styling and theme variables
 * Optimized for performance with memoization and stable callbacks
 */
const SearchBar: React.FC<SearchBarProps> = React.memo(
  ({
    value,
    onChange,
    onSearch,
    placeholder = 'Search...',
    isLoading = false,
    className = '',
    autoFocus = false,
    debounceMs = 300,
    disabled = false,
    'aria-label': ariaLabel = 'Search',
  }) => {
    const inputRef = useRef<HTMLInputElement>(null);

    // Use the search hook for debouncing the onSearch callback
    // Sync the hook's internal state with the controlled value prop
    const { setQuery } = useSearch({
      debounceMs,
      onSearch,
      initialQuery: value,
    });

    // Sync external value with useSearch hook when value changes externally
    useEffect(() => {
      setQuery(value);
    }, [value, setQuery]);

    // Handle input change - call onChange immediately for responsive UI
    const handleChange = useCallback(
      (e: React.ChangeEvent<HTMLInputElement>) => {
        const newValue = e.target.value;
        setQuery(newValue); // Update hook for debouncing
        onChange(newValue); // Update parent immediately
      },
      [onChange, setQuery]
    );

    // Handle clear button click
    const handleClear = useCallback(() => {
      setQuery(''); // Clear hook state
      onChange(''); // Clear parent state
      inputRef.current?.focus();
    }, [onChange, setQuery]);

    // Auto-focus on mount if requested
    useEffect(() => {
      if (autoFocus && inputRef.current && !disabled) {
        inputRef.current.focus();
      }
    }, [autoFocus, disabled]);

    // Memoize icon components
    const searchIcon = useMemo(
      () => <Search className="w-5 h-5 text-muted-foreground" />,
      []
    );

    const clearIcon = useMemo(
      () => <X className="w-4 h-4 text-muted-foreground" />,
      []
    );

    const loadingSpinner = useMemo(
      () => <Loader className="w-4 h-4 text-muted-foreground animate-spin" />,
      []
    );

    const hasValue = value.trim().length > 0;
    const showClearButton = hasValue && !isLoading && !disabled;

    return (
      <div className={`relative ${className}`}>
        {/* Search Icon */}
        <div className="absolute left-4 top-1/2 -translate-y-1/2 pointer-events-none">
          {searchIcon}
        </div>

        {/* Input */}
        <input
          ref={inputRef}
          type="text"
          value={value}
          onChange={handleChange}
          placeholder={placeholder}
          disabled={disabled}
          aria-label={ariaLabel}
          className={`w-full h-12 pl-11 pr-11 rounded-full border text-sm focus:outline-none focus:ring-2 transition text-foreground bg-background placeholder-muted-foreground ${
            disabled
              ? 'border-border opacity-50 cursor-not-allowed'
              : 'border-border focus:ring-primary'
          }`}
        />

        {/* Clear Button or Loading Spinner */}
        {showClearButton && (
          <button
            type="button"
            onClick={handleClear}
            className="absolute right-4 top-1/2 -translate-y-1/2 p-1 hover:bg-muted rounded-full transition-colors focus:outline-none focus:ring-2 focus:ring-ring"
            aria-label="Clear search"
            tabIndex={0}
          >
            {clearIcon}
          </button>
        )}

        {isLoading && (
          <div className="absolute right-4 top-1/2 -translate-y-1/2 pointer-events-none">
            {loadingSpinner}
          </div>
        )}
      </div>
    );
  }
);

SearchBar.displayName = 'SearchBar';

export default SearchBar;
