import { Link } from "@tanstack/react-router";
import { Banner } from "../../../ui/banner/banner";
import type { PageState } from "../domain/month-state";
import { monthStateText } from "../present";

/**
 * A closed or reopened attendance month above the grid or the board. Closed is read-only and names the one way to
 * change it: the period unlock of the lock behind the close, opened on the period locks page. Reopened takes writes
 * until its unlock locks again, at the time shown.
 */
export function MonthStateBanner({ state, month }: { state: PageState; month: string }) {
  if (state.state === "OPEN") return null;
  const { text, link, unlock } = monthStateText(state, month);
  return (
    <Banner tone={state.state === "CLOSED" ? "info" : "warn"} actions={<Link to="/people/period-locks" search={unlock ? { unlock } : {}}>{link}</Link>}>
      {text}
    </Banner>
  );
}
