import type { UseQueryResult } from "@tanstack/react-query";
import type { components } from "@console/api/schema";
import { t } from "@console/i18n";
import { Card } from "../../../ui/card/card";
import { usePasskeysContent } from "./use-passkeys-content";

/** My passkeys: add one (step-up with an existing one), remove one (step-up), never the last. */
export function PasskeysCard({ ops, passkeys }: { ops: boolean | undefined; passkeys: UseQueryResult<components["schemas"]["PasskeySummary"][]> }) {
  const { addButton, body } = usePasskeysContent({ ops, passkeys });
  return (
    <Card title={t("account.passkeys")} titleId="acct-passkeys" flush tools={addButton}>
      {body}
    </Card>
  );
}
