import { useState, type ReactNode } from "react";
import { ChoiceField, type ChoiceOption } from "../../../ui/choice/choice-field";
import { ServerPicker } from "../../../ui/server-picker/server-picker";
import { shouldServerSearch } from "../../../ui/server-picker/size";

/**
 * One entity or workplace by id. Up to 15 options: the kit's list control. More (a retailer's stores): a search
 * picker over the options already read, so a large tenant gets a search instead of a crash or a long list.
 */
export function PickOne(p: { label: string; required: boolean; options: readonly ChoiceOption[]; value: string | null; onChange: (id: string) => void; error?: ReactNode; hint?: ReactNode; group: string; empty: string }) {
  const [query, setQuery] = useState("");
  if (!shouldServerSearch(p.options.length)) return <ChoiceField label={p.label} required={p.required} options={p.options} value={p.value} onChange={p.onChange} error={p.error} hint={p.hint} />;
  const q = query.trim();
  const hits = p.options.filter((o) => [o.label, o.description ?? ""].some((s) => s.includes(q))).map((o) => ({ id: o.value, name: o.label, display: o.content, context: o.description }));
  return (
    <div>
      <ServerPicker label={p.label} query={query} onQueryChange={setQuery} options={hits} value={p.value} onChange={(id) => id && p.onChange(id)} group={p.group} empty={p.empty} isRequired={p.required} />
      {p.error != null && <p className="alert" role="alert">{p.error}</p>}
    </div>
  );
}
