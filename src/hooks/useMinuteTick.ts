import { useSyncExternalStore } from 'react';

// One shared timer for every consumer instead of one setInterval per
// component instance (the discussion list renders one row per discussion —
// N rows previously meant N timers with staggered re-renders).

const listeners = new Set<() => void>();
let tick = 0;
let intervalId: ReturnType<typeof setInterval> | null = null;

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (intervalId === null) {
    intervalId = setInterval(() => {
      tick++;
      listeners.forEach(l => l());
    }, 60_000);
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && intervalId !== null) {
      clearInterval(intervalId);
      intervalId = null;
    }
  };
}

const getSnapshot = () => tick;

/**
 * Re-renders the consumer once per minute (shared timer). Use to refresh
 * relative-time displays like "5 min ago".
 */
export function useMinuteTick(): number {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
