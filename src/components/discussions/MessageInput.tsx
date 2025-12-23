import React, { useState, useRef, useCallback, useEffect } from 'react';
import { Send, X } from 'react-feather';
import { Capacitor } from '@capacitor/core';
import { Message } from '../../db';

interface MessageInputProps {
  onSend: (message: string, replyToId?: number) => void;
  disabled?: boolean;
  replyingTo?: Message | null;
  onCancelReply?: () => void;
  initialValue?: string;
  onFocus?: () => void;
  forwardPreview?: string | null;
  onCancelForward?: () => void;
  forwardMode?: 'forward' | 'reply';
}
type MessageInputEvent = React.MouseEvent | React.KeyboardEvent;

type CancelReplyEvent = React.MouseEvent;
type CancelForwardEvent = React.MouseEvent;

const MessageInput: React.FC<MessageInputProps> = ({
  onSend,
  disabled = false,
  replyingTo,
  onCancelReply,
  initialValue,
  onFocus,
  forwardPreview,
  onCancelForward,
  forwardMode = 'forward',
}) => {
  const [newMessage, setNewMessage] = useState(initialValue || '');
  const [isTextareaMultiline, setIsTextareaMultiline] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const prevInitialValueRef = useRef(initialValue);
  const hasInitialFocusRef = useRef(false);
  const isForwarding = !!forwardPreview;
  const sendButtonDisabled = disabled || (!newMessage.trim() && !isForwarding);

  const autoResizeTextarea = useCallback(() => {
    const el = textareaRef.current;
    if (!el) return;

    el.style.height = 'auto';
    const maxHeight = 128;
    const newHeight = Math.min(el.scrollHeight, maxHeight);
    el.style.height = `${newHeight}px`;

    const lineHeight = parseFloat(getComputedStyle(el).lineHeight || '20');
    const isVisuallyMultiline = el.scrollHeight > lineHeight * 1.2;
    setIsTextareaMultiline(isVisuallyMultiline);
  }, []);

  // Update state when initialValue prop changes
  useEffect(() => {
    if (initialValue !== prevInitialValueRef.current) {
      prevInitialValueRef.current = initialValue;
      if (initialValue !== undefined) {
        setNewMessage(initialValue);
        hasInitialFocusRef.current = false;
      }
    }
  }, [initialValue]);

  // Handle focus and cursor positioning when initialValue is first set
  useEffect(() => {
    if (
      initialValue &&
      !hasInitialFocusRef.current &&
      textareaRef.current &&
      newMessage === initialValue
    ) {
      hasInitialFocusRef.current = true;

      const timeoutId = setTimeout(() => {
        if (textareaRef.current) {
          autoResizeTextarea();
          textareaRef.current.focus();
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

      if (sendButtonDisabled) return;
      const cleanedMessage = newMessage.trim();
      if (cleanedMessage.length === 0 && !isForwarding) return;

      onSend(cleanedMessage, replyToId);

      resetTextarea();

      // Refocus the textarea after sending
      requestAnimationFrame(() => {
        textareaRef.current?.focus();
      });
    },
    [
      newMessage,
      onSend,
      replyToId,
      resetTextarea,
      sendButtonDisabled,
      isForwarding,
    ]
  );

  const handleTextareaKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      // Web-only: Enter sends, Shift+Enter inserts newline
      if (Capacitor.isNativePlatform()) return;

      // Don't send while composing (IME)
      if (e.nativeEvent.isComposing) return;

      if (e.key === 'Enter' && !e.shiftKey) {
        handleSendMessage(e);
      }
    },
    [handleSendMessage]
  );

  const handleCancelReply = useCallback(
    (e: CancelReplyEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (!onCancelReply) return;
      onCancelReply();
    },
    [onCancelReply]
  );

  const handleCancelForward = useCallback(
    (e: CancelForwardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (!onCancelForward) return;
      onCancelForward();
    },
    [onCancelForward]
  );

  const focusTextarea = useCallback((e: React.MouseEvent) => {
    // Only focus if clicking on container background, not the textarea itself
    if (e.target === e.currentTarget) {
      e.preventDefault();
      textareaRef.current?.focus();
    }
  }, []);

  const cursorPositionRef = useRef<number | null>(null);

  const handleTextareaChange = useCallback(
    (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      cursorPositionRef.current = e.target.selectionStart;
      setNewMessage(e.target.value);
      autoResizeTextarea();
    },
    [autoResizeTextarea]
  );

  useEffect(() => {
    if (textareaRef.current && cursorPositionRef.current !== null) {
      textareaRef.current.setSelectionRange(
        cursorPositionRef.current,
        cursorPositionRef.current
      );
    }
  }, [newMessage]);

  return (
    <div
      className="bg-card border-t border-border px-4 md:px-8 py-3 md:py-4"
      style={{
        // Safe area padding for notched devices
        paddingBottom: 'max(env(safe-area-inset-bottom, 12px), 12px)',
      }}
      onClick={focusTextarea}
    >
      {/* Reply Preview with animation */}
      <div
        className={`overflow-hidden transition-all duration-200 ease-out ${
          replyingTo ? 'max-h-20 opacity-100 mb-2' : 'max-h-0 opacity-0 mb-0'
        }`}
      >
        {replyingTo && (
          <div className="px-3 py-2 bg-muted/50 border-l-2 border-primary rounded-r-lg">
            <div className="flex items-start justify-between gap-2">
              <div className="flex-1 min-w-0">
                <p className="text-[10px] text-muted-foreground font-medium mb-0.5">
                  Replying to
                </p>
                <p className="text-xs text-foreground/80 truncate">
                  {replyingTo.content}
                </p>
              </div>
              {onCancelReply && (
                <button
                  onMouseDown={handleCancelReply}
                  className="shrink-0 p-1.5 hover:bg-muted rounded-full transition-colors active:scale-90"
                  aria-label="Cancel reply"
                >
                  <X className="w-4 h-4 text-muted-foreground" />
                </button>
              )}
            </div>
          </div>
        )}
      </div>

      {/* Forward Preview with animation */}
      <div
        className={`overflow-hidden transition-all duration-200 ease-out ${
          forwardPreview
            ? 'max-h-20 opacity-100 mb-2'
            : 'max-h-0 opacity-0 mb-0'
        }`}
      >
        {forwardPreview && (
          <div className="px-3 py-2 bg-muted/50 border-l-2 border-primary rounded-r-lg">
            <div className="flex items-start justify-between gap-2">
              <div className="flex-1 min-w-0">
                <p className="text-[10px] text-muted-foreground font-medium mb-0.5">
                  {forwardMode === 'reply'
                    ? 'Replying to'
                    : 'Forwarding message'}
                </p>
                <p className="text-xs text-foreground/80 truncate">
                  {forwardPreview}
                </p>
              </div>
              {onCancelForward && (
                <button
                  onMouseDown={handleCancelForward}
                  className="shrink-0 p-1.5 hover:bg-muted rounded-full transition-colors active:scale-90"
                  aria-label="Cancel forward"
                >
                  <X className="w-4 h-4 text-muted-foreground" />
                </button>
              )}
            </div>
          </div>
        )}
      </div>

      <div className="flex items-end gap-2 md:gap-3">
        <div
          className={`flex-1 min-w-0 flex items-center bg-muted px-4 md:px-5 py-2 md:py-2.5 transition-all duration-200 ${
            isTextareaMultiline ? 'rounded-2xl' : 'rounded-full'
          }`}
          onClick={focusTextarea}
        >
          <textarea
            ref={textareaRef}
            value={newMessage}
            onChange={handleTextareaChange}
            onKeyDown={handleTextareaKeyDown}
            onFocus={onFocus}
            placeholder="Type a message"
            rows={1}
            inputMode="text"
            autoComplete="off"
            autoCapitalize="sentences"
            spellCheck={true}
            enterKeyHint="send"
            aria-label="Message input"
            className={`flex-1 bg-transparent text-foreground placeholder:text-muted-foreground
                       leading-relaxed resize-none p-0 m-0 focus:outline-none outline-none
                       scrollbar-transparent select-text touch-auto
                       ${isTextareaMultiline ? 'overflow-y-auto' : 'overflow-y-hidden'}`}
            style={{ fontSize: '16px' }}
          />
        </div>
        <button
          onMouseDown={handleSendMessage}
          className={`w-9 h-9 md:w-10 md:h-10 shrink-0 
              rounded-full flex items-center justify-center 
              shadow-md hover:shadow-lg transition-all duration-200
              active:scale-90 ${sendButtonDisabled ? 'bg-muted text-muted-foreground' : 'bg-primary text-primary-foreground'}
              `}
          title="Send message"
          aria-label="Send message"
        >
          <Send className="w-4 h-4 md:w-5 md:h-5" />
        </button>
      </div>
    </div>
  );
};

export default MessageInput;
