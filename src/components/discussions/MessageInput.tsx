import React, { useState, useRef, useCallback } from 'react';
import { Send, X } from 'react-feather';
import { Message } from '../../db';
import Button from '../ui/Button';

interface MessageInputProps {
  onSend: (message: string, replyToId?: number) => Promise<void>;
  disabled?: boolean;
  replyingTo?: Message | null;
  onCancelReply?: () => void;
}

const MessageInput: React.FC<MessageInputProps> = ({
  onSend,
  disabled = false,
  replyingTo,
  onCancelReply,
}) => {
  const [newMessage, setNewMessage] = useState('');
  const [isTextareaMultiline, setIsTextareaMultiline] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
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

  const resetTextarea = useCallback(() => {
    if (textareaRef.current) {
      textareaRef.current.value = '';
      textareaRef.current.style.height = 'auto';
    }
    setIsTextareaMultiline(false);
    setNewMessage('');
  }, []);

  const handleSendMessage = useCallback(async () => {
    const cleanedMessage = newMessage.replace(/^\s+|\s+$/g, '');
    if (cleanedMessage.length === 0) return;

    onSend(cleanedMessage, replyingTo?.id);

    resetTextarea();
  }, [newMessage, onSend, replyingTo, resetTextarea]);

  const handleCancelReply = useCallback(
    (e: React.MouseEvent | React.TouchEvent) => {
      if (!onCancelReply) return;
      e.stopPropagation();
      onCancelReply();
    },
    [onCancelReply]
  );

  const preventDefaultWrapper = (
    fn: (e: React.MouseEvent | React.TouchEvent) => void,
    e: React.MouseEvent | React.TouchEvent
  ) => {
    e.preventDefault();
    e.stopPropagation();
    fn(e);
  };

  const focusTextarea = useCallback(() => {
    if (textareaRef.current) {
      textareaRef.current.focus();
    }
  }, []);

  return (
    <>
      <div
        className="bg-card/60 dark:bg-card/80 backdrop-blur-xl border-t border-border px-4 md:px-8 py-3 md:py-4"
        onMouseDown={e => preventDefaultWrapper(focusTextarea, e)}
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
                  onClick={e => preventDefaultWrapper(handleCancelReply, e)}
                  onMouseDown={e => preventDefaultWrapper(handleCancelReply, e)}
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
            className={`flex-1 min-w-0 flex items-center bg-muted border border-gray-300 px-4 md:px-5 py-2 md:py-2.5 ${
              isTextareaMultiline ? 'rounded-2xl' : 'rounded-full'
            }`}
            tabIndex={-1}
          >
            <textarea
              ref={textareaRef}
              value={newMessage}
              onChange={handleTextareaChange}
              placeholder="Type a message"
              rows={1}
              className={`pointer-events-auto touch-auto flex-1 bg-transparent text-foreground placeholder:text-muted-foreground
                         text-[15px] leading-relaxed resize-none p-0 m-0 focus:outline-none outline-none
                         scrollbar-transparent ${isTextareaMultiline ? 'overflow-y-auto' : 'overflow-y-hidden'}`}
            />
          </div>
          <Button
            tabIndex={-1}
            onMouseDown={e => preventDefaultWrapper(handleSendMessage, e)}
            variant="primary"
            size="custom"
            disabled={sendButtonDisabled}
            className={`w-9 h-9 md:w-10 md:h-10 shrink-0 
                rounded-full flex items-center justify-center 
                shadow-md hover:shadow-lg transition-all `}
            title="Send message"
          >
            <Send className="w-4 h-4 md:w-5 md:h-5 pointer-events-none touch-none" />
          </Button>
        </div>
      </div>
    </>
  );
};

export default MessageInput;
