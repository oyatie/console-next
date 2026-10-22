// SPDX-License-Identifier: LicenseRef-Proprietary
import { useState } from "react";
import { t } from "@console/i18n";
import { Field, TextInput } from "../../ui/field/field";
import { Form, Button } from "../../ui/button/button";

import { failureText } from "../refusal";
import { resolveSupportReference } from "../support-reference";

export function SupportLookup() {
  const [reference, setReference] = useState("");
  const [result, setResult] = useState<Awaited<ReturnType<typeof resolveSupportReference>>>();
  const [error, setError] = useState<unknown>();
  const [pending, setPending] = useState(false);
  const resolve = async () => {
    setError(undefined);
    setResult(undefined);
    setPending(true);
    try { setResult(await resolveSupportReference(reference)); }
    catch (failure) { setError(failure); }
    finally { setPending(false); }
  };
  return <details><summary>{t("tenants.supportLookup.title")}</summary><Form className="form" onSubmit={() => void resolve()}>
    <Field label={t("tenants.supportLookup.reference")} required={null}>{(control) => <TextInput {...control} value={reference} onChange={(e) => setReference(e.target.value)} onKeyDown={(e) => {
      if (e.key === "Enter" && !(e.nativeEvent.isComposing || e.keyCode === 229) && !pending && reference.trim()) e.currentTarget.form?.requestSubmit();
    }} />}</Field>
    <Button type="submit" disabled={pending || !reference.trim()}>{t("tenants.supportLookup.action")}</Button>
    {error ? <div role="alert">{failureText(error)}</div> : null}
    {result && <dl aria-live="polite">
      <dt>{t("tenants.supportLookup.trace")}</dt><dd className="code">{result.trace_id}</dd>
      <dt>{t("tenants.supportLookup.release")}</dt><dd>{result.release}</dd>
      <dt>{t("tenants.supportLookup.route")}</dt><dd>{result.route_template}</dd>
    </dl>}
  </Form></details>;
}
