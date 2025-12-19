import React, { useRef, useCallback, useEffect } from 'react';
import { Terminal, Move } from 'react-feather';
import { useAppStore } from '../../../stores/appStore';

interface ConsoleToggleButtonProps {
  onOpen: () => void;
}

export const ConsoleToggleButton: React.FC<ConsoleToggleButtonProps> = ({
  onOpen,
}) => {
  const savedPosition = useAppStore(s => s.debugButtonPosition);
  const setPosition = useAppStore(s => s.setDebugButtonPosition);

  const buttonRef = useRef<HTMLButtonElement>(null);

  // Use refs for drag state to avoid re-renders during drag
  const isDraggingRef = useRef(false);
  const hasMovedRef = useRef(false);
  const currentPosRef = useRef({ x: savedPosition.x, y: savedPosition.y });
  const dragStartRef = useRef({ x: 0, y: 0 });

  // Sync ref with store when savedPosition changes (e.g., on mount)
  useEffect(() => {
    currentPosRef.current = { x: savedPosition.x, y: savedPosition.y };
  }, [savedPosition.x, savedPosition.y]);

  // Update button position directly via DOM (no React re-render)
  const updateButtonPosition = useCallback((x: number, y: number) => {
    if (buttonRef.current) {
      buttonRef.current.style.transform = `translate(${x}px, ${y}px)`;
    }
  }, []);

  // Clamp position to viewport
  const clampPosition = useCallback((x: number, y: number) => {
    const buttonWidth = buttonRef.current?.offsetWidth || 100;
    const buttonHeight = buttonRef.current?.offsetHeight || 40;
    const maxX = window.innerWidth - buttonWidth;
    const maxY = window.innerHeight - buttonHeight;

    return {
      x: Math.max(0, Math.min(x, maxX)),
      y: Math.max(0, Math.min(y, maxY)),
    };
  }, []);

  // Handle pointer down
  const handlePointerDown = useCallback((e: React.PointerEvent) => {
    e.preventDefault();
    isDraggingRef.current = true;
    hasMovedRef.current = false;

    dragStartRef.current = {
      x: e.clientX - currentPosRef.current.x,
      y: e.clientY - currentPosRef.current.y,
    };

    // Visual feedback
    if (buttonRef.current) {
      buttonRef.current.style.cursor = 'grabbing';
      buttonRef.current.style.opacity = '0.9';
    }

    // Capture pointer
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
  }, []);

  // Handle pointer move - direct DOM manipulation, no state updates
  const handlePointerMove = useCallback(
    (e: React.PointerEvent) => {
      if (!isDraggingRef.current) return;

      const newX = e.clientX - dragStartRef.current.x;
      const newY = e.clientY - dragStartRef.current.y;

      // Check if moved more than 5px (to distinguish from click)
      if (!hasMovedRef.current) {
        const dx = Math.abs(newX - currentPosRef.current.x);
        const dy = Math.abs(newY - currentPosRef.current.y);
        if (dx > 5 || dy > 5) {
          hasMovedRef.current = true;
        }
      }

      // Clamp and update position directly in DOM
      const clamped = clampPosition(newX, newY);
      currentPosRef.current = clamped;
      updateButtonPosition(clamped.x, clamped.y);
    },
    [clampPosition, updateButtonPosition]
  );

  // Handle pointer up - save to store only at the end
  const handlePointerUp = useCallback(
    (e: React.PointerEvent) => {
      if (!isDraggingRef.current) return;

      isDraggingRef.current = false;

      // Reset visual feedback
      if (buttonRef.current) {
        buttonRef.current.style.cursor = 'grab';
        buttonRef.current.style.opacity = '1';
      }

      // Release pointer
      (e.target as HTMLElement).releasePointerCapture(e.pointerId);

      // Only trigger click if we didn't move
      if (!hasMovedRef.current) {
        onOpen();
      } else {
        // Save final position to store (persisted)
        setPosition(currentPosRef.current);
      }
    },
    [onOpen, setPosition]
  );

  // Handle resize - ensure button stays in viewport
  useEffect(() => {
    const handleResize = () => {
      const clamped = clampPosition(
        currentPosRef.current.x,
        currentPosRef.current.y
      );

      if (
        clamped.x !== currentPosRef.current.x ||
        clamped.y !== currentPosRef.current.y
      ) {
        currentPosRef.current = clamped;
        updateButtonPosition(clamped.x, clamped.y);
        setPosition(clamped);
      }
    };

    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, [clampPosition, updateButtonPosition, setPosition]);

  return (
    <button
      ref={buttonRef}
      className="
        fixed top-0 left-0 z-9999 flex items-center gap-1.5 px-3 py-2
        bg-secondary text-secondary-foreground
        rounded-lg shadow-lg border border-border
        select-none touch-none cursor-grab
        hover:shadow-xl
      "
      style={{
        transform: `translate(${savedPosition.x}px, ${savedPosition.y}px)`,
      }}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerUp}
    >
      <Move className="w-3 h-3 text-muted-foreground" />
      <Terminal className="w-4 h-4" />
      <span className="text-sm font-medium">Console</span>
    </button>
  );
};
