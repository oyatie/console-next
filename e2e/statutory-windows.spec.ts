import { expect,test } from "@playwright/test";
import { expectAccessible,atPhoneWidth,fits } from "./a11y";
import { go,kstDate,registerEmployee } from "./flows";
import { soloTenant } from "./chaos";
import { setupCompany,startOperations } from "./setup-flows";
import { fillDate,signOff } from "./sheet";
import { prepareFilingCompletion,resolveFilingNotApplicable,filingRow,selectFilingFact } from "./helpers/statutory";
import type { FilingPage } from "@console/api/pending";

const addDays=(iso:string,n:number)=>new Date(Date.parse(`${iso}T00:00:00Z`)+n*86_400_000).toISOString().slice(0,10);
const nextMonthDay=(iso:string,day:number)=>{const d=new Date(`${iso}T00:00:00Z`);return new Date(Date.UTC(d.getUTCFullYear(),d.getUTCMonth()+1,day)).toISOString().slice(0,10);};

test("hire today, prepare next month's exit, and resolve truthful not-applicable filings",{tag:["@hr","@regression"]},async({browser})=>{
  const admin=await soloTenant(browser,"statwindows","신고기간회사");
  await setupCompany(admin,"신고기간회사","본사");await startOperations(admin);
  const hire=kstDate();const exit=nextMonthDay(hire,0);const futureExit=nextMonthDay(exit,28);
  await registerEmployee(admin,{name:"신고기간직원",number:"SW-1",hired:hire,unit:"본사"});
  await admin.getByRole("button",{name:"퇴직 보고",exact:true}).click();
  let dialog=admin.getByRole("dialog");await fillDate(dialog,futureExit,"마지막 근무일");await dialog.getByLabel("퇴직 경위").fill("다음 달 계약 종료");await dialog.getByRole("radiogroup",{name:/^퇴직 사유/}).getByText("개인 사정",{exact:true}).click();await dialog.getByRole("button",{name:/퇴직 보고$/}).click();await expect(dialog).toBeHidden();
  const exitPanel=admin.getByRole("region",{name:"퇴직",exact:true});await exitPanel.getByRole("button",{name:"인사 확인하고 퇴직 처리"}).click();
  dialog=admin.getByRole("dialog");await signOff(dialog.getByRole("group",{name:"확인 사항"}));await dialog.getByRole("button",{name:/인사 확인하고/}).click();await expect(dialog).toBeHidden();
  const href=await exitPanel.getByRole("link",{name:"퇴직 건 열기"}).getAttribute("href");await go(admin,href!);await admin.getByRole("region",{name:/지금/}).getByRole("button",{name:"본사 퇴직 확인"}).click();
  const read=admin.waitForResponse((r)=>(new URL(r.url()).pathname.endsWith("/statutory/insurance-filings")&&!new URL(r.url()).searchParams.has("event_id"))&&r.request().method()==="GET");
  await go(admin,"/statutory");const page=await (await read).json() as FilingPage;expect(page.total).toBe(8);
  for(const task of page.items){
    const opens=task.kind==="ACQUIRE"?hire:addDays(futureExit,1);
    expect(task.opens_on).toBe(opens);expect(task.target_on).toBe(opens);
    expect(task.due_on).toBe(task.insurer==="NHIS"?addDays(opens,13):nextMonthDay(task.kind==="ACQUIRE"?hire:futureExit,15));
    const row=filingRow(admin,task.insurer==="NPS"?"국민연금":task.insurer==="NHIS"?"건강보험":task.insurer==="EI"?"고용보험":"산재보험",task.kind==="ACQUIRE"?"취득 신고":"상실 신고");
    await expect(row).toContainText("가능일");await expect(row).toContainText("목표");
    if(task.dates?.conservative){await row.getByText("근거",{exact:true}).click();await expect(row).toContainText("보수적 기한");await expect(row).toContainText("법정 최종일 후보");}
  }
  await expectAccessible(admin,"statutory earliest window and legal deadline");await atPhoneWidth(admin,()=>fits(admin,"filing windows"));
  const loss=filingRow(admin,"국민연금","상실 신고");await loss.getByRole("button",{name:"처리 기록",exact:true}).click();dialog=admin.getByRole("dialog");await prepareFilingCompletion(admin,dialog);await fillDate(dialog,hire,"신고일");await dialog.getByRole("button",{name:"미리보기",exact:true}).click();await expect(dialog).toContainText("신고일을 확인하십시오");await dialog.getByRole("button",{name:"취소",exact:true}).click();
  const acquire=filingRow(admin,"국민연금","취득 신고");await acquire.getByRole("button",{name:"처리 기록",exact:true}).click();dialog=admin.getByRole("dialog");
  await selectFilingFact(admin,dialog,"처리 방법","미해당");await dialog.getByRole("textbox",{name:/^생년월일/}).fill("1990-01-01");await selectFilingFact(admin,dialog,"미해당 사유","연금 가입 연령 상한");await dialog.getByRole("textbox",{name:/^사유의 근거/}).fill("연령 자료 확인");await dialog.getByRole("button",{name:"미리보기",exact:true}).click();
  const refused=admin.waitForResponse((r)=>r.request().method()==="POST"&&r.url().includes("/insurance-filings/"));await dialog.getByRole("button",{name:"미해당",exact:true}).click();const refusal=await refused;expect(refusal.status()).toBe(422);expect((await refusal.json()).error.code).toBe("filing_not_applicable_invalid");await expect(dialog.getByRole("alert").last()).toBeVisible();await expect(acquire).toContainText("해야 함");await dialog.getByRole("button",{name:"수정",exact:true}).click();await dialog.getByRole("button",{name:"취소",exact:true}).click();
  await resolveFilingNotApplicable(admin,acquire);await admin.getByRole("button",{name:"처리 내역",exact:true}).click();await expect(acquire).toContainText("미해당");await expect(acquire).toContainText("공단 확인");await expect(acquire.getByText("신고일",{exact:true})).toHaveCount(0);
  await acquire.getByRole("button",{name:"되돌리기",exact:true}).click();await admin.getByRole("button",{name:"해야 함",exact:true}).click();await expect(acquire).toContainText("해야 함");
  const employment=filingRow(admin,"고용보험","취득 신고");
  await employment.getByRole("button",{name:"신고 요청·근로월 기록",exact:true}).click();dialog=admin.getByRole("dialog");
  await selectFilingFact(admin,dialog,"신고 종류","근로자 요청 취득 신고");
  await fillDate(dialog,hire,"요청일·근로월 말일");
  const requestPath=(url:URL)=>url.pathname.endsWith("/statutory/insurance-filings");
  const requestKeys:string[]=[];let dropped=false;
  await admin.route(requestPath,async(route)=>{
    if(route.request().method()!=="POST")return route.continue();
    const key=route.request().headers()["idempotency-key"];expect(key).toBeTruthy();requestKeys.push(key!);
    if(dropped)return route.continue();
    dropped=true;const response=await route.fetch();expect(response.status()).toBe(200);await route.abort("failed");
  });
  await dialog.getByRole("button",{name:"요청·근로월 기록",exact:true}).click();
  await expect(dialog.getByRole("button",{name:"다시 불러오기",exact:true})).toBeVisible();
  await expect(dialog.getByRole("button",{name:"취소",exact:true})).toBeDisabled();
  await expect(dialog.getByRole("textbox")).toHaveCount(0);
  await dialog.getByRole("button",{name:"다시 불러오기",exact:true}).click();
  await expect(dialog).toBeHidden();expect(requestKeys).toHaveLength(2);expect(requestKeys[1]).toBe(requestKeys[0]);
  await admin.unroute(requestPath);await expect(employment).toContainText("지체 없이");
});
