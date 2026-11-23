// SPDX-License-Identifier: LicenseRef-Proprietary
import { t } from "@console/i18n";
import { Chip } from "../../../ui/chip";
import type { AccessGrant } from "../api";
import { EnforcementChip } from "./holder";
import s from "./access.module.css";

/** The grant's state; a grant on a deactivated account reads paused with its fix, never in effect. */
export const GrantState = ({ g, fresh }: { g: AccessGrant; fresh: boolean }) =>
  !g.account_active ? (
    <div className={s.stack}>
      <Chip tone="warn">{t("accessGrants.paused")}</Chip>
      <div className={s.src}>{t("accessGrants.paused.fix")}</div>
    </div>
  ) : (
    <div className={s.chips}>
      {fresh && <Chip tone="ok">{t("accessGrants.fresh")}</Chip>}
      <EnforcementChip e={g.enforcement} />
    </div>
  );
