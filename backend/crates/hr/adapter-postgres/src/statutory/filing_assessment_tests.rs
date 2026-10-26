// SPDX-License-Identifier: LicenseRef-Proprietary
use super::AssessmentCache;
use console_compliance_domain::statutory::filing::FilingFacts;
use console_hr_application::statutory::FilingInput;
use time::{Duration, macros::date};

fn input() -> FilingInput {
    FilingInput {
        kind: "ACQUIRE".into(),
        insurer: "NPS".into(),
        on: date!(2026 - 10 - 01),
        acquired_on: None,
        ended_on: None,
        requested_acquisition_on: None,
        today: date!(2026 - 10 - 26),
        facts: FilingFacts::default(),
        birth_date: None,
        employment_type: None,
        nationality: None,
        action: None,
        employment_filed: false,
        request: false,
    }
}

#[test]
fn assessment_reuse_cannot_cross_facts_dates_insurers_or_record_states() {
    let changes: [fn(&mut FilingInput); 14] = [
        |i| i.kind = "LOSE".into(),
        |i| i.insurer = "NHIS".into(),
        |i| i.on += Duration::DAY,
        |i| i.acquired_on = Some(i.on),
        |i| i.ended_on = Some(i.on),
        |i| i.requested_acquisition_on = Some(i.on),
        |i| i.today += Duration::DAY,
        |i| i.facts.monthly_income_won = Some(1),
        |i| i.birth_date = Some("1966-10-26".into()),
        |i| i.employment_type = Some("DAILY".into()),
        |i| i.nationality = Some("US".into()),
        |i| i.action = Some("COMPLETE".into()),
        |i| i.employment_filed = true,
        |i| i.request = true,
    ];
    let mut cache = AssessmentCache::new();
    cache.insert(input(), None);
    for change in changes {
        let mut other = input();
        change(&mut other);
        assert!(!cache.contains_key(&other));
    }
}
