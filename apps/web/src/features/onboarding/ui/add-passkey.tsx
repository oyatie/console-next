import { t } from "@console/i18n";
import { useCommand } from "../../../lib/react/command";
import { PasskeyError } from "../../../lib/react/passkey-error";
import { Button } from "../../../ui/button/button";
import { addPasskey, SETUP_READS } from "../api";

/** One more passkey, added here (governance-20): a step-up with the one this account holds, then the new device. */
export function AddPasskey({ count, primary = false }: { count: number; primary?: boolean }) {
  const run = useCommand({ run: () => addPasskey(count), invalidates: [...SETUP_READS, "/api/v1/auth/passkeys"], announce: () => t("setup.passkey.added") });
  return (
    <>
      <Button variant={primary ? "primary" : undefined} disabled={run.isPending} onClick={() => run.mutate(undefined)}>{t("setup.fix.add_passkey")}</Button>
      <PasskeyError error={run.error} />
    </>
  );
}

