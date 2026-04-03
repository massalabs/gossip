import type React from 'react';

/**
 * Scroll the field's parent into view within the nearest scroll container.
 * Use as onFocus handler on form inputs to reveal the next field when keyboard opens.
 */
export function scrollFieldIntoView(e: React.FocusEvent<HTMLInputElement>) {
  const field = e.target.closest('div > div') ?? e.target.parentElement;
  if (!field) return;
  setTimeout(() => {
    const scrollContainer = field.closest('.overflow-y-auto');
    if (scrollContainer) {
      const fieldRect = field.getBoundingClientRect();
      const containerRect = scrollContainer.getBoundingClientRect();
      const offset =
        fieldRect.top - containerRect.top + scrollContainer.scrollTop;
      scrollContainer.scrollTo({ top: offset - 16, behavior: 'smooth' });
    }
  }, 300);
}
