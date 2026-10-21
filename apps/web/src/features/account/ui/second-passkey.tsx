import { useQuery } from "@tanstack/react-query";
import { KeyRound } from "lucide-react";
import { t } from "@console/i18n";
import { focusSoon } from "../../../lib/react/announce";
import { useCommand } from "../../../lib/react/command";
import { PasskeyError } from "../../../lib/react/passkey-error";
import { Button } from "../../../ui/button/button";
import { Card } from "../../../ui/card/card";
import { addPasskey, claims, meQuery, passkeysQuery } from "../api";

/**
 * One more passkey, on another device (governance-20, people-self-17): shown while this account holds exactly one, at the top
 * of My account and on Home after go-live. It says how the account gets back in if that device is lost (the ops account:
 * nobody can issue it a new code), and adds the second one in one press. Once there are two it is gone, and focus moves to
 * `focusAfter`.
 */
export function SecondPasskeyCard({ focusAfter }: { focusAfter: string }) {
  const keys = useQuery(passkeysQuery);
  const vendor = Boolean(claims()?.platform);
  const me = useQuery({ ...meQuery, enabled: !vendor });
  const add = useCommand({
    run: () => addPasskey(1),
    invalidates: ["/api/v1/auth/passkeys", "/api/v1/onboarding"],
    announce: () => t("account.passkey.added"),
    onSuccess: () => focusSoon(focusAfter),
  });
  // Drawn once both reads are in, so its words never change under the reader (the caller holds its page until then).
  if (keys.data?.length !== 1 || (!vendor && !me.data)) return null;
  return (
    <Card title={t("account.second.title")}>
      <p>{t(me.data?.is_tenant_ops ? "account.second.whyOps" : "account.second.why")}</p>
      <PasskeyError error={add.error} />
      <div>
        <Button variant="primary" disabled={add.isPending} onClick={() => add.mutate(undefined)}>
          <KeyRound size={16} aria-hidden /> {t("account.second.add")}
        </Button>
      </div>
    </Card>
  );
}
