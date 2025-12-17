import React, { useState, useCallback, useEffect, useMemo } from 'react';
import { ChevronDown } from 'react-feather';

// Generic Select Item Component
const SelectItem = <T,>({
  item,
  isSelected,
  onSelect,
  itemHeight,
  renderItem,
}: {
  item: T;
  isSelected: boolean;
  onSelect: () => void;
  itemHeight: number;
  renderItem: (item: T) => React.ReactNode;
}) => (
  <button
    onClick={onSelect}
    className={`w-full flex items-center p-3 hover:bg-gray-50 dark:hover:bg-gray-700 transition-colors ${
      isSelected ? 'bg-blue-50 dark:bg-blue-900/20' : ''
    }`}
    style={{ height: `${itemHeight}px` }}
  >
    {renderItem(item)}
  </button>
);

// Generic Select Component
interface SelectProps<T> {
  items: T[];
  selectedItem: T | null;
  onSelect: (item: T) => void;
  placeholder?: string;
  searchPlaceholder?: string;
  itemHeight?: number;
  searchFields?: (keyof T)[];
  renderSelected: (item: T) => React.ReactNode;
  renderItem: (item: T) => React.ReactNode;
  getItemId: (item: T) => string;
  className?: string;
  disabled?: boolean;
  loading?: boolean;
  emptyMessage?: string;
  showSearch?: boolean;
  closeOnSelect?: boolean;
  multiple?: boolean;
  selectedItems?: T[];
  onMultiSelect?: (items: T[]) => void;
}

function Select<T>({
  items,
  selectedItem,
  onSelect,
  placeholder = 'Select an item',
  searchPlaceholder = 'Search...',
  itemHeight = 72,
  searchFields = [],
  renderSelected,
  renderItem,
  getItemId,
  className = '',
  disabled = false,
  loading = false,
  emptyMessage = 'No items found',
  showSearch = true,
  closeOnSelect = true,
  multiple = false,
  selectedItems = [],
  onMultiSelect,
}: SelectProps<T>) {
  const [isOpen, setIsOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [debouncedSearchQuery, setDebouncedSearchQuery] = useState('');

  // Debounce search query
  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedSearchQuery(searchQuery);
    }, 300);

    return () => clearTimeout(timer);
  }, [searchQuery]);

  // Filter items based on search
  const filteredItems = useMemo(() => {
    if (!debouncedSearchQuery.trim() || searchFields.length === 0) {
      return items;
    }

    const query = debouncedSearchQuery.toLowerCase();
    return items.filter(item =>
      searchFields.some(field => {
        const value = item[field];
        return value && String(value).toLowerCase().includes(query);
      })
    );
  }, [items, debouncedSearchQuery, searchFields]);

  // Close dropdown when clicking outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      const target = event.target as Element;
      if (isOpen && !target.closest('[data-select-container]')) {
        setIsOpen(false);
        setSearchQuery('');
        setDebouncedSearchQuery('');
      }
    };

    if (isOpen) {
      document.addEventListener('mousedown', handleClickOutside);
      return () =>
        document.removeEventListener('mousedown', handleClickOutside);
    }
  }, [isOpen]);

  const handleItemSelect = useCallback(
    (item: T) => {
      if (multiple && onMultiSelect) {
        const itemId = getItemId(item);
        const isSelected = selectedItems.some(
          selected => getItemId(selected) === itemId
        );

        if (isSelected) {
          // Remove from selection
          const newSelection = selectedItems.filter(
            selected => getItemId(selected) !== itemId
          );
          onMultiSelect(newSelection);
        } else {
          // Add to selection
          onMultiSelect([...selectedItems, item]);
        }
      } else {
        onSelect(item);
        if (closeOnSelect) {
          setIsOpen(false);
          setSearchQuery('');
          setDebouncedSearchQuery('');
        }
      }
    },
    [onSelect, multiple, onMultiSelect, selectedItems, getItemId, closeOnSelect]
  );

  return (
    <div data-select-container className={`relative h-fit ${className}`}>
      {/* Selected Item Display */}
      <button
        onClick={() => !disabled && setIsOpen(!isOpen)}
        disabled={disabled}
        className={`w-full flex items-center p-3 rounded-xl border transition-colors ${
          disabled
            ? 'border-border bg-muted dark:bg-input/40 cursor-not-allowed opacity-50'
            : 'border-border bg-card hover:bg-muted/60 dark:bg-input dark:hover:bg-input/80'
        }`}
      >
        {selectedItem ? (
          renderSelected(selectedItem)
        ) : (
          <span className="text-gray-500 dark:text-gray-400">
            {placeholder}
          </span>
        )}
        <ChevronDown
          className={`w-5 h-5 text-gray-500 transition-transform ml-auto ${
            isOpen ? 'rotate-180' : ''
          }`}
        />
      </button>

      {/* Dropdown */}
      {isOpen && (
        <div className="absolute top-full left-0 right-0 mt-1 z-10 border border-border rounded-xl bg-card dark:bg-surface-secondary shadow-lg max-h-80 flex flex-col">
          {/* Search Input */}
          {showSearch && (
            <div className="p-3 border-b border-border shrink-0">
              <input
                type="text"
                placeholder={searchPlaceholder}
                value={searchQuery}
                onChange={e => setSearchQuery(e.target.value)}
                className="w-full px-3 py-2 bg-muted dark:bg-input border border-border rounded-lg focus:ring-2 focus:ring-ring focus:border-transparent text-foreground placeholder-muted-foreground"
                autoFocus
              />
            </div>
          )}

          {/* Items List */}
          <div className="overflow-y-auto flex-1 scrollbar-thin scrollbar-thumb-gray-300 dark:scrollbar-thumb-gray-600 scrollbar-track-transparent">
            {loading ? (
              <div className="p-4 text-center text-gray-500 dark:text-gray-400">
                <div className="flex items-center justify-center">
                  <div className="animate-spin rounded-full h-6 w-6 border-b-2 border-blue-500"></div>
                  <span className="ml-2">Loading...</span>
                </div>
              </div>
            ) : filteredItems.length === 0 ? (
              <div className="p-4 text-center text-gray-500 dark:text-gray-400">
                {emptyMessage}
              </div>
            ) : (
              filteredItems.map(item => {
                const itemId = getItemId(item);
                const isSelected = multiple
                  ? selectedItems.some(
                      selected => getItemId(selected) === itemId
                    )
                  : selectedItem && getItemId(selectedItem) === itemId;

                return (
                  <SelectItem
                    key={itemId}
                    item={item}
                    isSelected={!!isSelected}
                    onSelect={() => handleItemSelect(item)}
                    itemHeight={itemHeight}
                    renderItem={renderItem}
                  />
                );
              })
            )}
          </div>
        </div>
      )}
    </div>
  );
}

export default Select;
