// SPDX-License-Identifier: LicenseRef-Proprietary
import { Link } from "@tanstack/react-router";
import { t } from "@console/i18n";
import { buttonClass, type ButtonSize } from "../../../ui/button/button-class";
import type { ApprovalViewer } from "../api";

/** Typed source references keep destination routes server-owned without accepting raw URLs. */
export function SourceViewerLink({ viewer, size = "md" }: { viewer?: ApprovalViewer | null; size?: ButtonSize }) {
  if (!viewer) return null;
  const text = t("approvals.openSource");
  const cls = buttonClass("secondary", { size });
  if (viewer.kind === "org_change") return <Link className={cls} to="/org/changes/$id" params={{ id: viewer.id }}>{text}</Link>;
  if (viewer.kind === "employee") return <Link className={cls} to="/people/$id" params={{ id: viewer.id }} search={{}}>{text}</Link>;
  if (viewer.kind === "exit_case") return <Link className={cls} to="/people/exits/$id" params={{ id: viewer.id }} search={{}}>{text}</Link>;
  if (viewer.kind === "support_session") return <Link className={cls} to="/audit/support-access" search={{ review: viewer.id }}>{text}</Link>;
  if (viewer.kind === "change_request") return <Link className={cls} to="/requests/$id" params={{ id: viewer.id }}>{text}</Link>;
  if (viewer.kind === "period_lock") return <Link className={cls} to="/people/period-locks" search={{ review: viewer.id }}>{text}</Link>;
  if (viewer.kind === "statutory") return <Link className={cls} to="/statutory" search={{ event: viewer.id }}>{text}</Link>;
  return <Link className={cls} to="/account">{text}</Link>;
}
