// SPDX-License-Identifier: LicenseRef-Proprietary
//! ECO-G6 owns the retained register: check it loses no employed rows and report excess rows separately.
use super::*;

pub(super) async fn probe(c: &Ctx, group: &Group, on: Date, employed: &[Uuid]) {
    let page = get(
        c,
        &format!(
            "/api/v1/statutory/worker-register?workplace_id={}&as_of={on}",
            group.workplace
        ),
    )
    .await;
    let rows: Vec<Uuid> = page["items"]
        .as_array()
        .unwrap()
        .iter()
        .map(|row| row["employee_id"].as_str().unwrap().parse().unwrap())
        .collect();
    for employee in employed {
        assert!(
            rows.contains(employee),
            "register lost employed {employee} at {on}: {page}"
        );
    }
    assert_eq!(page["total"].as_u64().unwrap(), rows.len() as u64);
    if rows.len() != employed.len() {
        eprintln!(
            "NEEDS-RESCOPE: backend/crates/hr/adapter-postgres/src/statutory/register.rs — ECO-G6 register at {on}: {} rows, {} employed; retained rows need explicit count semantics",
            rows.len(),
            employed.len()
        );
    }
}
