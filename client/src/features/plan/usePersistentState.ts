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

/**
 * The boolean twin of the above, for board preferences like "the backlog is
 * folded away". Stored as "1"/"0" so an unrelated value in the slot falls back
 * instead of reading as `true`.
 */
export function usePersistentFlag(key: string, fallback = false): [boolean, (value: boolean) => void] {
  const [value, setValue] = useState<boolean>(() => {
    try {
      const stored = localStorage.getItem(key);
      return stored === "1" ? true : stored === "0" ? false : fallback;
    } catch {
      return fallback;
    }
  });
  const update = useCallback(
    (next: boolean) => {
      setValue(next);
      try {
        localStorage.setItem(key, next ? "1" : "0");
      } catch {
        /* preference is best-effort */
      }
    },
    [key]
  );
  return [value, update];
}
