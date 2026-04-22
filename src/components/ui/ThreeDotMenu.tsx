import React, { useState, useEffect, useRef, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { MoreVertical } from 'react-feather';

export type MenuItem =
  | {
      type?: 'item';
      label: string;
      icon?: React.ReactNode;
      onClick: () => void;
      danger?: boolean;
    }
  | { type: 'separator' };

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
  const [menuPos, setMenuPos] = useState<{ top: number; right: number } | null>(
    null
  );
  const containerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  // Position the portal'd menu relative to the trigger
  useEffect(() => {
    if (!open || !triggerRef.current) return;
    const rect = triggerRef.current.getBoundingClientRect();
    setMenuPos({
      top: rect.bottom + 8, // mt-2 equivalent
      right: window.innerWidth - rect.right,
    });
  }, [open]);

  const close = useCallback(() => {
    setOpen(false);
    triggerRef.current?.focus();
  }, []);

  // Close on click outside
  useEffect(() => {
    if (!open) return;

    const handleClickOutside = (e: MouseEvent | TouchEvent) => {
      const target = e.target as Node;
      const insideContainer = containerRef.current?.contains(target);
      const insideMenu = menuRef.current?.contains(target);
      if (!insideContainer && !insideMenu) {
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

      {open &&
        menuPos &&
        createPortal(
          <div
            ref={menuRef}
            role="menu"
            aria-label={triggerLabel}
            className="fixed min-w-[200px] max-w-[280px] bg-card border border-border rounded-2xl shadow-xl z-[1000] overflow-hidden animate-context-menu-in"
            style={
              {
                top: menuPos.top,
                right: menuPos.right,
                '--menu-origin': 'top right',
              } as React.CSSProperties
            }
          >
            {items.map((item, index) =>
              item.type === 'separator' ? (
                <div
                  key={index}
                  className="border-b border-border"
                  role="separator"
                />
              ) : (
                <button
                  key={index}
                  role="menuitem"
                  type="button"
                  onClick={() => {
                    item.onClick();
                    close();
                  }}
                  className={`w-full flex items-center justify-between gap-3 px-4 py-3 text-sm font-medium text-left ${
                    item.danger ? 'text-destructive' : 'text-foreground'
                  }`}
                >
                  <span className="relative">{item.label}</span>
                  {item.icon && (
                    <span className="w-6 h-6 rounded-full bg-accent-soft text-accent-soft-foreground dark:bg-muted dark:text-accent shrink-0 flex items-center justify-center [&>svg]:w-3.5 [&>svg]:h-3.5">
                      {item.icon}
                    </span>
                  )}
                </button>
              )
            )}
          </div>,
          document.body
        )}
    </div>
  );
};

export default ThreeDotMenu;
