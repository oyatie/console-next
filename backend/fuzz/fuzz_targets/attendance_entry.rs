#![no_main]
use console_attendance_domain::records::{Entry, ParseRefusal, parse};
use libfuzzer_sys::fuzz_target;

fuzz_target!(|data: &[u8]| {
    let Some((&policy, bytes)) = data.split_first() else {
        return;
    };
    let Ok(raw) = std::str::from_utf8(bytes) else {
        return;
    };
    let limit = u32::from(policy) * 6 + 1;
    let confirmed = parse(raw, limit, true);
    let unconfirmed = parse(raw, limit, false);
    if let Ok(Entry::Times(spans)) = &confirmed {
        assert!(!spans.is_empty());
        assert!(spans[0].start < 1440);
        assert!(spans.iter().all(|w| w.start < w.end && w.end <= 2880));
        assert!(spans.windows(2).all(|w| w[0].end <= w[1].start));
        if u32::from(spans.last().unwrap().end - spans[0].start) > limit {
            assert_eq!(unconfirmed, Err(ParseRefusal::SpanTooLong));
        } else {
            assert_eq!(unconfirmed, confirmed);
        }
    }
});
