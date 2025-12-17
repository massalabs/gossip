import React, { useCallback, useRef, useEffect } from 'react';
import { Search, X, Loader } from 'react-feather';

interface SearchBarProps {
  value: string;
  onChange: (query: string) => void;
  onSearch?: (query: string) => void; // Called immediately on every input change (debouncing should be handled by the parent if needed)
  placeholder?: string;
  isLoading?: boolean;
  className?: string;
  autoFocus?: boolean; // Default: false
  disabled?: boolean;
  'aria-label'?: string;
}

/**
 * Reusable SearchBar component with clear button and loading state
 * Follows app design system with rounded-full styling and theme variables
 * Note: Debouncing should be handled in the parent component using useSearch hook
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
    disabled = false,
    'aria-label': ariaLabel = 'Search',
  }) => {
    const inputRef = useRef<HTMLInputElement>(null);

    // Handle input change - call onChange immediately for responsive UI
    const handleChange = useCallback(
      (e: React.ChangeEvent<HTMLInputElement>) => {
        const newValue = e.target.value;
        onChange(newValue);
        // Call onSearch if provided (called immediately, not debounced)
        if (onSearch) {
          onSearch(newValue);
        }
      },
      [onChange, onSearch]
    );

    // Handle clear button click
    const handleClear = useCallback(() => {
      onChange('');
      if (onSearch) {
        onSearch('');
      }
      inputRef.current?.focus();
    }, [onChange, onSearch]);

    // Auto-focus on mount if requested
    useEffect(() => {
      if (autoFocus && inputRef.current && !disabled) {
        inputRef.current.focus();
      }
    }, [autoFocus, disabled]);

    // Icon components (no need to memoize static elements)
    const searchIcon = <Search className="w-5 h-5 text-muted-foreground" />;
    const clearIcon = <X className="w-4 h-4 text-muted-foreground" />;
    const loadingSpinner = (
      <Loader className="w-4 h-4 text-muted-foreground animate-spin" />
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
