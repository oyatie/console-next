use super::*;

fn times(v: &str) -> Vec<(u16, u16)> {
    // A value that does not parse as times reads as no spans, so the assert names it.
    match parse(v, 960, false) {
        Ok(Entry::Times(spans)) => spans.into_iter().map(|w| (w.start, w.end)).collect(),
        _ => Vec::new(),
    }
}

#[test]
fn the_spec_table_reads_as_spans() {
    let day = vec![(540, 1080)];
    for v in ["9-18", "0900-1800", "09:00~18:00", " 9 - 18 "] {
        assert_eq!(times(v), day, "{v}");
    }
    assert_eq!(times("9:30-18:15"), vec![(570, 1095)]);
    assert_eq!(times("6:50-16"), vec![(410, 960)], "H:MM-H");
    assert_eq!(times("22-6+"), vec![(1320, 1800)]);
    assert_eq!(times("9-12,13:30-18"), vec![(540, 720), (810, 1080)]);
    assert_eq!(times("9-18/90"), vec![(540, 765), (855, 1080)]);
    assert_eq!(times("21-24"), vec![(1260, 1440)]);
}

#[test]
fn codes_and_clock_in_only() {
    assert_eq!(parse("=", 960, false), Ok(Entry::AsScheduled));
    assert_eq!(parse("소정", 960, false), Ok(Entry::AsScheduled));
    assert_eq!(parse("x", 960, false), Ok(Entry::Absent));
    assert_eq!(parse("결근", 960, false), Ok(Entry::Absent));
    assert_eq!(parse("o", 960, false), Ok(Entry::OutsideWork));
    assert_eq!(parse("출장", 960, false), Ok(Entry::BusinessTrip));
    assert_eq!(parse("7:52-", 960, false), Ok(Entry::ClockInOnly(472)));
}

#[test]
fn refusals_name_their_reason() {
    let cases = [
        ("+2", "overtime_typed"),
        ("18+2", "overtime_typed"),
        ("9-18+2", "overtime_typed"),
        ("6:5O-16", "entry_unreadable"),
        ("7:48-5:10", "overnight_without_marker"),
        ("22-6", "overnight_without_marker"),
        ("9-13,12-18", "spans_overlap"),
        ("", "entry_unreadable"),
        ("9:7-18", "entry_unreadable"),
        ("25-26", "entry_unreadable"),
        ("9-18/600", "entry_unreadable"),
        ("9-18/0", "entry_unreadable"),
        ("3~4/59", "entry_unreadable"),
    ];
    for (v, code) in cases {
        assert_eq!(parse(v, 960, false).map_err(|e| e.code()), Err(code), "{v}");
    }
}

#[test]
fn long_spans_require_acknowledgement_under_the_supplied_policy() {
    for raw in ["5-23", "5-12,13-23", "22-15+", "22-24,1-15+"] {
        assert_eq!(
            parse(raw, 960, false),
            Err(ParseRefusal::SpanTooLong),
            "{raw}"
        );
        assert!(
            matches!(parse(raw, 960, true), Ok(Entry::Times(_))),
            "{raw}"
        );
    }
    assert_eq!(ParseRefusal::SpanTooLong.code(), "span_too_long");
    assert_eq!(
        parse(&format!("{}x", " ".repeat(40)), 960, true),
        Err(ParseRefusal::Unreadable)
    );
    assert!(parse("5-21", 960, false).is_ok());
    assert_eq!(parse("5-21:01", 960, false), Err(ParseRefusal::SpanTooLong));
    assert!(parse("5-23", 1080, false).is_ok());
    assert_eq!(parse("9-18", 480, false), Err(ParseRefusal::SpanTooLong));
    assert_eq!(
        parse("9-13,12-18", 960, true),
        Err(ParseRefusal::SpansOverlap)
    );
    assert_eq!(
        parse("22-6", 960, true),
        Err(ParseRefusal::OvernightWithoutMarker)
    );
    assert_eq!(parse("24-6+", 960, true), Err(ParseRefusal::Unreadable));
    assert_eq!(parse("5-23/2000", 960, true), Err(ParseRefusal::Unreadable));
}

#[test]
fn regression_fz6_break_leaves_positive_time_on_both_sides() {
    assert_eq!(parse("3~4/59", 960, true), Err(ParseRefusal::Unreadable));
    assert_eq!(times("3~4/58"), vec![(180, 181), (239, 240)]);
}

#[test]
fn regression_fz7_next_day_marker_cannot_create_a_zero_length_midnight_span() {
    assert_eq!(
        parse("0~1,1~9,9~10,10~11,24-0+", 1440, true),
        Err(ParseRefusal::Unreadable)
    );
    assert_eq!(
        parse("9-18,24-0+", 1440, true),
        Err(ParseRefusal::Unreadable)
    );
}

#[test]
fn clock_syntax_refuses_out_of_range_and_noncanonical_digits() {
    for raw in [
        "24:01", "0:60", "99", "000", "000:00", "9:000", "9:0", "9:ab", "ab:00", "0:99",
    ] {
        assert_eq!(clock(raw), None, "{raw}");
    }
    assert_eq!(clock("24:00"), Some(1440));
    assert_eq!(clock("00:00"), Some(0));
    assert_eq!(clock("0000"), Some(0));
    assert_eq!(
        parse(&format!("{}x", " ".repeat(39)), 960, false),
        Ok(Entry::Absent)
    );
    assert_eq!(parse("24-", 960, true), Err(ParseRefusal::Unreadable));
    assert_eq!(
        times("22-24,1-2,3-4+"),
        vec![(1320, 1440), (1500, 1560), (1620, 1680)]
    );
    assert_eq!(times("9-12,12-18+"), vec![(540, 720), (720, 1080)]);
    assert_eq!(
        parse("0-1,23-24,0-24+", 1440, true),
        Ok(Entry::Times(vec![
            Window { start: 0, end: 60 },
            Window {
                start: 1380,
                end: 1440
            },
            Window {
                start: 1440,
                end: 2880
            }
        ]))
    );
}
