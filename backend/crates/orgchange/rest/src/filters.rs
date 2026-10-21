//! Strict effective-date query filters.
use crate::*;
use time::Date;

pub(crate) fn effective_dates(q: &ListQuery) -> Result<(Option<Date>, Option<Date>), KernelError> {
    let parse = |raw: &str| {
        if raw.len() != 10 {
            return Err(KernelError::validation(
                "effective date filters must be YYYY-MM-DD",
            ));
        }
        Date::parse(
            raw,
            time::macros::format_description!("[year]-[month]-[day]"),
        )
        .map_err(|_| KernelError::validation("effective date filters must be YYYY-MM-DD"))
    };
    let from = q.effective_from.as_deref().map(parse).transpose()?;
    let to = q.effective_to.as_deref().map(parse).transpose()?;
    if from.zip(to).is_some_and(|(from, to)| from > to) {
        return Err(KernelError::validation(
            "effective_from must be on or before effective_to; choose an ordered date range",
        ));
    }
    Ok((from, to))
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;

    #[test]
    fn effective_date_filters_accept_optional_bounds_and_reject_invalid_ranges() {
        let query = |from: Option<&str>, to: Option<&str>| {
            serde_json::from_value::<ListQuery>(json!({"effective_from": from, "effective_to": to}))
                .unwrap()
        };
        assert_eq!(effective_dates(&query(None, None)).unwrap(), (None, None));
        let date = time::macros::date!(2026 - 01 - 01);
        assert_eq!(
            effective_dates(&query(Some("2026-01-01"), None)).unwrap(),
            (Some(date), None)
        );
        assert_eq!(
            effective_dates(&query(None, Some("2026-01-01"))).unwrap(),
            (None, Some(date))
        );
        assert_eq!(
            effective_dates(&query(Some("2026-01-01"), Some("2026-01-01"))).unwrap(),
            (Some(date), Some(date))
        );
        for (from, to) in [
            ("2026-1-01", "2026-02-01"),
            ("2026-02-30", "2026-03-01"),
            ("2026-01-02", "2026-01-01"),
        ] {
            let error = effective_dates(&query(Some(from), Some(to))).err().unwrap();
            assert!(matches!(error.kind, ErrorKind::Validation));
            assert_eq!(
                RestError::kernel(error).into_response().status(),
                StatusCode::UNPROCESSABLE_ENTITY
            );
        }
    }
}
