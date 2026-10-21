use console_kernel_core::KernelError;
use time::Date;

pub fn check_rehire_date(hire: Date, exit: Option<Date>) -> Result<(), KernelError> {
    if exit.is_some_and(|exit| hire <= exit) {
        return Err(KernelError::validation(
            "the rehire date must be later than the last exit date",
        )
        .with_code("rehire_date_not_after_exit")
        .with_field("hire_date"));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use time::macros::date;

    #[test]
    fn a_rehire_starts_after_the_prior_period_ends() {
        for hire in [date!(2026 - 10 - 11), date!(2026 - 10 - 12)] {
            let error = check_rehire_date(hire, Some(date!(2026 - 10 - 12))).err();
            assert_eq!(
                error.as_ref().and_then(|e| e.code),
                Some("rehire_date_not_after_exit")
            );
            assert_eq!(error.and_then(|e| e.field).as_deref(), Some("hire_date"));
        }
        assert!(check_rehire_date(date!(2026 - 10 - 13), Some(date!(2026 - 10 - 12))).is_ok());
        assert!(check_rehire_date(date!(2026 - 10 - 12), None).is_ok());
    }
}
