// How much of Home's queue the viewer was shown: each read it is built from either landed, was refused (a part of the
// queue this account may not read) or failed (a fault worth a retry). Pure: Home never reads a partial queue as
// "nothing to do".

export type ReadState = "loading" | "ok" | "denied" | "failed";
/** One read Home's queue is built from, by the part of the queue it fills. */
export type Source<K extends string> = { key: K; state: ReadState };
export type Coverage<K extends string> = { loading: boolean; denied: K[]; failed: K[]; complete: boolean };

/** The parts refused and failed, each named once (two reads may fill one part), in the order given. */
export function coverage<K extends string>(sources: readonly Source<K>[]): Coverage<K> {
  const parts = (state: ReadState) => [...new Set(sources.filter((s) => s.state === state).map((s) => s.key))];
  const denied = parts("denied");
  const failed = parts("failed");
  return { loading: sources.some((s) => s.state === "loading"), denied, failed, complete: denied.length === 0 && failed.length === 0 };
}
