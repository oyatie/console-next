// SPDX-License-Identifier: LicenseRef-Proprietary
//! The retained worker register must not lose an employed row; excess retained rows are ECO-G6's count semantics.
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
    // Messages carry positions and counts only: register rows are personal data.
    let lost = employed.iter().filter(|id| !rows.contains(*id)).count();
    assert_eq!(
        lost,
        0,
        "register lost {lost} of {} employed rows at {on}",
        employed.len()
    );
    assert_eq!(page["total"].as_u64().unwrap(), rows.len() as u64);
}
