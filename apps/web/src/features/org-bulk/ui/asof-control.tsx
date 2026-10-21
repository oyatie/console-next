import { useNavigate } from "@tanstack/react-router";
import { AsOfControl as SharedAsOfControl } from "../../../ui/asof-control/asof-control";

/** History hands a chosen date to the composed chart's shared dated read. */
export function AsOfControl({ today }: { today: string }) {
  const navigate = useNavigate();
  return <SharedAsOfControl today={today} value={today} onChange={(as_of, known_at) => void navigate({ to: "/org", search: { as_of, known_at } })} />;
}
