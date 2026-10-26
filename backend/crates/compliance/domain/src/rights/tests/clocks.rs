// SPDX-License-Identifier: LicenseRef-Proprietary
use super::*;
#[test]
fn statutory_clocks_exclude_receipt_day_and_withdrawal_has_no_numeric_deadline() {
    let request = request(&[
        Kind::Access,
        Kind::Correction,
        Kind::Deletion,
        Kind::Suspension,
        Kind::Withdrawal,
    ]);
    for kind in [
        Kind::Access,
        Kind::Correction,
        Kind::Deletion,
        Kind::Suspension,
    ] {
        let due = request.kinds()[&kind].due.as_ref().unwrap();
        assert_eq!(due.on, Some(date!(2026 - 11 - 06)));
        assert!(!due.without_delay);
    }
    let due = request.kinds()[&Kind::Withdrawal].due.as_ref().unwrap();
    assert!(due.without_delay);
    assert_eq!(due.on, None);
}
#[test]
fn missing_effective_slice_preserves_receipt_with_unknown_deadline() {
    let on = date!(2026 - 09 - 10);
    let request =
        RightsRequest::receive(receipt(on), [Kind::Access], &register(), on, None).unwrap();
    assert_eq!(request.receipt().received_on, on);
    assert!(request.kinds()[&Kind::Access].due.is_none());
}
#[test]
fn register_value_controls_clock_and_weekend_does_not_roll() {
    let mut register = register();
    let mut rule = register
        .rule(codes::PIPA_ACCESS_RESPONSE_DAYS, date!(2026 - 10 - 27))
        .unwrap()
        .clone();
    rule.value_num = 11;
    register = StatutoryRegister::new(vec![rule], vec![]).unwrap();
    let request = RightsRequest::receive(
        receipt(date!(2026 - 10 - 27)),
        [Kind::Access],
        &register,
        date!(2026 - 10 - 27),
        None,
    )
    .unwrap();
    assert_eq!(
        request.kinds()[&Kind::Access].due.as_ref().unwrap().on,
        Some(date!(2026 - 11 - 07))
    );
}
