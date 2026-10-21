import { expect, test } from "vitest";
import { applyJosa, josa, resolveJosa } from "./josa";

test("particles follow the final consonant", () => {
  expect(josa("정하늘", "을를")).toBe("정하늘을");
  expect(josa("윤바다", "을를")).toBe("윤바다를");
  expect(josa("채용팀", "으로로")).toBe("채용팀으로");
  expect(josa("인사부", "으로로")).toBe("인사부로");
  expect(josa("서울", "으로로")).toBe("서울로"); // ㄹ ending takes 로
  expect(josa("본사", "이가")).toBe("본사가");
  expect(josa("HK-0001", "을를")).toBe("HK-0001을(를)");
});

test("catalog tokens resolve against values", () => {
  expect(applyJosa("{name|을를} {unit|으로로} 전보합니다.", { name: "정하늘", unit: "채용팀" })).toBe("{name}을 {unit}으로 전보합니다.");
});

// regression (hire-37): catalogs that write the fallback out (「{fields}은(는)」, 「{source}(으)로」) showed it on screen.
test.each([
  ["입사일은(는) 다른 인사 담당자가 확인해야 바뀝니다", "입사일은 다른 인사 담당자가 확인해야 바뀝니다"],
  ["입사일·고용 형태은(는) 바뀝니다", "입사일·고용 형태는 바뀝니다"],
  ["명부 가져오기(으)로 기록했습니다", "명부 가져오기로 기록했습니다"],
  ["사번을 김해(으)로 바꿨습니다", "사번을 김해로 바꿨습니다"],
  ["서울(으)로", "서울로"],
  ["본사(으)로", "본사로"],
  ["채용팀(으)로", "채용팀으로"],
  ["「영업팀」을(를) 목록에 넣었습니다", "「영업팀」을 목록에 넣었습니다"],
  ["“과장”을(를) 넣었습니다", "“과장”을 넣었습니다"],
  ["본사(서울)(으)로", "본사(서울)로"],
  ["직원(정규직)이(가) 있습니다", "직원(정규직)이 있습니다"],
  ["오송공장과(와) 본사", "오송공장과 본사"],
  // Not Hangul before it: both forms stay, as josa() writes them.
  ["HK-0001을(를)", "HK-0001을(를)"],
  ["E-000002(으)로 바꿨습니다", "E-000002(으)로 바꿨습니다"],
  ["(으)로", "(으)로"],
  // Nothing written out: untouched.
  ["사업자등록증(원본)을 올립니다", "사업자등록증(원본)을 올립니다"],
])("resolveJosa(%s)", (text, want) => {
  expect(resolveJosa(text)).toBe(want);
});
