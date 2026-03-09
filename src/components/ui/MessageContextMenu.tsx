import React, { useState, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';

export interface MessageContextMenuItem {
  label: string;
  icon?: React.ReactNode;
  onClick: () => void;
  danger?: boolean;
}

interface MessageContextMenuProps {
  items: MessageContextMenuItem[];
  isOpen: boolean;
  onClose: () => void;
  isOutgoing: boolean;
  position: { top: number; left?: number; right?: number } | null;
  translateY?: number;
  bubbleRect?: {
    top: number;
    left: number;
    width: number;
    height: number;
  } | null;
}

const MessageContextMenu: React.FC<MessageContextMenuProps> = ({
  items,
  isOpen,
  onClose,
  isOutgoing,
  position,
  translateY = 0,
  bubbleRect,
}) => {
  const [mounted, setMounted] = useState(false);
  const [touchReady, setTouchReady] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (isOpen) {
      const id = requestAnimationFrame(() => setMounted(true));
      // Short delay so the opening tap doesn't accidentally hit a menu item
      const timer = setTimeout(() => setTouchReady(true), 120);
      return () => {
        cancelAnimationFrame(id);
        clearTimeout(timer);
      };
    }
    setMounted(false);
    setTouchReady(false);
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

  if (!isOpen || !position) return null;

  return createPortal(
    <div className="fixed inset-0 z-1000">
      {/* Click handler layer */}
      <div
        className={`absolute inset-0 ${touchReady ? '' : 'pointer-events-none'}`}
        onClick={onClose}
        data-testid="context-menu-backdrop"
      />

      {/* Spotlight overlay — dims everything except the selected bubble */}
      {bubbleRect ? (
        <div
          className={`absolute pointer-events-none transition-opacity duration-300 ${
            mounted ? 'opacity-100' : 'opacity-0'
          }`}
          style={{
            top: bubbleRect.top,
            left: bubbleRect.left,
            width: bubbleRect.width,
            height: bubbleRect.height,
            borderRadius: 24,
            boxShadow: `0 0 0 200vmax ${
              document.documentElement.classList.contains('dark')
                ? 'rgba(0,0,0,0.5)'
                : 'rgba(255,255,255,0.5)'
            }`,
          }}
        />
      ) : (
        <div
          className={`absolute inset-0 bg-white/50 dark:bg-black/50 pointer-events-none transition-opacity duration-300 ${
            mounted ? 'opacity-100' : 'opacity-0'
          }`}
        />
      )}

      {/* Floating menu — positioned right below the bubble */}
      <div
        ref={menuRef}
        role="menu"
        aria-label="Message actions"
        className={`fixed min-w-[200px] bg-card border border-border rounded-lg shadow-xl overflow-hidden ${
          mounted ? 'opacity-100' : 'opacity-0 scale-95'
        } ${touchReady ? '' : 'pointer-events-none'}`}
        style={{
          top: position.top,
          ...(position.left !== undefined ? { left: position.left } : {}),
          ...(position.right !== undefined ? { right: position.right } : {}),
          transform: `translateY(${mounted ? translateY : translateY}px) ${mounted ? 'scale(1)' : 'scale(0.95)'}`,
          transformOrigin: isOutgoing ? 'top right' : 'top left',
          transition:
            'transform 0.4s cubic-bezier(0.16, 1, 0.3, 1), opacity 0.2s ease-out',
        }}
      >
        {items.map((item, index) => (
          <button
            key={item.label}
            role="menuitem"
            type="button"
            onClick={() => {
              onClose();
              item.onClick();
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
    </div>,
    document.body
  );
};

export default MessageContextMenu;
