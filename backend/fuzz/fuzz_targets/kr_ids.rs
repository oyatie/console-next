//! Korean identifiers as typed or pasted: 사업자등록번호, 종사업장 일련번호,
//! 법인등록번호, 사업장관리번호, phone (E.164) and e-mail. Invariant: a value
//! that parses is canonical: its stored and display forms parse back to it.
#![no_main]

use console_kernel_core::kr::{
    BizRegNo, CorpRegNo, Email, InsuranceMgmtNo, PhoneE164, SubWorkplaceSerial,
};
use libfuzzer_sys::fuzz_target;

/// Known findings, skipped so the run explores past them. Each is pinned by an
/// ignored regression test (kernel/core/tests/fuzz_regressions.rs); delete the
/// line when that test passes.
fn known(stored: &str) -> bool {
    stored.starts_with("+820") // FZ-3: a `00`/`0` after +82 is stored, then re-parses to another value
}

macro_rules! canonical {
    ($ty:ty, $text:expr) => {
        if let Ok(v) = <$ty>::parse($text)
            && !known(v.as_str())
        {
            let again = <$ty>::parse(v.as_str()).expect("stored form re-parses");
            assert_eq!(again.as_str(), v.as_str(), "{:?}", $text);
            let shown = <$ty>::parse(&v.display()).expect("display form re-parses");
            assert_eq!(shown.as_str(), v.as_str(), "{:?}", $text);
        }
    };
}

fuzz_target!(|bytes: &[u8]| {
    let Ok(text) = std::str::from_utf8(bytes) else {
        return;
    };
    canonical!(BizRegNo, text);
    canonical!(SubWorkplaceSerial, text);
    canonical!(CorpRegNo, text);
    canonical!(InsuranceMgmtNo, text);
    canonical!(PhoneE164, text);
    if let Ok(v) = Email::parse(text) {
        assert_eq!(
            Email::parse(v.as_str()).map(|e| e.as_str().to_owned()),
            Ok(v.as_str().to_owned())
        );
    }
});
