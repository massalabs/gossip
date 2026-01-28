/**
 * Minimal Observable implementation for reactive storage updates.
 * Compatible with RxJS interface if we need to swap later.
 */

export interface Subscription {
  unsubscribe(): void;
}

export interface Observable<T> {
  subscribe(callback: (value: T) => void): Subscription;
}

/**
 * Basic Subject - emits values to all subscribers
 */
export class Subject<T> implements Observable<T> {
  protected listeners = new Set<(value: T) => void>();

  subscribe(callback: (value: T) => void): Subscription {
    this.listeners.add(callback);
    return {
      unsubscribe: () => {
        this.listeners.delete(callback);
      },
    };
  }

  next(value: T): void {
    this.listeners.forEach(cb => cb(value));
  }

  complete(): void {
    this.listeners.clear();
  }
}

/**
 * BehaviorSubject - emits current value immediately on subscribe,
 * then all subsequent values
 */
export class BehaviorSubject<T> extends Subject<T> {
  constructor(private currentValue: T) {
    super();
  }

  subscribe(callback: (value: T) => void): Subscription {
    // Emit current value immediately
    callback(this.currentValue);
    return super.subscribe(callback);
  }

  next(value: T): void {
    this.currentValue = value;
    super.next(value);
  }

  getValue(): T {
    return this.currentValue;
  }
}

/**
 * Helper to create an Observable from a Dexie liveQuery
 */
export function fromDexieLiveQuery<T>(
  liveQueryFn: () => T | Promise<T>,
  liveQuery: (fn: () => T | Promise<T>) => {
    subscribe: (cb: (value: T) => void) => { unsubscribe: () => void };
  }
): Observable<T> {
  return {
    subscribe(callback: (value: T) => void): Subscription {
      const subscription = liveQuery(liveQueryFn).subscribe(callback);
      return {
        unsubscribe: () => subscription.unsubscribe(),
      };
    },
  };
}

/**
 * Combines multiple observables - emits array of latest values when any source emits
 */
export function combineLatest<T extends unknown[]>(observables: {
  [K in keyof T]: Observable<T[K]>;
}): Observable<T> {
  return {
    subscribe(callback: (value: T) => void): Subscription {
      const values: unknown[] = new Array(observables.length).fill(undefined);
      const hasValue: boolean[] = new Array(observables.length).fill(false);
      const subscriptions: Subscription[] = [];

      observables.forEach((obs, index) => {
        const sub = obs.subscribe(value => {
          values[index] = value;
          hasValue[index] = true;
          if (hasValue.every(Boolean)) {
            callback([...values] as T);
          }
        });
        subscriptions.push(sub);
      });

      return {
        unsubscribe: () => {
          subscriptions.forEach(sub => sub.unsubscribe());
        },
      };
    },
  };
}

/**
 * Maps values from one Observable to another
 */
export function map<T, U>(
  source: Observable<T>,
  transform: (value: T) => U
): Observable<U> {
  return {
    subscribe(callback: (value: U) => void): Subscription {
      return source.subscribe(value => callback(transform(value)));
    },
  };
}
