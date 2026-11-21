// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, test } from "vitest";
import { signInOptionalRegions } from "./sign-in-contract";
import { SignInPattern } from "./sign-in";
import { mark, renderPatternMarkup } from "./pattern-test-helpers";

test("SignInPattern renders standalone landmark, single h1, busy state, loading control withholding, and baseline fallback", async () => {
  expect(signInOptionalRegions).toEqual(["facts"]);

  const html = await renderPatternMarkup(
    <SignInPattern
      title={mark("title")}
      titleId="sign-in-title"
      context={mark("context")}
      busy
      notices={mark("notices")}
      body={mark("body")}
      secondary={mark("secondary")}
      foot={mark("foot")}
      facts={mark("facts")}
      overlays={mark("overlays")}
    />,
  );

  expect(html.match(/<main\b/g)).toHaveLength(1);
  expect(html.match(/<h1\b/g)).toHaveLength(1);
  expect(html).toContain('data-pattern="sign-in"');
  expect(html).toContain('aria-busy="true"');
  for (const region of ["title", "context", "notices", "body", "secondary", "foot", "overlays"]) {
    expect(html.split(`data-contract-region="${region}"`)).toHaveLength(2);
  }
  expect(html).not.toContain('data-contract-region="facts"');

  const submitText = "Submit";
  const baselineText = "Baseline";
  const loadingHtml = await renderPatternMarkup(
    <SignInPattern
      title={mark("title")}
      loading={mark("loading")}
      body={<button type="button">{submitText}</button>}
      secondary={mark("secondary")}
      foot={mark("foot")}
      overlays={mark("overlays")}
    />,
  );
  expect(loadingHtml).toContain('data-contract-region="loading"');
  expect(loadingHtml).toContain('data-contract-region="overlays"');
  expect(loadingHtml).not.toContain("<button");
  expect(loadingHtml).not.toContain('data-contract-region="secondary"');
  expect(loadingHtml).not.toContain('data-contract-region="foot"');

  const baselineHtml = await renderPatternMarkup(
    <SignInPattern
      title={mark("title")}
      body={mark("body")}
      baseline={() => <main data-baseline-fallback="true">{baselineText}</main>}
    />,
  );
  expect(baselineHtml).toContain('data-baseline-fallback="true"');
  expect(baselineHtml).not.toContain('data-pattern="sign-in"');
});
