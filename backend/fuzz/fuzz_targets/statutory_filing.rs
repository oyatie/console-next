#![no_main]
use console_compliance_domain::statutory::filing::{
    FilingAnchors, FilingFacts, FilingRule, applies, dates,
};
use console_hr_domain::text::parse_yyyy_mm_dd as parse_date;
use libfuzzer_sys::fuzz_target;
use serde_json::Value;

fuzz_target!(|data: &[u8]| {
    let Ok(v) = serde_json::from_slice::<Value>(data) else {
        return;
    };
    let Some(on) = v
        .get("on")
        .and_then(Value::as_str)
        .and_then(|s| parse_date(s).ok())
    else {
        return;
    };
    let (Ok(rule), Ok(facts)) = (
        serde_json::from_value::<FilingRule>(v["rule"].clone()),
        serde_json::from_value::<FilingFacts>(v["facts"].clone()),
    ) else {
        return;
    };
    let anchors = FilingAnchors {
        effective_date: Some(on),
        acquire_date: Some(on),
        loss_date: on.next_day(),
        exit_date: Some(on),
        request_date: Some(on),
        work_month: Some(on),
    };
    if let Ok(d) = dates(&rule, &anchors, &[]) {
        assert_eq!(d.opens_on, d.target_on);
    }
    let _ = applies(&rule, &anchors, &facts);
});
