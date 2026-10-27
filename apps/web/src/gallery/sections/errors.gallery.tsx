import { ApiError } from "@console/api";
import { tg } from "@console/i18n/gallery";
import { CommandError } from "../../lib/react/command-error";
import { failure } from "../fixtures";
import { Section } from "../Section";

export const order = 40;

export default function Errors() {
  const rejection = new ApiError(422, "lifecycle_signoff_required", tg("command.message"), ["payroll_cutoff_ack", "retirement_settlement_ack"], "op_01JGALLERY0000000000000002");
  const uncertain = new ApiError(0, "command_unknown", "", [], undefined, false, [], { requestKey: "gallery-command-intent" });
  return (
    <Section title={tg("section.errors")}>
      <CommandError error={rejection} />
      <CommandError error={failure()} />
      <CommandError error={uncertain} />
    </Section>
  );
}
