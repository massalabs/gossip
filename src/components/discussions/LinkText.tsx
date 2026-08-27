import React from 'react';
import type { parseLinks } from '../../utils/linkUtils';

interface LinkTextProps {
  segments: ReturnType<typeof parseLinks>;
  onLinkClick: (e: React.MouseEvent<HTMLAnchorElement>) => void;
  linkAriaLabel: (content: string) => string;
}

/**
 * Renders parsed message text with clickable links. Shared by the message
 * bubble, cited/forwarded previews and announcement bubbles.
 */
const LinkText: React.FC<LinkTextProps> = ({
  segments,
  onLinkClick,
  linkAriaLabel,
}) => (
  <>
    {segments.map((segment, index) =>
      segment.type === 'link' ? (
        <a
          key={index}
          href={segment.url}
          target="_blank"
          rel="noopener noreferrer"
          onClick={onLinkClick}
          aria-label={linkAriaLabel(segment.content)}
          className="underline hover:opacity-80 transition-opacity break-all cursor-pointer"
          style={{
            textDecorationColor: 'currentColor',
            textDecorationThickness: '1px',
          }}
        >
          {segment.content}
        </a>
      ) : (
        <span key={index}>{segment.content}</span>
      )
    )}
  </>
);

export default LinkText;
