import { describe, it, expect } from 'vitest';

describe('jsdom environment example', () => {
  it('can access DOM APIs via jsdom', () => {
    // jsdom provides a simulated DOM
    const div = document.createElement('div');
    div.textContent = 'Hello jsdom';

    expect(div.textContent).toBe('Hello jsdom');
    expect(div.nodeName).toBe('DIV');
  });

  it('can test localStorage', () => {
    localStorage.setItem('test', 'value');
    expect(localStorage.getItem('test')).toBe('value');
    localStorage.clear();
  });

  it('has window object', () => {
    expect(window).toBeDefined();
    expect(window.location).toBeDefined();
  });
});
