import { useEffect, useRef } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api, ApiError, unwrap } from "@console/api";
import { invalidatePaths, type PathPrefix } from "../query";
import { announce } from "./announce";

/**
 * 5xx refusals a handler answers before it writes anything (their routes' tests assert nothing written): a shed import
 * apply and an expired import run. Their outcome is known, so they never hold the intent for a check.
 */
export const REFUSED_BEFORE_WRITE: ReadonlySet<string> = new Set(["import_apply_busy", "import_run_expired"]);

/** Uncertain commands retain their identity until their original outcome has been checked. */
export const outcomeUnknown = (error: unknown) => error instanceof TypeError || (error instanceof ApiError && (
  error.status === 0 || (error.status >= 500 && !REFUSED_BEFORE_WRITE.has(error.code)) || error.code === "command_processing" || error.code === "command_applied"
));
/** An authoritative read found no application; an idempotent command may replay its frozen intent. */
export const COMMAND_NOT_APPLIED = Symbol("command_not_applied");
export const keepsKey = outcomeUnknown;

/** Each uncertain failure's recovery (its command's `check`), so the shared refusal can offer it in place. */
const recoveries = new WeakMap<object, () => void>();
/** How to finish an uncertain command where it failed: read its original outcome, then complete it under its key. */
export const recoveryOf = (error: unknown) => (typeof error === "object" && error !== null ? recoveries.get(error) : undefined);

/** Callers that do not yet thread their key still link the actual transport intent when available. */
function commandFailure(error: unknown, requestKey: string): unknown {
  if (error instanceof TypeError) return new ApiError(0, "command_unknown", "", [], undefined, false, [], { requestKey });
  if (!(error instanceof ApiError) || error.requestKey || !outcomeUnknown(error)) return error;
  return new ApiError(error.status, error.code, error.message, error.reasons, error.operationId, error.fromServer, error.refusals, { ...error, requestKey });
}

/**
 * Whether `error` says the server has moved on from what this screen read (409: a stale revision, a record changed
 * or removed meanwhile). The command's reads are then refreshed, so the next attempt starts from the newest state
 * instead of being refused again on the same stale read.
 */
export const readsAreStale = (error: unknown) => error instanceof ApiError && error.status === 409;

/**
 * A server command. One idempotency key per user intent; an uncertain result stays pending until
 * the original outcome is checked. Ordinary refusals and local cancellations allow a new intent.
 * `error` is whatever failed (ApiError or a network fault); render it with <CommandError>.
 */
