use super::*;

fn clock_text(minutes: u16) -> String {
    format!("{}:{:02}", minutes / 60, minutes % 60)
}

#[test]
fn every_minute_round_trips_and_confirmation_changes_only_the_policy_guard() {
    for start in [0, 300, 540, 1320, 1439] {
        for duration in 1..=1440u16 {
            let end = start + duration;
            let next = end > 1440;
            let raw = format!(
                "{}-{}{}",
                clock_text(start),
                clock_text(if next { end - 1440 } else { end }),
                if next { "+" } else { "" }
            );
            for limit in [1, 480, 960, 1440] {
                let expected = Ok(Entry::Times(vec![Window { start, end }]));
                assert_eq!(parse(&raw, limit, true), expected, "{raw}");
                let unconfirmed = parse(&raw, limit, false);
                if u32::from(duration) > limit {
                    assert_eq!(unconfirmed, Err(ParseRefusal::SpanTooLong));
                } else {
                    assert_eq!(unconfirmed, expected);
                }
            }
        }
    }
}

#[test]
fn arbitrary_unicode_never_panics_or_produces_unbounded_or_overlapping_spans() {
    let alphabet = [
        '0', '1', '2', '5', '9', ':', '-', '~', ',', '/', '+', ' ', '소', '정', '\0', '💥',
    ];
    let mut state = 0x4a50_534fu64;
    for len in 0..=80 {
        for _ in 0..128 {
            let raw: String = (0..len)
                .map(|_| {
                    state = state.wrapping_mul(6364136223846793005).wrapping_add(1);
                    alphabet[(state >> 32) as usize % alphabet.len()]
                })
                .collect();
            if let Ok(Entry::Times(spans)) = parse(&raw, 960, true) {
                assert!(!spans.is_empty());
                assert!(spans[0].start < 1440);
                assert!(spans.iter().all(|w| w.start < w.end && w.end <= 2880));
                assert!(spans.windows(2).all(|w| w[0].end <= w[1].start));
            }
        }
    }
}
