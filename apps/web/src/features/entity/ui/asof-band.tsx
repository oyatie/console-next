import { todayKst } from "../../../lib/pure/today";
import { AsOfControl } from "../../../ui/asof-control/asof-control";

export function AsOfBand({ asOf, knownAt, onChange }: {
  asOf?: string;
  knownAt?: string;
  onChange: (date: string, knownAt?: string) => void;
}) {
  const today = todayKst();
  return <AsOfControl today={today} value={asOf ?? today} knownAt={knownAt} onChange={onChange} entity />;
}