export function useCommand<I, O>(opts: {
  run: (input: I, idempotencyKey: string) => Promise<O>;
  /** Reads the original outcome without sending the command again; a failed read keeps the intent blocked. */
  verify?: (input: I, idempotencyKey: string) => Promise<O | typeof COMMAND_NOT_APPLIED>;
  /** API path prefixes whose reads this command may change (lib/query.ts). */
  invalidates?: readonly PathPrefix[];
  /**
   * Hold `onSuccess` (the command stays pending) until the open reads under `invalidates` have re-read, so the
   * result and what it changed land in one frame instead of the page shifting under the next click.
   */
  settle?: boolean;
  /**
   * Stay pending until the first of `invalidates` has been read again, so the result and the redrawn view land in
   * one frame (a chart that relayouts after its receipt moves what the user is about to press).
   */
  awaitFirstRead?: boolean;
  onSuccess?: (out: O, input: I) => void;
  /** The server-confirmed result, announced to assistive tech (polite live region). */
  announce?: (out: O, input: I) => string;
  /** One-time secrets: the result is dropped from memory (state and cache) once handed to onSuccess. */
  forget?: boolean;
}) {
  const qc = useQueryClient();
  const key = useRef<string | null>(null);
  const checking = useRef<unknown>(undefined);
  const intent = useRef<{ input: I; run: () => Promise<O> } | null>(null);
  const recovery = useRef<(() => Promise<O>) | null>(null);
  // Live state for `check`, which a failure keeps for later (render values would be stale by then).
  const sending = useRef(false);
  const failed = useRef<unknown>(undefined);
  const m = useMutation({
    mutationFn: async (input: I) => {
      const recover = recovery.current;
      recovery.current = null;
      if (checking.current !== undefined && !recover) throw checking.current;
      const requestKey = (key.current ??= crypto.randomUUID());
      if (!recover) intent.current = { input, run: () => opts.run(input, requestKey) };
      try {
        return await (recover ? recover() : intent.current!.run());
      } catch (error) {
        throw commandFailure(error, requestKey);
      }
    },
    gcTime: opts.forget ? 0 : undefined,
    onMutate: () => {
      sending.current = true;
    },
    onSettled: (_out, error) => {
      sending.current = false;
      failed.current = error ?? undefined;
    },
    onSuccess: async (out, input) => {
      key.current = null;
      checking.current = undefined;
      const reads = invalidatePaths(qc, opts.invalidates ?? []);
      if (opts.settle) await Promise.all(reads);
      else if (opts.awaitFirstRead) await reads[0]?.catch(() => undefined);
      opts.onSuccess?.(out, input);
      if (opts.announce) announce(opts.announce(out, input));
    },
    onError: (error) => {
      if (keepsKey(error)) {
        checking.current = error;
        if (error instanceof ApiError && error.requestKey) key.current = error.requestKey;
        if (typeof error === "object" && error !== null) recoveries.set(error, () => check());
      } else {
        key.current = null;
        checking.current = undefined;
      }
      if (readsAreStale(error)) void invalidatePaths(qc, opts.invalidates ?? []);
    },
  });
  // The hook-level onSuccess runs before the success state lands, so the reset waits for it.
  const { isSuccess, reset } = m;
  useEffect(() => {
    if (opts.forget && isSuccess) reset();
  }, [opts.forget, isSuccess, reset]);
  /** Explicit recovery: check the outcome before replaying the frozen request under its original key. */
  const check = (read?: (requestKey: string) => Promise<O | typeof COMMAND_NOT_APPLIED>) => {
    if ((checking.current === undefined && !read && !(failed.current !== undefined && opts.verify)) || !intent.current || sending.current || recovery.current) return;
    const original = intent.current;
    const requestKey = key.current!;
    // A refused lookup does not resolve the original command.
    const readFailure = (error: unknown) => checking.current ?? failed.current ?? error;
    const readOutcome = read ?? (opts.verify ? (k: string) => opts.verify!(original.input, k) : undefined);
    recovery.current = readOutcome ? async () => {
      let result: O | typeof COMMAND_NOT_APPLIED;
      try { result = await readOutcome(requestKey); } catch (error) { throw readFailure(error); }
      return result === COMMAND_NOT_APPLIED ? original.run() : result as O;
    } : async () => {
      const out = await unwrap(api.GET("/api/v1/requests/{key}", { params: { path: { key: requestKey } } })).catch((error) => {
        if (error instanceof ApiError && error.status === 404 && error.code === "request_not_found") return null;
        throw readFailure(error);
      });
      if (out && (out.masked || !["APPLIED", "PROCESSING"].includes(out.state))) throw new ApiError(409, "command_settled", "", [], out.id);
      return original.run();
    };
    m.mutate(original.input);
  };
  return {
    ...m,
    isSending: m.isPending,
    isChecking: outcomeUnknown(m.error),
    isPending: m.isPending || outcomeUnknown(m.error),
    requestKey: m.error instanceof ApiError ? m.error.requestKey : undefined,
    check,
    mutate: (...args: Parameters<typeof m.mutate>) => {
      if (checking.current === undefined) m.mutate(...args);
    },
    mutateAsync: (...args: Parameters<typeof m.mutateAsync>) => checking.current === undefined
      ? m.mutateAsync(...args) : Promise.reject(checking.current),
    reset: () => {
      if (checking.current !== undefined) return;
      failed.current = undefined;
      reset();
    },
  };
}
