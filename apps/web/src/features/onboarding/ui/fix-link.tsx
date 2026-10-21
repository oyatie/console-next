import { Link } from "@tanstack/react-router";
import { t } from "@console/i18n";
import { codeText } from "../../../lib/labels";
import { fixFor } from "../domain/rail";

/** The server's remedy as a link to where it is fixed; a remedy with no screen renders nothing (its text says why). */
export function FixLink({ code, primary = false }: { code: string | null | undefined; primary?: boolean }) {
  const fix = fixFor(code);
  if (!fix || !code) return null;
  return (
    <Link to={fix.to} search={fix.search ?? {}} className={primary ? "btn btn--primary" : "btn"}>
      {codeText(`setup.fix.${code}`, t("setup.fix.open"))}
    </Link>
  );
}
