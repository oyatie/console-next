// SPDX-License-Identifier: LicenseRef-Proprietary
/* oxlint-disable react/jsx-no-literals -- Browser-only component fixture. */
import { createRoot } from "react-dom/client";
import { useState } from "react";
import { session } from "@console/api";
import { useDraft } from "../lib/react/use-draft";
import { Button } from "../ui/button/button";
import { hasUnsavedInput, installDirtyTracker } from "./dirty-guard";

// Each load starts with no stored draft: session storage outlives a reload.
sessionStorage.clear();
session.set({
  access_token: `h.${btoa(JSON.stringify({ sub: "user-1", org: "org-1" }))}.s`,
  token_type: "Bearer",
  refresh_expires_at: "2099-01-01T00:00:00Z",
  requires_passkey_setup: false,
  privacy_consent_accepted: true,
});
installDirtyTracker(document);
Object.assign(window, { hasUnsavedInput });

/** A committed plan value that only a button beside it changes, as in a sheet that moves people in bulk. */
export function Fixture() {
  const [plan, setPlan] = useState("keep");
  const draft = useDraft({ route: "/plan", record: "new", form: "plan", initial: { note: "" }, text: value => value.note });
  return (
    <main>
      <form aria-label="Plan">
        <p data-form-value={plan}>{plan}</p>
        <Button onClick={() => setPlan("move")}>Move everyone</Button>
        <Button>Preview</Button>
      </form>
      <Button onClick={() => draft.set({ note: "Half a sentence" })}>Keep a draft</Button>
    </main>
  );
}
createRoot(document.getElementById("root")!).render(<Fixture />);
