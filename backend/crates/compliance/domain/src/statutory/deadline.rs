// SPDX-License-Identifier: LicenseRef-Proprietary
//! Display policy only; legal clocks remain in the statutory register.
pub fn severity(days: Option<i64>, due_soon_days: i64) -> &'static str {
    match days {
        Some(days) if days < 0 => "over",
        Some(days) if days <= due_soon_days => "due",
        _ => "far",
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn boundaries_follow_the_configured_window() {
        for (days, expected) in [
            (None, "far"),
            (Some(-1), "over"),
            (Some(0), "due"),
            (Some(3), "due"),
            (Some(4), "far"),
        ] {
            assert_eq!(super::severity(days, 3), expected);
        }
        assert_eq!(super::severity(Some(4), 4), "due");
    }
}
