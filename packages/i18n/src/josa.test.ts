import { expect, test } from "vitest";
import { applyJosa, josa, resolveJosa } from "./josa";
import { loadCatalog, t } from "./index";

test("particles follow the final consonant", () => {
  expect(josa("정하늘", "을를")).toBe("정하늘을");
  expect(josa("윤바다", "을를")).toBe("윤바다를");
  expect(josa("채용팀", "으로로")).toBe("채용팀으로");
  expect(josa("인사부", "으로로")).toBe("인사부로");
  expect(josa("서울", "으로로")).toBe("서울로"); // ㄹ ending takes 로
  expect(josa("본사", "이가")).toBe("본사가");
  expect(josa("HK-0001", "을를")).toBe("HK-0001을");
});

test("digits and Latin endings pick the particle by their reading", () => {
  // Digits: 0, 1, 3, 6, 7, 8 have batchim; 1, 7, 8 end in ㄹ (take 로 for 으로로)
  expect(josa("HK-0001", "을를")).toBe("HK-0001을");
  expect(josa("E-000002", "으로로")).toBe("E-000002로");
  expect(josa("사무 09–18", "을를")).toBe("사무 09–18을");
  expect(josa("부서1", "이가")).toBe("부서1이");
  expect(josa("부서2", "이가")).toBe("부서2가");
  expect(josa("부서3", "을를")).toBe("부서3을");
  expect(josa("부서4", "을를")).toBe("부서4를");
  expect(josa("전체 0명", "이가")).toBe("전체 0명이");
  expect(josa("1", "으로로")).toBe("1로");
  expect(josa("3", "으로로")).toBe("3으로");
  expect(josa("7", "으로로")).toBe("7로");
  expect(josa("8", "으로로")).toBe("8로");
  expect(josa("부서10", "이가")).toBe("부서10이"); // 0 (영, 십) has batchim
  expect(josa("2020", "을를")).toBe("2020을");
  // Latin letters: L, M, N, R have batchim; L, R end in ㄹ (take 로 for 으로로)
  expect(josa("ABC", "을를")).toBe("ABC를");
  expect(josa("URL", "으로로")).toBe("URL로");
  expect(josa("URL", "을를")).toBe("URL을");
  expect(josa("IBM", "으로로")).toBe("IBM으로");
  expect(josa("VPN", "은는")).toBe("VPN은");
  expect(josa("API", "은는")).toBe("API는");
  expect(josa("PDF", "을를")).toBe("PDF를");
  // An all-capital run is read letter by letter, not as a word (HR → 에이치알, IT → 아이티).
  expect(josa("HR", "을를")).toBe("HR을");
  expect(josa("HR", "으로로")).toBe("HR로");
  expect(josa("IT", "을를")).toBe("IT를");
});

test.each([
  ["Marketing", "Marketing을"],
  ["Planning", "Planning을"],
  ["Manager", "Manager를"],
  ["Partner", "Partner를"],
  ["Center", "Center를"],
  ["Web", "Web을"],
  ["Team", "Team을"],
  ["Union", "Union을"],
  ["Back", "Back을"],
  ["Check", "Check를"], // 체크
  ["Ticket", "Ticket을"], // 티켓
  ["Socket", "Socket을"], // 소켓
  ["Café", "Café를"],
  ["José", "José를"],
  ["CAFÉ", "CAFÉ를"],
  ["Jose\u0301", "Jose\u0301를"],
  ["Group", "Group을"],
  ["Inactive", "Inactive를"],
  ["Google", "Google을"], // 구글
  ["Apple", "Apple을"], // 애플
  ["Mac", "Mac을"], // 맥
  ["Name", "Name을"], // 네임
  ["Phone", "Phone을"], // 폰
  ["Test", "Test를"], // 테스트
  ["r", "r을"], // 알
  ["x", "x를"], // 엑스
  ["Lead", "Lead를"],
  ["Sales", "Sales를"],
  ["Box", "Box를"],
  ["Company", "Company를"],
  ["Unit", "Unit을"], // 유닛
  ["Hub", "Hub를"], // 허브
  ["abc", "abc를"], // 에이비씨
  ["Chat", "Chat을"], // 챗
  ["Book", "Book을"], // 북
  ["Week", "Week를"], // 위크
  ["Sync", "Sync를"], // 싱크
  ["constructor", "constructor를"],
  ["Net", "Net을"], // 넷
  ["Git", "Git을"], // 깃
  ["Internet", "Internet을"], // 인터넷
  ["Asset", "Asset을"], // 애셋
  ["Logout", "Logout을"], // 로그아웃
  ["Boot", "Boot를"], // 부트
  ["GitHub", "GitHub를"], // 깃허브
  ["Facebook", "Facebook을"], // 페이스북
  ["Outlook", "Outlook을"], // 아웃룩
  ["KakaoTalk", "KakaoTalk을"], // 카카오톡
  ["Paycheck", "Paycheck를"], // 페이체크
  ["Desk", "Desk를"], // 데스크
])("Latin words use their word ending: %s", (word, want) => {
  expect(josa(word, "을를")).toBe(want);
  expect(resolveJosa(`${word}을(를)`)).toBe(want);
});

