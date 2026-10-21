import { useCommand } from "../../../lib/react/command";
import { refusalText } from "../present";
import { ACCESS_READS, applyGrants, previewGrants, type AccessGrant, type AccessGrantPreview, type Batch } from "../api";

/** The server refused one or more operations of a batch at preview: nothing was written, and each refusal says why. */
export class Refused extends Error {
  constructor(readonly preview: AccessGrantPreview) {
    super("preview_has_refusals");
  }
}

/**
 * The caller shows the result in its own status region (read once), so nothing is announced here.
 * A grant, revoke or end-date change as one command: preview (the server checks every operation), then apply the
 * receipt with the actor's passkey. A refusal stops before the passkey, so nobody confirms a write that cannot land.
 */
export function useGrantBatch(opts: { onSuccess?: (out: AccessGrant[], b: Batch, operationId: string) => void }) {
  const command = useCommand({
    run: async (b: Batch, key: string) => {
      const p = await previewGrants(b);
      if (p.refused) throw new Refused(p);
      return applyGrants(p.receipt_id, key);
    },
    invalidates: ACCESS_READS,
    onSuccess: (out, b) => opts.onSuccess?.(out.items, b, out.operation_id),
  });
  return { ...command, data: command.data?.items, operationId: command.data?.operation_id };
}

/** The refusals of a refused batch by operation index, for the line that sent each. */
export const refusalsOf = (e: unknown) =>
  e instanceof Refused ? new Map(e.preview.items.filter((i) => i.outcome === "REFUSED").map((i) => [i.index, refusalText(i.refusal)])) : new Map<number, string>();
