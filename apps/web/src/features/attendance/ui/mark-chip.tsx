import { ATTENDANCE_MARK, labeled } from "../../../lib/labels";
import { Chip } from "../../../ui/chip";
import type { Mark } from "../api";
import { GLYPH } from "../domain/day";

/** A person-day mark as a glyph and its word (▲ blocks the close, ◆ needs a decision, ● for reference); never colour only. */
export function MarkChip({ mark }: { mark: Mark }) {
  const { tone, label } = labeled(ATTENDANCE_MARK, mark);
  return <Chip tone={tone}><span aria-hidden>{tone && GLYPH[tone]}</span> {label}</Chip>;
}

/** The glyph alone with its word for a screen reader, for a dense cell. */
export function MarkGlyph({ mark }: { mark: Mark }) {
  const { tone, label } = labeled(ATTENDANCE_MARK, mark);
  return <span title={label}><span aria-hidden>{tone && GLYPH[tone]}</span><span className="sr-only">{label}</span></span>;
}
