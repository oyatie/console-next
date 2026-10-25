import { AccessGate } from "../../../reference/authz/ui/access-gate";
import { Outlet, useChildMatches } from "@tanstack/react-router";
import { People } from "../People";
import { RegisterToast } from "./register-toast";
import s from "./register.module.css";

/**
 * The /people route: the People page (roster or accounts), the action a child route opens over it (the registration
 * sheet at /people/new), and the receipt of the last registration, which outlives the sheet.
 */
export function PeopleRoute() {
  // While a sheet is open it shows its own receipt; the page's would sit under the sheet's backdrop.
  const sheet = useChildMatches().length > 0;
  const content = (
    <>
      {/* On a phone the sheet covers the whole screen: the roster under it is not laid out at all (its filter row is wider
          than a phone and would scroll the page sideways behind the sheet). */}
      <div className={sheet ? `${s.pageWrap} ${s.under}` : s.pageWrap}>
        <People />
      </div>
      <Outlet />
      {!sheet && <RegisterToast />}
    </>
  );
  return sheet ? <AccessGate domain="hr_basic" level="edit" tenant>{content}</AccessGate> : content;
}
