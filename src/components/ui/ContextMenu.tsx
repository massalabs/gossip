import React, { useState, useEffect, useRef, useCallback } from 'react';
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
  const [mounted, setMounted] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const dragStartY = useRef<number | null>(null);

  // Save and restore focus
  useEffect(() => {
    if (isOpen) {
      previousFocusRef.current = document.activeElement as HTMLElement | null;
      const id = requestAnimationFrame(() => setMounted(true));
      return () => cancelAnimationFrame(id);
    }
    setMounted(false);
  }, [isOpen]);

  // Focus first item on mount
  useEffect(() => {
    if (mounted) {
      requestAnimationFrame(() => {
        menuRef.current
          ?.querySelector<HTMLButtonElement>('[role="menuitem"]')
          ?.focus();
      });
    }
  }, [mounted]);

  // Restore focus on close
  useEffect(() => {
    if (!isOpen && previousFocusRef.current) {
      previousFocusRef.current.focus();
      previousFocusRef.current = null;
    }
  }, [isOpen]);

  // Keyboard: Escape + arrow navigation
  useEffect(() => {
    if (!isOpen) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
        return;
      }

      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        const menuItems =
          menuRef.current?.querySelectorAll<HTMLButtonElement>(
            '[role="menuitem"]'
          );
        if (!menuItems?.length) return;

        const currentIndex = Array.from(menuItems).findIndex(
          el => el === document.activeElement
        );
        let nextIndex: number;
        if (e.key === 'ArrowDown') {
          nextIndex =
            currentIndex < menuItems.length - 1 ? currentIndex + 1 : 0;
        } else {
          nextIndex =
            currentIndex > 0 ? currentIndex - 1 : menuItems.length - 1;
        }
        menuItems[nextIndex].focus();
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, onClose]);

  // Swipe-down to dismiss
  const handleTouchStart = useCallback((e: React.TouchEvent) => {
    dragStartY.current = e.touches[0].clientY;
  }, []);

  const handleTouchEnd = useCallback(
    (e: React.TouchEvent) => {
      if (dragStartY.current === null) return;
      const delta = e.changedTouches[0].clientY - dragStartY.current;
      dragStartY.current = null;
      if (delta > 50) {
        onClose();
      }
    },
    [onClose]
  );

  if (!isOpen) return null;

  return createPortal(
    <div className="fixed inset-0 z-1000 flex flex-col items-center justify-end">
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-black/50 dark:bg-black/60 transition-opacity"
        onClick={onClose}
        data-testid="context-menu-backdrop"
      />

      {/* Sheet */}
      <div
        ref={menuRef}
        role="menu"
        aria-label="Context menu"
        className={`relative w-full md:max-w-2xl lg:max-w-3xl bg-card rounded-t-2xl shadow-2xl pb-safe-b transform transition-transform duration-200 ease-out ${
          mounted ? 'translate-y-0' : 'translate-y-full'
        }`}
        onTouchStart={handleTouchStart}
        onTouchEnd={handleTouchEnd}
      >
        {/* Drag handle */}
        <div className="flex justify-center pt-3 pb-1">
          <div className="w-10 h-1 rounded-full bg-muted-foreground/30" />
        </div>

        {/* Menu items */}
        {items.map((item, index) => (
          <button
            key={item.label}
            role="menuitem"
            type="button"
            onClick={() => {
              onClose();
              item.onClick();
            }}
            className={`hover-fill w-full flex items-center justify-between gap-3 py-3.5 px-6 text-sm font-medium text-left ${
              item.danger ? 'text-destructive' : 'text-foreground'
            } ${index < items.length - 1 ? 'border-b border-border' : ''}`}
          >
            <span className="relative">{item.label}</span>
            {item.icon && (
              <span className="w-6 h-6 rounded-full bg-muted shrink-0 flex items-center justify-center text-accent [&>svg]:w-3.5 [&>svg]:h-3.5">
                {item.icon}
              </span>
            )}
          </button>
        ))}
      </div>
    </div>,
    document.body
  );
};

export default ContextMenu;
