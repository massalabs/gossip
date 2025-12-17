import React, { useState, useRef, useCallback, useEffect } from 'react';
import { Send, X } from 'react-feather';
import { Capacitor } from '@capacitor/core';
import { Message } from '../../db';
import Button from '../ui/Button';

const SELECTION_TAP_MOVE_THRESHOLD_PX = 6;

interface MessageInputProps {
  onSend: (message: string, replyToId?: number) => void;
  disabled?: boolean;
  replyingTo?: Message | null;
  onCancelReply?: () => void;
  initialValue?: string;
  onRequestScrollToBottom?: () => void;
}

type MessageInputEvent =
  | React.MouseEvent
  | React.TouchEvent
  | React.KeyboardEvent;

type CancelReplyEvent = React.MouseEvent | React.TouchEvent;

const MessageInput: React.FC<MessageInputProps> = ({
  onSend,
  disabled = false,
  replyingTo,
  onCancelReply,
  initialValue,
  onRequestScrollToBottom,
}) => {
  const [newMessage, setNewMessage] = useState(initialValue || '');
  const [isTextareaMultiline, setIsTextareaMultiline] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const prevInitialValueRef = useRef(initialValue);
  const hasInitialFocusRef = useRef(false);
  const sendButtonDisabled = disabled || !newMessage.trim();
  const isNative = Capacitor.isNativePlatform();

  const collapseTextareaSelection = useCallback(() => {
    const el = textareaRef.current;
    if (!el) return;
    if (document.activeElement !== el) return;

    const start = el.selectionStart;
    const end = el.selectionEnd;
    if (typeof start !== 'number' || typeof end !== 'number') return;
    if (start === end) return;

    try {
      el.setSelectionRange(end, end);
    } catch {
      // ignore (can fail on some platforms if selection APIs are unavailable)
    }
  }, []);

  // If user taps inside the textarea while there is an existing selection,
  // collapse it (unless they are dragging to adjust selection).
  const selectionTapRef = useRef<{
    active: boolean;
    moved: boolean;
    startX: number;
    startY: number;
  } | null>(null);

  const handleTextareaPointerDown = useCallback(
    (e: React.PointerEvent<HTMLTextAreaElement>) => {
      if (isNative) return;
      const el = textareaRef.current;
      if (!el) return;

      const start = el.selectionStart;
      const end = el.selectionEnd;
      const hasSelection =
        typeof start === 'number' && typeof end === 'number' && start !== end;

      if (!hasSelection) {
        selectionTapRef.current = null;
        return;
      }

      selectionTapRef.current = {
        active: true,
        moved: false,
        startX: e.clientX,
        startY: e.clientY,
      };
    },
    [isNative]
  );

  const handleTextareaPointerMove = useCallback(
    (e: React.PointerEvent<HTMLTextAreaElement>) => {
      const state = selectionTapRef.current;
      if (!state?.active) return;
      if (
        Math.abs(e.clientX - state.startX) > SELECTION_TAP_MOVE_THRESHOLD_PX ||
        Math.abs(e.clientY - state.startY) > SELECTION_TAP_MOVE_THRESHOLD_PX
      ) {
        state.moved = true;
      }
    },
    []
  );

  const handleTextareaPointerUpOrCancel = useCallback(() => {
    const state = selectionTapRef.current;
    selectionTapRef.current = null;
    if (!state?.active || state.moved) return;

    // Let the browser place the caret first, then collapse selection.
    requestAnimationFrame(() => collapseTextareaSelection());
  }, [collapseTextareaSelection]);

  // If user has a selection in the textarea and taps/clicks elsewhere, collapse selection.
  // This matches the "selection goes away when interacting elsewhere" expectation.
  useEffect(() => {
    if (isNative) return;
    const handler = (evt: MouseEvent | TouchEvent) => {
      const el = textareaRef.current;
      if (!el) return;
      const target = evt.target as Node | null;
      if (target && el.contains(target)) return;
      collapseTextareaSelection();
    };

    document.addEventListener('pointerdown', handler, true);
    return () => {
      document.removeEventListener('pointerdown', handler, true);
    };
  }, [collapseTextareaSelection, isNative]);

  const autoResizeTextarea = useCallback(() => {
    const el = textareaRef.current;
    if (!el) return;

    // Reset height to auto so scrollHeight is accurate
    el.style.height = 'auto';
    const maxHeight = 128; // ~ max-h-32
    const newHeight = Math.min(el.scrollHeight, maxHeight);
    el.style.height = `${newHeight}px`;

    const lineHeight = parseFloat(getComputedStyle(el).lineHeight || '20');
    const isVisuallyMultiline = el.scrollHeight > lineHeight * 1.2;
    setIsTextareaMultiline(isVisuallyMultiline);
  }, []);

  const handleTextareaChange = useCallback(
    (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      setNewMessage(e.target.value);
      autoResizeTextarea();
    },
    [autoResizeTextarea]
  );

  // Update state when initialValue prop changes (for shared content)
  // Only update when initialValue actually changes to avoid overwriting user input
  useEffect(() => {
    if (initialValue !== prevInitialValueRef.current) {
      prevInitialValueRef.current = initialValue;
      if (initialValue !== undefined) {
        setNewMessage(initialValue);
        // Reset focus flag when initialValue changes
        hasInitialFocusRef.current = false;
      }
    }
  }, [initialValue]);

  // Handle focus and cursor positioning when initialValue is first set
  // Only runs once per initialValue to prevent cursor jumping while user types
  useEffect(() => {
    if (
      initialValue &&
      !hasInitialFocusRef.current &&
      textareaRef.current &&
      newMessage === initialValue
    ) {
      // Mark that we've done the initial focus
      hasInitialFocusRef.current = true;

      // Use a small delay to ensure textarea is rendered and value is set
      const timeoutId = setTimeout(() => {
        if (textareaRef.current) {
          autoResizeTextarea();
          textareaRef.current.focus();
          // Move cursor to end
          textareaRef.current.setSelectionRange(
            initialValue.length,
            initialValue.length
          );
        }
      }, 100);

      return () => clearTimeout(timeoutId);
    }
  }, [initialValue, newMessage, autoResizeTextarea]);

  const resetTextarea = useCallback(() => {
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
    }
    setIsTextareaMultiline(false);
    setNewMessage('');
  }, []);

  const replyToId = replyingTo?.id;
  const handleSendMessage = useCallback(
    (e: MessageInputEvent) => {
      e.preventDefault();
      e.stopPropagation();
      const cleanedMessage = newMessage.trim();
      if (cleanedMessage.length === 0) return;

      onSend(cleanedMessage, replyToId);

      resetTextarea();
    },
    [newMessage, onSend, replyToId, resetTextarea]
  );

  const handleTextareaKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      // Web-only behavior: Enter sends, Shift+Enter inserts a newline.
      // Keep native (Capacitor) behavior unchanged to avoid breaking mobile UX.
      if (isNative) return;

      // Don't send while user is composing text via an IME.
      if (e.nativeEvent.isComposing) return;

      if (e.key === 'Enter' && !e.shiftKey) {
        handleSendMessage(e);
      }
    },
    [handleSendMessage, isNative]
  );

  const handleCancelReply = (e: CancelReplyEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (!onCancelReply) return;
    onCancelReply();
  };

  const focusTextarea = useCallback(
    (e: React.MouseEvent | React.TouchEvent) => {
      const el = textareaRef.current;
      if (!el) return;

      // If the user is interacting with the textarea itself, don't interfere.
      // Preventing default here breaks native caret placement + long-press selection.
      const target = e.target as HTMLElement | null;
      if (target && (target === el || target.closest('textarea'))) return;

      el.focus();
      onRequestScrollToBottom?.();
      // If there was an existing selection, collapse it when user taps the container area.
      requestAnimationFrame(() => collapseTextareaSelection());
    },
    [collapseTextareaSelection, onRequestScrollToBottom]
  );

  return (
    <>
      <div
        className="bg-card border-t border-border px-4 md:px-8 py-3 md:py-4"
        onMouseDown={focusTextarea}
        onTouchStart={focusTextarea}
      >
        {/* Reply Preview */}
        {replyingTo && (
          <div className="mb-2 px-3 py-2 bg-muted/50 border-l-2 border-primary rounded-r-lg">
            <div className="flex items-start justify-between gap-2">
              <div className="flex-1 min-w-0">
                <p className="text-xs text-foreground/80 truncate">
                  {replyingTo.content}
                </p>
              </div>
              {onCancelReply && (
                <button
                  onMouseDown={handleCancelReply}
                  className="shrink-0 p-1 hover:bg-muted rounded transition-colors"
                >
                  <X className="w-4 h-4 text-muted-foreground" />
                </button>
              )}
            </div>
          </div>
        )}

        <div className="flex items-center gap-2 md:gap-3">
          <div
            className={`flex-1 min-w-0 flex items-center bg-muted px-4 md:px-5 py-2 md:py-2.5 ${
              isTextareaMultiline ? 'rounded-2xl' : 'rounded-full'
            }`}
          >
            <textarea
              ref={textareaRef}
              value={newMessage}
              onChange={handleTextareaChange}
              onKeyDown={handleTextareaKeyDown}
              onFocus={onRequestScrollToBottom}
              onPointerDown={handleTextareaPointerDown}
              onPointerMove={handleTextareaPointerMove}
              onPointerUp={handleTextareaPointerUpOrCancel}
              onPointerCancel={handleTextareaPointerUpOrCancel}
              placeholder="Type a message"
              rows={1}
              inputMode="text"
              autoComplete="off"
              autoCapitalize="sentences"
              spellCheck={true}
              // On native mobile (Capacitor WebView), disable selection/long-press callouts if desired.
              // Keep normal selection behavior on web.
              style={
                isNative
                  ? ({
                      userSelect: 'none',
                      WebkitUserSelect: 'none',
                      WebkitTouchCallout: 'none',
                    } as React.CSSProperties)
                  : undefined
              }
              className={`flex-1 bg-transparent text-foreground placeholder:text-muted-foreground
                         text-[15px] md:text-[18px] leading-relaxed resize-none p-0 m-0 focus:outline-none outline-none
                         scrollbar-transparent ${isTextareaMultiline ? 'overflow-y-auto' : 'overflow-y-hidden'} ${
                           isNative ? 'select-none' : ''
                         }`}
            />
          </div>
          <Button
            onMouseDown={handleSendMessage}
            variant="primary"
            size="custom"
            disabled={sendButtonDisabled}
            className={`w-9 h-9 md:w-10 md:h-10 shrink-0 
                rounded-full flex items-center justify-center 
                shadow-md hover:shadow-lg transition-all `}
            title="Send message"
          >
            <Send className="w-4 h-4 md:w-5 md:h-5" />
          </Button>
        </div>
      </div>
    </>
  );
};

export default MessageInput;
