import { getRouteApi, Link } from "@tanstack/react-router";
import { Plus } from "lucide-react";
import { Button } from "../../../ui/button/button";
import { buttonClass } from "../../../ui/button/button-class";
import type { ChartNode } from "../domain/model";
import { addLabel } from "../present";

const route = getRouteApi("/app/org");

/** The existing add routes, or inline editing where the view supplies it. */
export function AddUnit({ n, onAdd, primary = false, icon = false }: { n: ChartNode; onAdd?: () => void; primary?: boolean; icon?: boolean }) {
  const nav = route.useNavigate();
  const label = addLabel(n);
  const content = <><Plus size={14} aria-hidden />{!icon && label}</>;
  const className = buttonClass(primary ? "primary" : "ghost", { size: "sm", icon });
  const name = { "aria-label": label, title: icon ? label : undefined };
  if (n.kind === "tenant") return <Link to="/org/entities/new" className={className} {...name}>{content}</Link>;
  if (n.kind === "entity") return <Link to="/org/entities/$id/workplaces/new" params={{ id: n.id }} className={className} {...name}>{content}</Link>;
  return <Button size="sm" icon={icon} variant={primary ? "primary" : "ghost"} {...name} onClick={onAdd ?? (() => void nav({ search: (q) => ({ ...q, sel: n.id, act: "dept-add", kind: undefined }) }))}>{content}</Button>;
}
