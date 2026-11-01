import { tg } from "@console/i18n/gallery";
import { ShiftBar, ShiftBarGroup } from "./shift-bar";

export const order = 159;

/** A stay past the shift (hatched, not recognised), a day in order, and a clock-in with no clock-out. */
export default function ShiftBarGallery() {
  const plan = [{ start: 480, end: 720 }, { start: 780, end: 1020 }];
  const rows = [
    { label: tg("section.shiftBar"), scheduled: plan, recorded: [{ start: 472, end: 1150 }], recognised: plan },
    { label: tg("section.shiftBar"), scheduled: plan, recorded: [{ start: 476, end: 1024 }], recognised: plan },
    { label: tg("section.shiftBar"), scheduled: plan, recorded: [], recognised: [], open: 472 },
  ];
  return (
    <section className="card gallery__section">
      <h2 className="toolbar__title">{tg("section.shiftBar")}</h2>
      <ShiftBarGroup rows={rows} formatTime={minute => `${Math.floor(minute / 60)}:${String(minute % 60).padStart(2, "0")}`}>
        {rows.map((row, i) => <ShiftBar key={i} from={0} to={24 * 60} {...row} />)}
      </ShiftBarGroup>
    </section>
  );
}
