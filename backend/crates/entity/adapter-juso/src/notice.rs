use serde::Serialize;
use time::Date;

/// Days before expiry the renewal notice starts (owner rule: D-14).
pub const NOTICE_DAYS: i64 = 14;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum KeyState {
    /// Expires within [`NOTICE_DAYS`] days (or today).
    Expiring,
    /// The declared expiry date has passed: treated as no key.
    Expired,
    /// juso refused the key (E0001 / E0014) since this process started.
    Rejected,
}

/// One renewal notice: which environment variable, its state and D-n.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct KeyNotice {
    /// The environment variable that holds the key (never the key itself).
    pub env: &'static str,
    pub state: KeyState,
    #[serde(with = "iso_date_opt")]
    pub expires_on: Option<Date>,
    /// Days until expiry (negative once past); `None` without a declared date.
    pub days_left: Option<i64>,
}

/// The notice for one key, or `None` when nothing needs the operator.
#[must_use]
pub fn notice(
    env: &'static str,
    configured: bool,
    expires_on: Option<Date>,
    rejected: bool,
    today: Date,
) -> Option<KeyNotice> {
    if !configured {
        return None;
    }
    let days_left = expires_on.map(|d| (d - today).whole_days());
    let state = if rejected {
        KeyState::Rejected
    } else {
        match days_left {
            Some(n) if n < 0 => KeyState::Expired,
            Some(n) if n <= NOTICE_DAYS => KeyState::Expiring,
            _ => return None,
        }
    };
    Some(KeyNotice {
        env,
        state,
        expires_on,
        days_left,
    })
}

mod iso_date_opt {
    use serde::Serializer;
    use time::Date;
    use time::macros::format_description;

    #[allow(clippy::ref_option)]
    pub fn serialize<S: Serializer>(d: &Option<Date>, s: S) -> Result<S::Ok, S::Error> {
        match d {
            Some(d) => {
                let f = d
                    .format(format_description!("[year]-[month]-[day]"))
                    .map_err(serde::ser::Error::custom)?;
                s.serialize_some(&f)
            }
            None => s.serialize_none(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use time::macros::date;

    const TODAY: Date = date!(2026 - 10 - 05);

    #[test]
    fn notice_starts_at_d_minus_14_and_never_without_a_key() {
        let k = "STREET_JUSO_API_KEY";
        assert_eq!(
            notice(k, true, Some(date!(2026 - 10 - 20)), false, TODAY),
            None
        );
        let n = notice(k, true, Some(date!(2026 - 10 - 19)), false, TODAY).unwrap();
        assert_eq!((n.state, n.days_left), (KeyState::Expiring, Some(14)));
        let n = notice(k, true, Some(TODAY), false, TODAY).unwrap();
        assert_eq!((n.state, n.days_left), (KeyState::Expiring, Some(0)));
        let n = notice(k, true, Some(date!(2026 - 10 - 04)), false, TODAY).unwrap();
        assert_eq!((n.state, n.days_left), (KeyState::Expired, Some(-1)));
        assert_eq!(notice(k, true, None, false, TODAY), None);
        assert_eq!(
            notice(k, true, None, true, TODAY).unwrap().state,
            KeyState::Rejected
        );
        assert_eq!(notice(k, false, Some(TODAY), true, TODAY), None);
        let wire = serde_json::to_value(notice(k, true, Some(TODAY), false, TODAY)).unwrap();
        assert_eq!(wire["expires_on"], "2026-10-05");
        assert_eq!(wire["env"], k);
    }
}
