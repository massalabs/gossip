import React, { useState, useRef, useCallback, useEffect } from 'react';
import { Send, X } from 'react-feather';
import { Message } from '../../db';
import Button from '../ui/Button';

interface MessageInputProps {
  onSend: (message: string, replyToId?: number) => void;
  disabled?: boolean;
  replyingTo?: Message | null;
  onCancelReply?: () => void;
  initialValue?: string;
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
}) => {
  const [newMessage, setNewMessage] = useState(initialValue || '');
  const [isTextareaMultiline, setIsTextareaMultiline] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const prevInitialValueRef = useRef(initialValue);
  const hasInitialFocusRef = useRef(false);
  const sendButtonDisabled = disabled || !newMessage.trim();

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

  const resetTextarea = () => {
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
    }
    setIsTextareaMultiline(false);
    setNewMessage('');
  };

  const handleSendMessage = (e: MessageInputEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const cleanedMessage = newMessage.trim();
    if (cleanedMessage.length === 0) return;

    onSend(cleanedMessage, replyingTo?.id);

    resetTextarea();
  };

  const handleCancelReply = (e: CancelReplyEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (!onCancelReply) return;
    onCancelReply();
  };

  const focusTextarea = (e: MessageInputEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (!textareaRef.current) return;
    textareaRef.current.focus();
  };

  return (
    <>
      <div
        className="bg-card border-t border-border px-4 md:px-8 py-3 md:py-4"
        onMouseDown={focusTextarea}
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
              placeholder="Type a message"
              rows={1}
              inputMode="text"
              autoComplete="off"
              autoCapitalize="sentences"
              spellCheck={true}
              className={`flex-1 bg-transparent text-foreground placeholder:text-muted-foreground
                         text-[15px] md:text-[18px] leading-relaxed resize-none p-0 m-0 focus:outline-none outline-none
                         scrollbar-transparent ${isTextareaMultiline ? 'overflow-y-auto' : 'overflow-y-hidden'}`}
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
