import React, { useState, useEffect, useRef, useCallback } from 'react';
import { MoreVertical } from 'react-feather';

export interface MenuItem {
  label: string;
  icon?: React.ReactNode;
  onClick: () => void;
  danger?: boolean;
}

interface ThreeDotMenuProps {
  items: MenuItem[];
  /** aria-label for the trigger button */
  triggerLabel?: string;
}

/**
 * Accessible 3-dot overflow menu.
 *
 * - Opens a dropdown on click with menu items
 * - Closes on click outside, Escape key, or item selection
 * - Focus management: focuses first item on open, restores trigger on close
 * - Accessible: role="menu", role="menuitem", aria-expanded
 * - 200ms fade+scale animation
 */
const ThreeDotMenu: React.FC<ThreeDotMenuProps> = ({
  items,
  triggerLabel = 'More options',
}) => {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  const close = useCallback(() => {
    setOpen(false);
    triggerRef.current?.focus();
  }, []);

  // Close on click outside
  useEffect(() => {
    if (!open) return;

    const handleClickOutside = (e: MouseEvent | TouchEvent) => {
      if (
        containerRef.current &&
        !containerRef.current.contains(e.target as Node)
      ) {
        close();
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    document.addEventListener('touchstart', handleClickOutside);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('touchstart', handleClickOutside);
    };
  }, [open, close]);

  // Close on Escape and handle arrow key navigation
  useEffect(() => {
    if (!open) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        close();
        return;
      }

      if (e.key === 'Tab') {
        close();
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
  }, [open, close]);

  // Focus first menu item on open
  useEffect(() => {
    if (open) {
      // Wait for render
      requestAnimationFrame(() => {
        menuRef.current
          ?.querySelector<HTMLButtonElement>('[role="menuitem"]')
          ?.focus();
      });
    }
  }, [open]);

  return (
    <div className="relative" ref={containerRef}>
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen(prev => !prev)}
        aria-label={triggerLabel}
        aria-expanded={open}
        aria-haspopup="menu"
        className="w-8 h-8 flex items-center justify-center rounded-full hover:opacity-70 active:opacity-50"
      >
        <MoreVertical className="w-5 h-5 text-muted-foreground" />
      </button>

      {open && (
        <div
          ref={menuRef}
          role="menu"
          aria-label={triggerLabel}
          className="absolute right-0 top-full mt-2 min-w-[200px] max-w-[280px] bg-card border border-border rounded-lg shadow-xl z-50 origin-top-right animate-menu-open overflow-hidden"
        >
          {items.map((item, index) => (
            <button
              key={index}
              role="menuitem"
              type="button"
              onClick={() => {
                item.onClick();
                close();
              }}
              className={`hover-fill w-full flex items-center justify-between gap-3 px-4 py-3 text-sm font-medium text-left ${
                item.danger ? 'text-destructive' : 'text-foreground'
              } ${index < items.length - 1 ? 'border-b border-border' : ''}`}
            >
              <span className="relative">{item.label}</span>
              {item.icon && (
                <span className="w-6 h-6 rounded-full bg-accent text-accent-foreground dark:bg-muted dark:text-accent shrink-0 flex items-center justify-center [&>svg]:w-3.5 [&>svg]:h-3.5">
                  {item.icon}
                </span>
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  );
};

export default ThreeDotMenu;
