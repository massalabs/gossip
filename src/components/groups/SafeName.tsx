import React from 'react';
import { safeName } from '../../utils/groupName';

interface SafeNameProps {
  /** An untrusted name (group, local or contact name). */
  name: string;
  /** Shown when nothing visible is left of the name. */
  fallback?: string;
  maxGraphemes?: number;
  className?: string;
}

/**
 * Shows an untrusted name as §5.11 requires: plain text made safe by
 * `safeName`, isolated from the direction of the surrounding text (`bdi`,
 * `dir="auto"`) and clipped to its own line so that stacked marks cannot draw
 * over other text.
 */
const SafeName: React.FC<SafeNameProps> = ({
  name,
  fallback = '',
  maxGraphemes,
  className = '',
}) => {
  const shown = safeName(name, maxGraphemes) || fallback;
  return (
    <bdi
      dir="auto"
      className={`inline-block max-w-full overflow-hidden whitespace-nowrap text-ellipsis align-bottom [unicode-bidi:isolate] ${className}`}
    >
      {shown}
    </bdi>
  );
};

export default SafeName;
