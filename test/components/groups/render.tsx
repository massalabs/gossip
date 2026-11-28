import './matchMedia';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

/** Renders `element` at `path` inside a router, in a fresh container. */
export async function renderAt(
  element: React.ReactElement,
  path = '/',
  pattern = '/'
): Promise<{
  container: HTMLDivElement;
  root: Root;
  unmount: () => Promise<void>;
}> {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path={pattern} element={element} />
          <Route path="*" element={<div data-testid="elsewhere" />} />
        </Routes>
      </MemoryRouter>
    );
  });
  return {
    container,
    root,
    unmount: async () => {
      await act(async () => root.unmount());
      container.remove();
    },
  };
}

export async function click(el: Element | null | undefined) {
  if (!el) throw new Error('element not found');
  await act(async () => {
    (el as HTMLElement).click();
  });
}

export function byText(text: string, root: ParentNode = document.body) {
  // Buttons first, so that a button whose text matches wins over its list item.
  const all = [
    ...Array.from(root.querySelectorAll('button')),
    ...Array.from(root.querySelectorAll('p, span, h3, li')),
  ];
  return all.find(e => e.textContent?.trim() === text) as
    | HTMLElement
    | undefined;
}
