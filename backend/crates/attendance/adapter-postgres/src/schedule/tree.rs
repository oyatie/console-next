//! The 근무 일정 scope tree: 법인 › 사업장 › 부서 and 근무조 with people counts,
//! each node's effective layer, and who has no schedule. Nodes come in the chart's
//! order, so every picker built from them lists siblings as the chart does.

use std::collections::HashMap;

use console_attendance_application::CallerScope;
use console_attendance_application::schedule::{EffectiveLayer, ScheduleTree, TreeNode};
use console_attendance_domain::schedule::{Level, winner};
use console_kernel_core::OrgId;
use console_platform_db::with_org_conn;

use time::Date;
use uuid::Uuid;

use super::ScheduleStoreError;
use super::org::{Person, load_org, load_roster};
use super::preview::visible;
use super::universe::{Universe, today_kst};
use crate::PgAttendanceStore;

use super::read::{own_layer, summary};

impl PgAttendanceStore {
    #[tracing::instrument(skip_all, fields(node_count, people_unscheduled))]
    pub async fn schedule_tree(
        &self,
        caller: &CallerScope,
        date: Option<Date>,
    ) -> Result<ScheduleTree, ScheduleStoreError> {
        let caller = caller.clone();
        with_org_conn::<_, _, ScheduleStoreError>(
            &self.pool,
            OrgId::from_uuid(caller.org_id),
            move |tx| {
                Box::pin(async move {
                    let date = date.unwrap_or_else(today_kst);
                    let org = load_org(tx).await?;
                    let u = Universe::load(tx, org, (date.year(), date.year())).await?;
                    let roster: Vec<Person> = load_roster(tx, date, None)
                        .await?
                        .into_iter()
                        .filter(|p| visible(&caller, &u, p))
                        .collect();
                    let mut counts: HashMap<Uuid, (i64, i64)> = HashMap::new();
                    let mut unscheduled = 0;
                    for p in &roster {
                        let chain = p.unit.map(|x| u.org.chain(x)).unwrap_or_default();
                        let missing = i64::from(winner(&u.layers_for(p), date).is_none());
                        for id in [p.legal_entity_id, p.workplace_id, p.crew]
                            .into_iter()
                            .flatten()
                            .chain(chain.iter().map(|(d, _)| *d))
                        {
                            let count = counts.entry(id).or_default();
                            count.0 += 1;
                            count.1 += missing;
                        }
                        unscheduled += missing;
                    }
                    let seen =
                        |branch: Option<Uuid>| caller.org_wide || caller.permits_branch(branch);
                    let mut nodes = Vec::new();
                    let mut node = |kind: Level, id: Uuid, parent: Option<Uuid>, name: String| {
                        let effective = u.stand_in(kind, id).and_then(|p| {
                            let refs = u.layers_for(&p);
                            let win = winner(&refs, date)?;
                            let layer = u.layers.iter().find(|l| l.id == win.id)?;
                            Some(EffectiveLayer {
                                layer: summary(&u, layer),
                                from: win.level,
                            })
                        });
                        let (people, unscheduled) = counts.get(&id).copied().unwrap_or_default();
                        nodes.push(TreeNode {
                            kind,
                            id,
                            parent_id: parent,
                            workplace_id: if kind == Level::Department {
                                u.org.workplace_of_unit(id)
                            } else {
                                None
                            },
                            name,
                            people,
                            layer: own_layer(&u, kind, id, date).map(|l| summary(&u, l)),
                            effective,
                            unscheduled,
                        });
                    };
                    let workplaces: Vec<_> = u
                        .org
                        .workplaces
                        .iter()
                        .filter(|(_, w)| seen(w.branch_id))
                        .collect();
                    for (id, name) in &u.org.entities {
                        if caller.org_wide
                            || workplaces.iter().any(|(_, w)| w.legal_entity_id == *id)
                        {
                            node(Level::LegalEntity, *id, None, name.clone());
                        }
                    }
                    for (id, w) in &workplaces {
                        node(
                            Level::Workplace,
                            **id,
                            Some(w.legal_entity_id),
                            w.name.clone(),
                        );
                    }
                    for (id, unit) in u.org.units.iter().filter(|(_, x)| !x.is_site) {
                        let Some(wp) = u.org.workplace_of_unit(*id) else {
                            continue;
                        };
                        if !workplaces.iter().any(|(w, _)| **w == wp) {
                            continue;
                        }
                        let parent = unit
                            .parent
                            .filter(|p| u.org.units.get(p).is_some_and(|x| !x.is_site))
                            .unwrap_or(wp);
                        node(Level::Department, *id, Some(parent), unit.name.clone());
                    }
                    for (id, (wp, name)) in &u.org.crews {
                        if workplaces.iter().any(|(w, _)| **w == *wp) {
                            node(Level::Crew, *id, Some(*wp), name.clone());
                        }
                    }
                    // Each kind in the chart's order (siblings by their stored 순서); 근무조 by name.
                    let rank = u.org.tree_rank();
                    let at = |id: &Uuid| rank.get(id).copied().unwrap_or(usize::MAX);
                    nodes.sort_by(|a, b| {
                        (a.kind, at(&a.id), &a.name).cmp(&(b.kind, at(&b.id), &b.name))
                    });
                    tracing::Span::current().record("node_count", nodes.len());
                    tracing::Span::current().record("people_unscheduled", unscheduled);
                    Ok(ScheduleTree {
                        access_subject_employees: roster.iter().map(|p| p.id).collect(),
                        date,
                        nodes,
                        people_total: i64::try_from(roster.len()).unwrap_or(i64::MAX),
                        people_unscheduled: unscheduled,
                        holidays_loaded: u.holidays_loaded(date.year()),
                    })
                })
            },
        )
        .await
    }
}
