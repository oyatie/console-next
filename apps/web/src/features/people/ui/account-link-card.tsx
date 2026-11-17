// SPDX-License-Identifier: LicenseRef-Proprietary
import { lazy, Suspense } from "react";
import type { ComponentProps } from "react";
import { t } from "@console/i18n";
import { chunk } from "../../../lib/chunk-guard";
import { Card } from "../../../ui/card/card";
import { Skeleton } from "../../../ui/skeleton/skeleton";
import type { AccountLinkContent as Content } from "./account-link-content";

const AccountLinkContent = lazy(() => chunk(import("./person-act")).then(m => ({ default: m.AccountLinkContent })));

export function AccountLinkCard(props: ComponentProps<typeof Content>) {
  return <Card titleId="account" title={t("people.account.title")}>
    <Suspense fallback={<Skeleton bones={["block"]} label={t("common.loading")} />}>
      <AccountLinkContent {...props} />
    </Suspense>
  </Card>;
}
