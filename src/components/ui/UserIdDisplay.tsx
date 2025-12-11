import React from 'react';
import { Eye, EyeOff } from 'react-feather';
import { formatUserId } from '../../utils/userId';
import CopyClipboard from './CopyClipboard';

interface UserIdDisplayProps {
  userId: string;
  visible?: boolean; // Visibility state (true = visible, false = hidden)
  onChange?: (visible: boolean) => void; // Callback when visibility changes
  showCopy?: boolean;
  showHideToggle?: boolean;
  prefixChars?: number;
  suffixChars?: number;
  textSize?: 'xs' | 'sm' | 'base';
  textClassName?: string;
  className?: string;
  onToggleClick?: (e: React.MouseEvent<HTMLButtonElement>) => void;
  copyTitle?: string;
}

const UserIdDisplay: React.FC<UserIdDisplayProps> = ({
  userId,
  visible = true, // Default to visible
  onChange,
  showCopy = false,
  showHideToggle = false,
  prefixChars = 4,
  suffixChars = 5,
  textSize = 'xs',
  textClassName = '',
  className = '',
  onToggleClick,
  copyTitle = 'Copy user ID',
}) => {
  const userIdFormatted = formatUserId(userId, prefixChars, suffixChars);
  const userIdHidden = '•'.repeat(userIdFormatted.length);

  const handleToggleClick = (e: React.MouseEvent<HTMLButtonElement>) => {
    if (onToggleClick) {
      onToggleClick(e);
    }
    if (onChange) {
      onChange(!visible);
    }
  };

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
      <p className={`${combinedTextClasses} min-w-0`}>
        {visible ? userIdFormatted : userIdHidden}
      </p>
      <div className="flex items-center gap-1 shrink-0">
        {showCopy && <CopyClipboard text={userId} title={copyTitle} />}
        {showHideToggle && onChange && (
          <button
            onClick={handleToggleClick}
            className="shrink-0 p-1 hover:bg-muted rounded transition-colors"
            title={visible ? 'Hide User ID' : 'Show User ID'}
            aria-pressed={visible}
            aria-label={visible ? 'Hide User ID' : 'Show User ID'}
          >
            {visible ? (
              <Eye
                className={`${textSize === 'base' ? 'w-4 h-4' : 'w-3 h-3'} text-muted-foreground`}
              />
            ) : (
              <EyeOff
                className={`${textSize === 'base' ? 'w-4 h-4' : 'w-3 h-3'} text-muted-foreground`}
              />
            )}
          </button>
        )}
      </div>
    </div>
  );
};

export default UserIdDisplay;
