#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
//! UX-R2 ORGCHANGE over HTTP: an org change moves its people. Moving a 부서
//! to another 사업장 moves everyone placed in it (a dated 전근 each), a 폐지
//! that moves members records each one's 전보, a merge keeps its successor,
//! and a scheduled change can be cancelled, rescheduled, or applies on its
//! 시행일 by itself (regression: org-01, org-04, org-05, org-07, org-02).

#[path = "org_change_people/dissolve.rs"]
mod dissolve;
#[path = "org_change_people/ends.rs"]
mod ends;
#[path = "org_change_people/fixture.rs"]
mod fixture;
#[path = "org_change_people/follow.rs"]
mod follow;
#[path = "support/go_live.rs"]
mod go_live;
#[path = "emp_ui_routes/harness.rs"]
mod harness;
#[path = "org_change_people/held.rs"]
mod held;
#[path = "org_change_people/hired_today.rs"]
mod hired_today;
#[path = "org_change_people/schedule.rs"]
mod schedule;
