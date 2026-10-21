import { useEffect, useState } from "react";

/**
 * A server preview of a pending command (it writes nothing): asked 300 ms after the input settles; an answer to an
 * older input is dropped. `input` null = not complete yet, so nothing is asked. While a newer answer is on its way
 * the last one stays readable as `stale` (marked pending), never a guessed number. `ask` must be a stable function.
 */
export function usePreview<I, O>(input: I | null, ask: (input: I) => Promise<O>) {
  const key = input === null ? null : JSON.stringify(input);
  const [state, setState] = useState<{ key: string | null; data?: O; error?: unknown }>({ key: null });
  useEffect(() => {
    if (key === null) return;
    let live = true;
    const timer = setTimeout(() => {
      ask(JSON.parse(key) as I).then(
        (data) => live && setState({ key, data }),
        (error: unknown) => live && setState({ key, error }),
      );
    }, 300);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [key, ask]);
  const fresh = key !== null && state.key === key;
  return { data: fresh ? state.data : undefined, error: fresh ? state.error : undefined, pending: key !== null && !fresh, stale: state.data };
}
