import { getRouteApi, Link } from "@tanstack/react-router";
import { Plus } from "lucide-react";
import { Button } from "../../../ui/button/button";
import { buttonClass } from "../../../ui/button/button-class";
import type { ChartNode } from "../domain/model";
import { addLabel } from "../present";

const route = getRouteApi("/app/org");

/** The existing add routes, or inline editing where the view supplies it. */
export function AddUnit({ n, onAdd, primary = false }: { n: ChartNode; onAdd?: () => void; primary?: boolean }) {
  const nav = route.useNavigate();
  const content = <><Plus size={14} aria-hidden />{addLabel(n)}</>;
  const className = buttonClass(primary ? "primary" : "ghost", { size: "sm" });
  if (n.kind === "tenant") return <Link to="/org/entities/new" className={className}>{content}</Link>;
  if (n.kind === "entity") return <Link to="/org/entities/$id/workplaces/new" params={{ id: n.id }} className={className}>{content}</Link>;
  return <Button size="sm" variant={primary ? "primary" : "ghost"} onClick={onAdd ?? (() => void nav({ search: (q) => ({ ...q, sel: n.id, act: "dept-add", kind: undefined }) }))}>{content}</Button>;
}