test.each([
  ["structure.receipt.created", { name: "Unit" }, "Unit을 추가했습니다"],
  ["structure.edit.clash", { name: "Unit" }, "같은 곳에 Unit이 이미 있습니다"],
  ["people.title.inactive", { label: "Unit" }, "Unit은 사용 중지된 항목입니다"],
  ["structure.receipt.created", { name: "Hub" }, "Hub를 추가했습니다"],
  ["structure.receipt.created", { name: "Check" }, "Check를 추가했습니다"],
  ["structure.receipt.created", { name: "Ticket" }, "Ticket을 추가했습니다"],
  ["structure.receipt.created", { name: "Socket" }, "Socket을 추가했습니다"],
  ["structure.receipt.created", { name: "UI Kit" }, "UI Kit를 추가했습니다"],
  ["structure.receipt.created", { name: "Café" }, "Café를 추가했습니다"],
  ["structure.receipt.created", { name: "José" }, "José를 추가했습니다"],
  ["structure.receipt.created", { name: "Anne" }, "Anne을 추가했습니다"],
] as const)("real catalog particles resolve in %s", async (id, values, expected) => {
  await loadCatalog("ko");
  expect(t(id, values)).toBe(expected);
});

test("Unit and Hub readings apply to every particle pair", () => {
  for (const [pair, unit, hub] of [
    ["을를", "을", "를"], ["이가", "이", "가"], ["은는", "은", "는"],
    ["과와", "과", "와"], ["으로로", "으로", "로"], ["아야", "아", "야"],
  ] as const) {
    expect(josa("Unit", pair)).toBe(`Unit${unit}`);
    expect(josa("Hub", pair)).toBe(`Hub${hub}`);
  }
});

test.each(["Anne", "Joanne", "Yvonne"])("silent nne endings apply to every particle pair: %s", (word) => {
  for (const [pair, written, particle] of [
    ["을를", "을(를)", "을"], ["이가", "이(가)", "이"], ["은는", "은(는)", "은"],
    ["과와", "과(와)", "과"], ["으로로", "(으)로", "으로"], ["아야", "아(야)", "아"],
  ] as const) {
    expect(josa(word, pair)).toBe(word + particle);
    expect(resolveJosa(word + written)).toBe(word + particle);
  }
});

test.each(["Bit", "Kit", "Hit", "Jet"])("vowel-ending t words apply to every particle pair: %s", (word) => {
  for (const [pair, written, particle] of [
    ["을를", "을(를)", "를"], ["이가", "이(가)", "가"], ["은는", "은(는)", "는"],
    ["과와", "과(와)", "와"], ["으로로", "(으)로", "로"], ["아야", "아(야)", "야"],
  ] as const) {
    expect(josa(word, pair)).toBe(word + particle);
    expect(resolveJosa(word + written)).toBe(word + particle);
  }
});

test("word readings, fullwidth characters and percent preserve the value", () => {
  expect(josa("Sales Group", "으로로")).toBe("Sales Group으로");
  expect(josa("Excel", "으로로")).toBe("Excel로");
  expect(josa("Excel", "을를")).toBe("Excel을");
  expect(josa("Inactive", "은는")).toBe("Inactive는");
  expect(josa("부서１", "이가")).toBe("부서１이");
  expect(josa("ＵＲＬ", "으로로")).toBe("ＵＲＬ로");
  expect(josa("Ｍａｒｋｅｔｉｎｇ", "을를")).toBe("Ｍａｒｋｅｔｉｎｇ을");
  expect(josa("50%", "을를")).toBe("50%를");
  expect(josa("（HK-0001）", "을를")).toBe("（HK-0001）을");
  expect(josa("Ｇｏｏｇｌｅ", "을를")).toBe("Ｇｏｏｇｌｅ을");
});

test("catalog tokens resolve against values", () => {
  expect(applyJosa("{name|을를} {unit|으로로} 전보합니다.", { name: "정하늘", unit: "채용팀" })).toBe("{name}을 {unit}으로 전보합니다.");
  expect(applyJosa("{code|을를} 발급했습니다.", { code: "HK-0001" })).toBe("{code}을 발급했습니다.");
});

test.each(["", "   ", "\t\n"])("empty input stays unchanged: %j", (word) => {
  expect(josa(word, "을를")).toBe(word);
  expect(applyJosa("{name|을를}", { name: word })).toBe("{name}");
});

test.each(["Ω", "🙂", "부서!", "「Ω」"])("unknown endings keep both particle forms: %s", (word) => {
  expect(josa(word, "을를")).toBe(`${word}을(를)`);
  expect(resolveJosa(`${word}을(를)`)).toBe(`${word}을(를)`);
  expect(applyJosa("{name|을를}", { name: word })).toBe("{name}을(를)");
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
  // Digit/Latin before it: particle chosen from the reading of digits/Latin.
  ["HK-0001을(를)", "HK-0001을"],
  ["E-000002(으)로 바꿨습니다", "E-000002로 바꿨습니다"],
  ["ABC을(를) 선택했습니다", "ABC를 선택했습니다"],
  ["Sales Group으로(로)", "Sales Group으로"],
  ["Excel으로(로)", "Excel로"],
  ["「Marketing」을(를)", "「Marketing」을"],
  ["부서１이(가)", "부서１이"],
  ["ＵＲＬ으로(로)", "ＵＲＬ로"],
  ["50%을(를)", "50%를"],
  // Full-width closers count as closers.
  ["HK-0001）을(를)", "HK-0001）을"],
  ["［ABC］을(를)", "［ABC］를"],
  ["＂Google＂(으)로", "＂Google＂로"],
  ["하늘아(야)", "하늘아"],
  ["바다아(야)", "바다야"],
  ["하늘야(아)", "하늘아"],
  ["바다야(아)", "바다야"],
  ["(으)로", "(으)로"],
  // Nothing written out: untouched.
  ["사업자등록증(원본)을 올립니다", "사업자등록증(원본)을 올립니다"],
])("resolveJosa(%s)", (text, want) => {
  expect(resolveJosa(text)).toBe(want);
});
