// SPDX-License-Identifier: LicenseRef-Proprietary
import { useState } from "react";
import { tg } from "@console/i18n/gallery";
import { Banner } from "../banner/banner";
import { Button, Form } from "../button/button";
import { Chip } from "../chip";
import { Dialog } from "../dialog";
import { Field, TextInput } from "../field/field";
import { Skeleton } from "../skeleton/skeleton";
import { SignInPattern } from "./sign-in";
import fx from "./pattern-fixture.module.css";

const REFUSAL_REF = "sign-in-refusal";

/** Synthetic no-network showcase for SignIn (`P11`). */
export default function SignInExample({ state }: { state?: "refused" | "loading" }) {
  const [signInId, setSignInId] = useState("");
  const [otp, setOtp] = useState("");
  const [busy, setBusy] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [submittedMethod, setSubmittedMethod] = useState<"passkey" | "otp" | null>(null);
  const refusedMessage = `${REFUSAL_REF} · ${tg("pat.signIn.refused")}`;

  return (
    <SignInPattern
      title={tg("pat.signIn.title")}
      titleId="sign-in-pattern-title"
      context={<Chip>{tg("pat.signIn.context")}</Chip>}
      busy={busy}
      loading={state === "loading" ? <Skeleton bones={["title", "row", "row"]} label={tg("pat.signIn.loading")} /> : undefined}
      notices={
        state === "refused" ? (
          <Banner tone="danger" live="assertive">
            <bdi>{refusedMessage}</bdi>
          </Banner>
        ) : undefined
      }
      body={
        <Form
          className={fx.signInForm}
          onSubmit={() => {
            setBusy(true);
            setSubmittedMethod("passkey");
            setBusy(false);
          }}
        >
          <Field label={tg("pat.signIn.idLabel")} required={false}>
            {props => (
              <TextInput
                {...props}
                autoComplete="username webauthn"
                placeholder={tg("pat.signIn.idPlaceholder")}
                value={signInId}
                onChange={e => setSignInId(e.target.value)}
              />
            )}
          </Field>
          <Button type="submit" variant="primary" data-method={submittedMethod ?? undefined}>
            {tg("pat.signIn.passkeyPrimary")}
          </Button>
          <Button onClick={() => setSubmittedMethod("passkey")}>
            {tg("pat.signIn.passkeyQuick")}
          </Button>
        </Form>
      }
      secondary={
        <details className={fx.signInDetails}>
          <summary className={fx.signInSummary}>{tg("pat.signIn.codeSummary")}</summary>
          <Form
            className={fx.signInForm}
            onSubmit={() => {
              setSubmittedMethod("otp");
            }}
          >
            <Field label={tg("pat.signIn.codeLabel")} required={false}>
              {props => <TextInput {...props} className="code" value={otp} onChange={e => setOtp(e.target.value)} />}
            </Field>
            <Button type="submit">{tg("pat.signIn.codeSubmit")}</Button>
          </Form>
        </details>
      }
      foot={
        <Button variant="link" onClick={() => setHelpOpen(true)}>
          {tg("pat.signIn.cancelLink")}
        </Button>
      }
      overlays={
        <Dialog open={helpOpen} title={tg("pat.signIn.helpTitle")} onClose={() => setHelpOpen(false)}>
          <bdi>{tg("pat.signIn.helpBody")}</bdi>
        </Dialog>
      }
    />
  );
}
