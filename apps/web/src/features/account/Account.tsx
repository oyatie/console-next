import { LocaleSelect } from "../../shell/shell";
import { MePage } from "./ui/me-page";

/** Route entry for /account: the shell's language control goes in as a prop, so ui/ never imports the shell. */
export function Account() {
  return <MePage locale={<LocaleSelect id="acct-locale" />} />;
}
