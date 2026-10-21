import { beforeAll, expect, test } from "vitest";
import { renderToStaticMarkup as html } from "react-dom/server";
import { loadCatalog } from "@console/i18n";
import { ListAdd, PathNote, RowActions } from "./record-actions";

beforeAll(() => loadCatalog("ko"));
const none = () => {};

test("a row's edit is named with its object and hints its path; ⋯ carries the object too", () => {
  const out = html(<RowActions field="대표전화" onEdit={none} path="approval" history={none} />);
  const edit = out.match(/<button[^>]*aria-label="대표전화 수정"[^>]*>/)![0];
  expect(edit).toMatch(/title="결재 후 반영/);
  expect(out).toContain('aria-label="대표전화 더보기"');
});

test("a blocked edit stays focusable with its reason beside it, never a bare disabled", () => {
  const out = html(<RowActions field="이름" onEdit={none} why="폐쇄한 사업장" />);
  expect(out).toMatch(/aria-label="이름 수정"[^>]*aria-disabled="true"|aria-disabled="true"[^>]*aria-label="이름 수정"/);
  expect(out).not.toMatch(/\sdisabled=/);
  expect(out).toContain("폐쇄한 사업장");
});

test("no ⋯ without history or an end; a list's add names its object; each path says its phase", () => {
  expect(html(<RowActions field="이름" onEdit={none} />)).not.toContain("더보기");
  expect(html(<ListAdd object="비상연락처" onAdd={none} />)).toContain(">비상연락처 추가<");
  expect(html(<PathNote path="setup" />)).toContain("설정 단계");
  expect(html(<PathNote path="correction" />)).toContain("정정 기록으로 남습니다");
});
