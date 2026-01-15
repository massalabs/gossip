import React from 'react';
import { formatUserId } from '../../../gossip-sdk/src/utils/userId';
import CopyClipboard from './CopyClipboard';

interface UserIdDisplayProps {
  userId: string;
  visible?: boolean; // Kept for backward compatibility, no longer used
  onChange?: (visible: boolean) => void; // Kept for backward compatibility, no-op
  showCopy?: boolean;
  showHideToggle?: boolean; // Kept for backward compatibility, no longer used
  prefixChars?: number;
  suffixChars?: number;
  textSize?: 'xs' | 'sm' | 'base';
  textClassName?: string;
  className?: string;
  onToggleClick?: (e: React.MouseEvent<HTMLButtonElement>) => void; // Kept for backward compatibility, no-op
  copyTitle?: string;
}

const UserIdDisplay: React.FC<UserIdDisplayProps> = ({
  userId,
  // Kept for backwards compatibility; no longer control visibility
  visible: _visible = true,
  onChange: _onChange,
  showCopy = false,
  showHideToggle: _showHideToggle = false,
  prefixChars = 4,
  suffixChars = 5,
  textSize = 'xs',
  textClassName = '',
  className = '',
  onToggleClick: _onToggleClick,
  copyTitle = 'Copy user ID',
}) => {
  const userIdFormatted = formatUserId(userId, prefixChars, suffixChars);

  const textSizeClasses = {
    xs: 'text-xs',
    sm: 'text-sm',
    base: 'text-base',
  };

  const defaultTextClasses = `font-medium truncate ${textSizeClasses[textSize]}`;

  // Determine text color based on context - use muted-foreground for xs/sm, gray for base
  // Only apply if textClassName doesn't already specify a color
  const textColorClasses =
    textClassName && textClassName.includes('text-')
      ? ''
      : textSize === 'base'
        ? 'text-gray-600 dark:text-gray-400'
        : 'text-muted-foreground';

  const combinedTextClasses =
    `${defaultTextClasses} ${textColorClasses} ${textClassName}`.trim();

  return (
    <div className={`flex items-center gap-2 min-w-0 ${className}`.trim()}>
      <p className={`${combinedTextClasses} min-w-0`}>{userIdFormatted}</p>
      <div className="flex items-center gap-1 shrink-0">
        {showCopy && <CopyClipboard text={userId} title={copyTitle} />}
      </div>
    </div>
  );
};

export default UserIdDisplay;
