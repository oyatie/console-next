import { useNavigate } from "@tanstack/react-router";
import type { ChartNode } from "../domain/model";

/** Enter on a box: the same record. */
export function useOpenDetail() {
  const navigate = useNavigate();
  return (n: ChartNode) => {
    if (n.kind === "entity") void navigate({ to: "/org/entities/$id", params: { id: n.id } });
    else if (n.kind === "site" && n.entityId) void navigate({ to: "/org/entities/$id", params: { id: n.entityId }, search: { wp: n.id } });
  };
}
