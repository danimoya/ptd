import { useCallback, useState } from "react";

/**
 * useState that survives a reload. Every access is guarded: localStorage throws
 * in a private window and is stubbed out in tests, and a board preference is
 * never worth taking the page down for.
 */
export function usePersistentState<T extends string>(key: string, fallback: T, allowed: readonly T[]): [T, (value: T) => void] {
  const [value, setValue] = useState<T>(() => {
    try {
      const stored = localStorage.getItem(key) as T | null;
      return stored && allowed.includes(stored) ? stored : fallback;
    } catch {
      return fallback;
    }
  });
  const update = useCallback(
    (next: T) => {
      setValue(next);
      try {
        localStorage.setItem(key, next);
      } catch {
        /* preference is best-effort */
      }
    },
    [key]
  );
  return [value, update];
}
