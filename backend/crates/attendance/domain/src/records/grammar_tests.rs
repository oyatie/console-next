use super::*;

/// The one table both parsers run (the console's `grammar.test.ts` reads the
/// same file): a draft and the save must agree.
const FIXTURE: &str =
    include_str!("../../../../../../scripts/fixtures/attendance-grammar-cases.json");

/// The fixture's JSON: objects, arrays, strings, integers and booleans. The
/// domain crate has no JSON dependency.
#[derive(Debug)]
enum Json {
    Str(String),
    Num(u32),
    Bool(bool),
    Arr(Vec<Json>),
    Obj(Vec<(String, Json)>),
}

impl Json {
    fn get(&self, key: &str) -> Option<&Self> {
        match self {
            Self::Obj(fields) => fields.iter().find(|(k, _)| k == key).map(|(_, v)| v),
            _ => None,
        }
    }
    fn str(&self, key: &str) -> Option<&str> {
        match self.get(key) {
            Some(Self::Str(s)) => Some(s),
            _ => None,
        }
    }
    fn num(&self, key: &str) -> Option<u32> {
        match self.get(key) {
            Some(Self::Num(n)) => Some(*n),
            _ => None,
        }
    }
    fn flag(&self, key: &str) -> bool {
        matches!(self.get(key), Some(Self::Bool(true)))
    }
}

struct Reader<'a> {
    chars: std::iter::Peekable<std::str::Chars<'a>>,
}

impl Reader<'_> {
    fn skip(&mut self) {
        while self.chars.next_if(|c| c.is_ascii_whitespace()).is_some() {}
    }
    fn value(&mut self) -> Option<Json> {
        self.skip();
        Some(match self.chars.peek().copied()? {
            '"' => Json::Str(self.string()?),
            '{' => {
                self.chars.next();
                let mut fields = Vec::new();
                while !self.close('}') {
                    self.skip();
                    let key = self.string()?;
                    self.skip();
                    self.chars.next_if_eq(&':')?;
                    fields.push((key, self.value()?));
                }
                Json::Obj(fields)
            }
            '[' => {
                self.chars.next();
                let mut items = Vec::new();
                while !self.close(']') {
                    items.push(self.value()?);
                }
                Json::Arr(items)
            }
            't' | 'f' => {
                let word: String =
                    std::iter::from_fn(|| self.chars.next_if(char::is_ascii_alphabetic)).collect();
                Json::Bool(word == "true")
            }
            _ => {
                let digits: String =
                    std::iter::from_fn(|| self.chars.next_if(char::is_ascii_digit)).collect();
                Json::Num(digits.parse().ok()?)
            }
        })
    }
    /// After a member: `,` continues, the closing bracket ends.
    fn close(&mut self, end: char) -> bool {
        self.skip();
        if self.chars.next_if_eq(&end).is_some() {
            return true;
        }
        self.chars.next_if_eq(&',');
        self.skip();
        self.chars.next_if_eq(&end).is_some()
    }
    fn string(&mut self) -> Option<String> {
        self.chars.next_if_eq(&'"')?;
        let mut out = String::new();
        loop {
            match self.chars.next()? {
                '"' => return Some(out),
                '\\' => match self.chars.next()? {
                    'u' => {
                        let hex: String = (0..4).filter_map(|_| self.chars.next()).collect();
                        out.push(char::from_u32(u32::from_str_radix(&hex, 16).ok()?)?);
                    }
                    'n' => out.push('\n'),
                    't' => out.push('\t'),
                    c => out.push(c),
                },
                c => out.push(c),
            }
        }
    }
}

/// The fixture, or an empty table when it does not read (the case-count
/// assertion then fails).
fn fixture() -> Json {
    Reader {
        chars: FIXTURE.chars().peekable(),
    }
    .value()
    .unwrap_or(Json::Arr(Vec::new()))
}

fn hhmm(m: u16) -> String {
    format!("{:02}:{:02}", m / 60, m % 60)
}

fn show(case: &Json) -> String {
    let read = parse(
        case.str("raw").unwrap_or_default(),
        case.num("long").unwrap_or(960),
        case.flag("confirmed"),
        case.flag("overnight"),
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

fn cases(table: &Json) -> &[Json] {
    match table.get("cases") {
        Some(Json::Arr(cases)) => cases,
        _ => &[],
    }
}

#[test]
fn every_fixture_case_reads_as_the_shared_table_says() {
    let table = fixture();
    let wrong: Vec<_> = cases(&table)
        .iter()
        .map(|c| {
            (
                c.str("raw").unwrap_or_default(),
                show(c),
                c.str("expect").unwrap_or_default(),
            )
        })
        .filter(|(_, got, want)| got != want)
        .collect();
    assert!(cases(&table).len() > 200, "fixture read");
    assert!(wrong.is_empty(), "{wrong:#?}");
}

#[test]
fn the_as_is_token_set_refuses_only_the_designed_residue() {
    let table = fixture();
    let as_is: Vec<_> = cases(&table).iter().filter(|c| c.flag("as_is")).collect();
    let count = |key| table.num(key).and_then(|n| usize::try_from(n).ok());
    assert_eq!(Some(as_is.len()), count("as_is_tokens"));
    let refused = as_is
        .iter()
        .filter(|c| show(c).starts_with("refused "))
        .count();
    assert_eq!(Some(refused), count("as_is_refused"));
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
