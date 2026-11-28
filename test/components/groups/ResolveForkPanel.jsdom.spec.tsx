import './matchMedia';
import { afterEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import ResolveForkPanel from '../../../src/components/groups/ResolveForkPanel';
import { byText, click, renderAt } from './render';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, o?: { n?: number }) => (o?.n ? `${key}#${o.n}` : key),
  }),
}));

const ends = [
  {
    epoch: 'b',
    name: '',
    members: ['me', 'x', 'y'],
    owner: 'me',
    createdAt: 2,
  },
  {
    epoch: 'a',
    name: '',
    members: ['me', 'x', 'z'],
    owner: 'me',
    createdAt: 1,
  },
];

describe('ResolveForkPanel (§4.9)', () => {
  let unmount: () => Promise<void> = async () => {};
  afterEach(() => unmount());

  it('preselects members of every end and makes the others be decided', async () => {
    const onSend = vi.fn(async () => {});
    const r = await renderAt(
      <ResolveForkPanel
        ends={ends}
        me="me"
        memberName={id => id}
        onSend={onSend}
      />
    );
    unmount = r.unmount;
    expect(
      r.container.querySelectorAll('[data-testid="resolve-apart"]')
    ).toHaveLength(2);
    const send = byText('resolve.send') as HTMLButtonElement;
    expect(byText('resolve.undecided')).toBeDefined();
    await click(send);
    expect(onSend).not.toHaveBeenCalled();
    await click(byText('resolve.include_all'));
    await click(byText('resolve.send'));
    expect(onSend).toHaveBeenCalledTimes(1);
    expect([...onSend.mock.calls[0][0]].sort()).toEqual(['me', 'x', 'y', 'z']);
  });

  it('offers one page per end in created_at order', async () => {
    const onSend = vi.fn(async () => {});
    const r = await renderAt(
      <ResolveForkPanel
        ends={ends}
        me="me"
        memberName={id => id}
        onSend={onSend}
      />
    );
    unmount = r.unmount;
    await click(byText('resolve.page_branch#1'));
    await click(byText('resolve.send'));
    // Version 1 is the end created first: x and z.
    expect(onSend).toHaveBeenCalledWith(['me', 'x', 'z']);
  });
});
