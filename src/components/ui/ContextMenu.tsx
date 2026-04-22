import React, { useEffect, useRef, useCallback } from 'react';
import { createPortal } from 'react-dom';

export interface ContextMenuItem {
  label: string;
  icon?: React.ReactNode;
  onClick: () => void;
  danger?: boolean;
}

interface ContextMenuProps {
  items: ContextMenuItem[];
  isOpen: boolean;
  onClose: () => void;
}

const ContextMenu: React.FC<ContextMenuProps> = ({
  items,
  isOpen,
  onClose,
}) => {
  const menuRef = useRef<HTMLDivElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const dragStartY = useRef<number | null>(null);
  const focusedIndex = useRef(-1);

  // Save focused element when opening, reset index when closing
  useEffect(() => {
    if (isOpen) {
      previousFocusRef.current = document.activeElement as HTMLElement | null;
      focusedIndex.current = -1;
    }
  }, [isOpen]);

  const restoreAndClose = useCallback(() => {
    previousFocusRef.current?.focus();
    previousFocusRef.current = null;
    onClose();
  }, [onClose]);

  const getMenuItems = useCallback(
    () =>
      menuRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [],
    []
  );

  const highlightItem = useCallback(
    (index: number) => {
      const menuItems = getMenuItems();
      // Remove previous highlight
      menuItems.forEach(el => el.removeAttribute('data-focused'));
      if (index >= 0 && index < menuItems.length) {
        menuItems[index].setAttribute('data-focused', 'true');
        focusedIndex.current = index;
      }
    },
    [getMenuItems]
  );

  // Keyboard: Escape + arrow navigation + Enter/Space
  useEffect(() => {
    if (!isOpen) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        restoreAndClose();
        return;
      }

      const menuItems = getMenuItems();
      if (!menuItems.length) return;

      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        let nextIndex: number;
        if (focusedIndex.current === -1) {
          nextIndex = e.key === 'ArrowDown' ? 0 : menuItems.length - 1;
        } else if (e.key === 'ArrowDown') {
          nextIndex =
            focusedIndex.current < menuItems.length - 1
              ? focusedIndex.current + 1
              : 0;
        } else {
          nextIndex =
            focusedIndex.current > 0
              ? focusedIndex.current - 1
              : menuItems.length - 1;
        }
        highlightItem(nextIndex);
      }

      if ((e.key === 'Enter' || e.key === ' ') && focusedIndex.current >= 0) {
        e.preventDefault();
        (menuItems[focusedIndex.current] as HTMLElement).click();
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, restoreAndClose, getMenuItems, highlightItem]);

  const handleTouchEnd = useCallback(
    (e: React.TouchEvent) => {
      if (dragStartY.current === null) return;
      const delta = e.changedTouches[0].clientY - dragStartY.current;
      dragStartY.current = null;
      if (delta > 50) {
        restoreAndClose();
      }
    },
    [restoreAndClose]
  );

  if (!isOpen) return null;

  return createPortal(
    <div
      className="fixed inset-0 z-1000 flex flex-col items-center justify-end"
      onMouseDown={e => e.preventDefault()}
    >
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-black/50 dark:bg-black/60 animate-backdrop-fade-in"
        onClick={restoreAndClose}
        data-testid="context-menu-backdrop"
      />

      {/* Sheet */}
      <div
        ref={menuRef}
        role="menu"
        aria-label="Context menu"
        className="relative w-full md:max-w-2xl lg:max-w-3xl bg-card rounded-t-2xl shadow-2xl pb-safe-b animate-sheet-slide-up"
        onTouchStart={e => {
          e.stopPropagation();
          dragStartY.current = e.touches[0].clientY;
        }}
        onTouchEnd={handleTouchEnd}
      >
        {/* Drag handle */}
        <div className="flex justify-center pt-3 pb-1">
          <div className="w-10 h-1 rounded-full bg-muted-foreground/30" />
        </div>

        {/* Menu items — plain div so tapping doesn't steal focus / dismiss keyboard on iOS */}
        {items.map((item, index) => (
          <div
            key={item.label}
            role="menuitem"
            onClick={() => {
              item.onClick();
              restoreAndClose();
            }}
            className={`hover-fill w-full flex items-center justify-between gap-3 py-3.5 px-6 text-sm font-medium text-left cursor-pointer data-[focused]:bg-accent ${
              item.danger ? 'text-destructive' : 'text-foreground'
            } ${index < items.length - 1 ? 'border-b border-border' : ''}`}
          >
            <span className="relative">{item.label}</span>
            {item.icon && (
              <span className="w-6 h-6 rounded-full bg-accent-soft text-accent-soft-foreground dark:bg-muted dark:text-accent shrink-0 flex items-center justify-center [&>svg]:w-3.5 [&>svg]:h-3.5">
                {item.icon}
              </span>
            )}
          </div>
        ))}
      </div>
    </div>,
    document.body
  );
};

export default ContextMenu;
