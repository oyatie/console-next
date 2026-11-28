// SPDX-License-Identifier: LicenseRef-Proprietary
import { Link } from "@tanstack/react-router";
import { ClipboardPaste, ListPlus } from "lucide-react";
import { t } from "@console/i18n";
import { modHint } from "../../../lib/mod-hint";
import { Button } from "../../../ui/button/button";
import { buttonClass } from "../../../ui/button/button-class";
import { commitLabel } from "../../../ui/composer/actions";
import { Kbd } from "../../../ui/kbd/kbd";
import s from "./register.module.css";

export function RegisterClassicFooter({ disabled, onSubmit }: { disabled: boolean; onSubmit: () => void }) {
  return (
    <>
      <Link to="/people/import" className={buttonClass("ghost", { className: s.many })}><ClipboardPaste size={16} aria-hidden />{t("register.many")}</Link>
      <Link to="/people/run" className={buttonClass("ghost")}><ListPlus size={16} aria-hidden />{t("register.run.open")}</Link>
      <Button disabled={disabled} onClick={onSubmit}>{commitLabel({ kind: "ONBOARD", mode: "apply", count: 1 })}<Kbd keys={modHint("⇧↵")} /></Button>
    </>
  );
}
