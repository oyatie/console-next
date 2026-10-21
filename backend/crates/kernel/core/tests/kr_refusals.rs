#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
//! Negative suite for the Korean identifiers: each malformed input is refused
//! with its identifier's stable code (the REST `errors[].code`), never
//! accepted after dropping characters and never a generic code.

use console_kernel_core::KernelError;
use console_kernel_core::kr::{
    BizRegNo, CorpRegNo, Email, InsuranceMgmtNo, PhoneE164, SubWorkplaceSerial,
};

fn code<T>(r: Result<T, KernelError>) -> Option<&'static str> {
    r.err().and_then(|e| e.code)
}

/// The code a parse refused with, if it refused.
type Parse = fn(&str) -> Option<&'static str>;

#[test]
fn each_identifier_refuses_malformed_input_with_its_own_code() {
    let cases: [(&str, Parse, &[&str]); 6] = [
        (
            "brn_invalid",
            |s| code(BizRegNo::parse(s)),
            &[
                "",
                "123-45-6789",
                "123-45-678901",
                "12a-45-67890",
                "123_45_67890x",
            ],
        ),
        (
            "sub_serial_invalid",
            |s| code(SubWorkplaceSerial::parse(s)),
            &["", "12345", "abcd", "0000"],
        ),
        (
            "crn_invalid",
            |s| code(CorpRegNo::parse(s)),
            &["", "110111-123456", "110111-12345678", "11011l-1234567"],
        ),
        (
            "insurance_mgmt_no_invalid",
            |s| code(InsuranceMgmtNo::parse(s)),
            &["", "1234567", "12345678901234", "12345678x"],
        ),
        (
            "phone_invalid",
            |s| code(PhoneE164::parse(s)),
            &["", "010", "+0123456789", "1234567"],
        ),
        (
            "email_invalid",
            |s| code(Email::parse(s)),
            &[
                "",
                "a",
                "a@",
                "@b.co",
                "a x-021@example.com",
                "",
                "a",
                "a@",
                "@b.example",
                "a b@c.example",
            ],
        ),
    ];
    for (want, parse, inputs) in cases {
        for input in inputs {
            assert_eq!(parse(input), Some(want), "{input:?}");
        }
    }
}
