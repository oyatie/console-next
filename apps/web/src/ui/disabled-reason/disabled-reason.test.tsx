import { expect, test } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { Button } from "../button/button";
import { DisabledReason } from "./disabled-reason";

test("the inert control is a focusable non-submit button described by its reason", () => {
  // A caller that forgot and passed a submit type: the spread props still win.
  const caller = { type: "submit" as const, variant: "danger" as const };
  const [x, fix] = ["x", "fix"];
  const html = renderToStaticMarkup(
    <DisabledReason control={(p) => <Button {...caller} {...p}>{x}</Button>} reason="why" remedy={<Button>{fix}</Button>} />,
  );
  const control = html.match(/<button[^>]*>x<\/button>/)![0];
  expect(control).toContain('type="button"');
  expect(control).toContain('aria-disabled="true"');
  expect(control).not.toMatch(/\sdisabled=/);
  const id = control.match(/aria-describedby="([^"]+)"/)![1];
  expect(html).toContain(`id="${id}">why<`);
});


test("a reason can share a failure action area without wrapping its toolbar control", () => {
  const [create, retry] = ["create", "retry"];
  const html = renderToStaticMarkup(
    <DisabledReason control={p => <Button {...p}>{create}</Button>} reason="why" remedy={<Button>{retry}</Button>}>
      {({ control, reason }) => <><header>{control}</header><section>{reason}</section></>}
    </DisabledReason>,
  );
  const control = html.match(/<header>(.*?)<\/header>/)![1]!;
  const id = control.match(/aria-describedby="([^"]+)"/)![1];
  expect(control).toContain('aria-disabled="true"');
  expect(control).not.toContain("why");
  expect(html).toContain(`<section><span`);
  expect(html).toContain(`id="${id}">why<`);
  expect(html).toMatch(/<section>[\s\S]*>retry<\/button><\/span><\/section>/);
});
