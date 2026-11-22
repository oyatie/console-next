import { LocaleSelect } from "../../shell/frame/locale-select";
import { ExperienceChooser } from "../../shell/frame/experience-chooser";
import { SingleKeysCheck } from "../../shell/frame/single-keys-check";
import { MePage } from "./ui/me-page";

/** Route entry for /account: the shell's controls go in as props, so ui/ never imports the shell. */
export function Account() {
  return <MePage locale={<LocaleSelect id="acct-locale" />} experience={<ExperienceChooser id="account-experience" />} singleKeys={<SingleKeysCheck />} />;
}
