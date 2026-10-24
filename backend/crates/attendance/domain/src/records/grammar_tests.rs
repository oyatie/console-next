use super::*;

/// The one table both parsers run (the console's `grammar.test.ts` reads the
/// same file): a draft and the save must agree.
const FIXTURE: &str =
    include_str!("../../../../../../scripts/fixtures/attendance-grammar-cases.json");

#[derive(serde::Deserialize)]
struct Fixture {
    as_is_tokens: usize,
    as_is_refused: usize,
    cases: Vec<Case>,
    drafts: DraftFixture,
}

#[derive(serde::Deserialize)]
struct DraftFixture {
    plan_kinds: Vec<String>,
    cases: Vec<DraftCase>,
}

#[derive(serde::Deserialize)]
struct DraftCase {
    raw: Vec<String>,
    expect: String,
    #[serde(default)]
    by_plan: std::collections::HashMap<String, String>,
}

#[test]
fn every_plan_and_typed_word_resolves_as_the_shared_draft_table_says() {
    use crate::records::resolve_value;
    use crate::schedule::{DayKind, DayPlan, Shift};

    let table = fixture().drafts;
    for kind in table.plan_kinds {
        let day_kind: DayKind = serde_json::from_value(serde_json::json!(kind)).unwrap();
        let plan = DayPlan {
            kind: day_kind,
            shift: (day_kind == DayKind::Work).then_some(Shift {
                start: 540,
                end: 1080,
                breaks: vec![],
            }),
            slot_code: None,
            holiday_name: None,
            holiday_work: false,
        };
        for case in &table.cases {
            let expected = case.by_plan.get(&kind).unwrap_or(&case.expect);
            for raw in &case.raw {
                let result = resolve_value(raw, &plan, false, 960, false);
                assert_eq!(
                    result.map_or_else(|r| r.code(), |_| "ok"),
                    expected,
                    "{kind}: {raw}"
                );
            }
        }
    }
}

#[derive(serde::Deserialize)]
struct Case {
    raw: String,
    expect: String,
    long: Option<u32>,
    #[serde(default)]
    confirmed: bool,
    #[serde(default)]
    overnight: bool,
    #[serde(default)]
    as_is: bool,
}

fn fixture() -> Fixture {
    serde_json::from_str(FIXTURE).unwrap()
}

fn hhmm(m: u16) -> String {
    format!("{:02}:{:02}", m / 60, m % 60)
}

fn show(case: &Case) -> String {
    let read = parse_with_overnight(
        &case.raw,
        case.long.unwrap_or(960),
        case.confirmed,
        case.overnight,
    );
    match read {
        Err(r) => format!("refused {}", r.code()),
        Ok(Entry::Times(spans)) => format!(
            "TIMES {}",
            spans
                .iter()
                .map(|w| format!("{}-{}", hhmm(w.start), hhmm(w.end)))
                .collect::<Vec<_>>()
                .join(",")
        ),
        Ok(Entry::ClockInOnly(m)) => format!("CLOCK_IN_ONLY {}", hhmm(m)),
        Ok(Entry::ClockOutOnly(m)) => format!("CLOCK_OUT_ONLY {}", hhmm(m)),
        Ok(Entry::AsScheduled) => "AS_SCHEDULED".into(),
        Ok(Entry::Absent) => "ABSENT".into(),
        Ok(Entry::OutsideWork) => "OUTSIDE_WORK".into(),
        Ok(Entry::BusinessTrip) => "BUSINESS_TRIP".into(),
        Ok(Entry::DayOff) => "DAY_OFF".into(),
        Ok(Entry::Shift(code)) => format!("SHIFT {code}"),
        Ok(Entry::Leave(word)) => format!("LEAVE {word}"),
    }
}

#[test]
fn public_parser_keeps_the_three_argument_contract_without_a_plan() {
    use crate::records::parse;

    assert_eq!(
        parse("22-07", 960, true),
        Err(ParseRefusal::OvernightWithoutMarker)
    );
    assert_eq!(parse("22-07+", 480, false), Err(ParseRefusal::SpanTooLong));
    assert_eq!(
        parse("22-07+", 480, true),
        Ok(Entry::Times(vec![Window {
            start: 1320,
            end: 1860,
        }]))
    );
}

#[test]
fn every_fixture_case_reads_as_the_shared_table_says() {
    let table = fixture();
    let wrong: Vec<_> = table
        .cases
        .iter()
        .map(|c| (c.raw.as_str(), show(c), c.expect.as_str()))
        .filter(|(_, got, want)| got != want)
        .collect();
    assert!(table.cases.len() > 200, "fixture read");
    assert!(wrong.is_empty(), "{wrong:#?}");
}

#[test]
fn the_as_is_token_set_refuses_only_the_designed_residue() {
    let table = fixture();
    let as_is: Vec<_> = table.cases.iter().filter(|c| c.as_is).collect();
    assert_eq!(as_is.len(), table.as_is_tokens);
    let refused = as_is
        .iter()
        .filter(|c| show(c).starts_with("refused "))
        .count();
    assert_eq!(refused, table.as_is_refused);
}

#[test]
fn every_refusal_has_a_stable_code() {
    for (refusal, code) in [
        (ParseRefusal::OvertimeTyped, "overtime_typed"),
        (ParseRefusal::Unreadable, "entry_unreadable"),
        (
            ParseRefusal::OvernightWithoutMarker,
            "overnight_without_marker",
        ),
        (ParseRefusal::SpanTooLong, "span_too_long"),
        (ParseRefusal::SpansOverlap, "spans_overlap"),
        (ParseRefusal::StatusIsDerived, "status_is_derived"),
        (ParseRefusal::HoursWithoutTimes, "hours_without_times"),
        (ParseRefusal::ExcelFraction, "excel_fraction"),
        (ParseRefusal::CodeAmbiguous, "code_ambiguous"),
        (ParseRefusal::ActivityNotStored, "activity_not_stored"),
    ] {
        assert_eq!(refusal.code(), code);
    }
}

#[test]
fn clock_syntax_refuses_out_of_range_and_noncanonical_digits() {
    for raw in [
        "24:01",
        "0:60",
        "99",
        "000",
        "000:00",
        "9:000",
        "9:0",
        "9:ab",
        "ab:00",
        "0:99",
        "9.5",
        "오후 13",
        "오전 0",
        "9:30시",
        "0900시",
    ] {
        assert_eq!(clock(raw, false), None, "{raw}");
    }
    assert_eq!(clock("24:00", false), Some(1440));
    assert_eq!(clock("00:00", false), Some(0));
    assert_eq!(clock("0000", false), Some(0));
    assert_eq!(clock("09.30", false), Some(570));
    assert_eq!(clock("18시", false), Some(1080));
    assert_eq!(clock("오후 12", false), Some(720));
    assert_eq!(clock("am 12", false), Some(0));
    assert_eq!(clock("30", true), Some(1800));
    assert_eq!(clock("47:59", true), Some(2879));
    assert_eq!(clock("48", true), None);
    assert_eq!(clock("오후 30", true), None);
}

#[test]
fn normalising_folds_full_width_dashes_spaces_and_jamo() {
    assert_eq!(normalise("０９：００～１８：００"), "09:00-18:00");
    assert_eq!(normalise("\u{3000} 9 \u{2013}  18\u{feff}"), "9 - 18");
    assert_eq!(normalise("\u{1112}\u{1172}\u{1106}\u{116e}"), "휴무");
    assert_eq!(normalise("\u{110b}\u{1167}\u{11ab}"), "연");
}
