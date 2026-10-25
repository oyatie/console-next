import { codeText } from "../../../lib/labels";
import { CommandError } from "../../../lib/react/command-error";
import { fieldLabel, fieldRefusal } from "../present";

/** A failed entity command: a screen's own words first, then each refused field with its reason, then the shared copy. */
export function EntityError({ error, own, historyHref }: { error: unknown; historyHref?: string; own?: (code: string) => string | undefined }) {
  return <CommandError error={error} fieldLabel={fieldLabel} fieldReason={(_, code) => codeText(`entity.refusal.${code}`, "") || undefined} historyHref={historyHref} own={(code) => own?.(code) ?? fieldRefusal(error)(code)} />;
}
