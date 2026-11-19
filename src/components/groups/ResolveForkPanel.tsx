import React, { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { GroupEpoch } from '@massalabs/gossip-sdk';
import Button from '../ui/Button';
import SafeName from './SafeName';

interface ResolveForkPanelProps {
  /** The competing ends this device owns, any order. */
  ends: GroupEpoch[];
  me: string;
  memberName: (userId: string) => string;
  onSend: (members: string[]) => Promise<void>;
}

type Decision = 'include' | 'exclude';

/**
 * The resolution pages of §4.9: page 0 merges (members in every end are
 * preselected, members in only some ends must be decided one by one or all at
 * once), pages 1 to n start from one end's list, in `created_at` order. Every
 * list is editable. Members whose leave applies are left out by the engine.
 */
const ResolveForkPanel: React.FC<ResolveForkPanelProps> = ({
  ends,
  me,
  memberName,
  onSend,
}) => {
  const { t } = useTranslation('groups');
  const sorted = useMemo(
    () =>
      [...ends].sort(
        (a, b) => a.createdAt - b.createdAt || a.epoch.localeCompare(b.epoch)
      ),
    [ends]
  );
  const everyone = useMemo(
    () => [...new Set(sorted.flatMap(e => e.members))].filter(m => m !== me),
    [sorted, me]
  );
  const inEvery = everyone.filter(m =>
    sorted.every(e => e.members.includes(m))
  );
  const inSome = everyone.filter(m => !inEvery.includes(m));

  const [page, setPage] = useState(0);
  const [merge, setMerge] = useState<Record<string, Decision | undefined>>({});
  const [mergeCommon, setMergeCommon] = useState<Set<string>>(new Set(inEvery));
  const [branchLists, setBranchLists] = useState<Set<string>[]>(() =>
    sorted.map(e => new Set(e.members.filter(m => m !== me)))
  );
  const [sending, setSending] = useState(false);

  const undecided = page === 0 && inSome.some(m => merge[m] === undefined);
  const chosen: string[] =
    page === 0
      ? [...mergeCommon, ...inSome.filter(m => merge[m] === 'include')]
      : [...branchLists[page - 1]];

  const branchesOf = (m: string) =>
    sorted
      .map((e, i) =>
        e.members.includes(m) ? t('resolve.page_branch', { n: i + 1 }) : null
      )
      .filter(Boolean)
      .join(', ');

  const toggle = (set: Set<string>, m: string) => {
    const next = new Set(set);
    if (next.has(m)) next.delete(m);
    else next.add(m);
    return next;
  };

  return (
    <div className="space-y-3" data-testid="resolve-fork">
      <div className="flex flex-wrap gap-2" role="tablist">
        {[
          t('resolve.page_merge'),
          ...sorted.map((_, i) => t('resolve.page_branch', { n: i + 1 })),
        ].map((label, i) => (
          <button
            key={i}
            type="button"
            role="tab"
            aria-selected={page === i}
            onClick={() => setPage(i)}
            className={`px-3 py-1 rounded-full text-xs ${
              page === i
                ? 'bg-accent-soft text-accent-soft-foreground font-medium'
                : 'bg-muted text-foreground'
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {page === 0 ? (
        <>
          {inSome.length === 0 && (
            <p className="text-xs text-muted-foreground">
              {t('resolve.identical')}
            </p>
          )}
          <p className="text-xs font-semibold text-muted-foreground">
            {t('resolve.in_every_branch')}
          </p>
          <ul className="divide-y divide-border">
            {inEvery.map(m => (
              <li
                key={m}
                className="flex items-center justify-between py-2 gap-2"
              >
                <span className="text-sm min-w-0 truncate">
                  <SafeName name={memberName(m)} />
                </span>
                <input
                  type="checkbox"
                  aria-label={memberName(m)}
                  checked={mergeCommon.has(m)}
                  onChange={() => setMergeCommon(s => toggle(s, m))}
                />
              </li>
            ))}
          </ul>
          {inSome.length > 0 && (
            <>
              <div className="flex items-center justify-between">
                <p className="text-xs font-semibold text-muted-foreground">
                  {t('resolve.in_some_branches')}
                </p>
                <div className="flex gap-2">
                  <Button
                    variant="link"
                    size="sm"
                    onClick={() =>
                      setMerge(
                        Object.fromEntries(inSome.map(m => [m, 'include']))
                      )
                    }
                  >
                    {t('resolve.include_all')}
                  </Button>
                  <Button
                    variant="link"
                    size="sm"
                    onClick={() =>
                      setMerge(
                        Object.fromEntries(inSome.map(m => [m, 'exclude']))
                      )
                    }
                  >
                    {t('resolve.exclude_all')}
                  </Button>
                </div>
              </div>
              <ul className="divide-y divide-border">
                {inSome.map(m => (
                  <li key={m} className="py-2" data-testid="resolve-apart">
                    <p className="text-sm truncate">
                      <SafeName name={memberName(m)} />
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {t('resolve.in_branches', { list: branchesOf(m) })}
                    </p>
                    <div className="mt-1 flex gap-2">
                      {(['include', 'exclude'] as const).map(d => (
                        <button
                          key={d}
                          type="button"
                          aria-pressed={merge[m] === d}
                          onClick={() => setMerge(s => ({ ...s, [m]: d }))}
                          className={`px-2 py-0.5 rounded text-xs border ${
                            merge[m] === d
                              ? 'bg-accent-soft text-accent-soft-foreground border-transparent'
                              : 'border-border text-foreground'
                          }`}
                        >
                          {t(`resolve.${d}`)}
                        </button>
                      ))}
                    </div>
                  </li>
                ))}
              </ul>
            </>
          )}
        </>
      ) : (
        <ul className="divide-y divide-border">
          {everyone.map(m => (
            <li
              key={m}
              className="flex items-center justify-between py-2 gap-2"
            >
              <span className="text-sm min-w-0 truncate">
                <SafeName name={memberName(m)} />
              </span>
              <input
                type="checkbox"
                aria-label={memberName(m)}
                checked={branchLists[page - 1].has(m)}
                onChange={() =>
                  setBranchLists(lists =>
                    lists.map((l, i) => (i === page - 1 ? toggle(l, m) : l))
                  )
                }
              />
            </li>
          ))}
        </ul>
      )}

      {undecided && (
        <p className="text-xs text-destructive">{t('resolve.undecided')}</p>
      )}
      <Button
        variant="primary"
        fullWidth
        disabled={undecided || sending}
        loading={sending}
        onClick={async () => {
          setSending(true);
          try {
            await onSend([me, ...chosen]);
          } finally {
            setSending(false);
          }
        }}
      >
        {t('resolve.send')}
      </Button>
    </div>
  );
};

export default ResolveForkPanel;
