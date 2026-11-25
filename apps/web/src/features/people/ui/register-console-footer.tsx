// SPDX-License-Identifier: LicenseRef-Proprietary
import { Link } from "@tanstack/react-router";
import { ArrowUpRight } from "lucide-react";
import { t } from "@console/i18n";
import { modHint } from "../../../lib/mod-hint";
import { Button, Check } from "../../../ui/button/button";
import { buttonClass } from "../../../ui/button/button-class";
import { commitLabel } from "../../../ui/composer/actions";
import { Kbd } from "../../../ui/kbd/kbd";
import s from "./register-console.module.css";

export function RegisterConsoleFooter({
  createMore,
  onCreateMore,
  disabled,
  incomplete,
  onSubmit,
}: {
  createMore: boolean;
  onCreateMore: (next: boolean) => void;
  disabled: boolean;
  incomplete?: boolean;
  onSubmit: () => void;
}) {
  return (
    <div className={s.row}>
      <div className={s.meta}>
        <Link to="/people/import" className={buttonClass("ghost", { size: "sm" })}>
          {t("register.manyShort")}
          <ArrowUpRight size={14} aria-hidden />
        </Link>
        <Check switch checked={createMore} onChange={onCreateMore}>
          {t("register.createMore")}
        </Check>
      </div>
      {/* Classic's two register buttons, one at a time: the switch picks which this one is, and it says so. */}
      <Button variant="primary" aria-disabled={incomplete} disabled={disabled} onClick={onSubmit}>
        {commitLabel({ kind: "ONBOARD", mode: "apply", count: 1, continuation: createMore ? "next" : undefined })}
        <Kbd keys={modHint("↵")} />
      </Button>
    </div>
  );
}
