use super::*;

fn inserted_port(status: RunStatus) -> ConflictPort {
    let mut port = conflict_port(status);
    port.insert_ok = true;
    port
}

fn same_run_request(port: &ConflictPort) -> StartRunRequest {
    let mut req = request(port);
    req.run_id = port.existing.id;
    req
}

#[test]
fn inserted_run_reports_one_durable_start_after_activation_race() {
    for status in [RunStatus::Running, RunStatus::Waiting, RunStatus::Succeeded] {
        let mut port = inserted_port(status);
        port.transition_conflict = true;
        port.drive_conflict = status != RunStatus::Running;
        let result = block_on_ready(start_bound_run(
            &port,
            same_run_request(&port),
            &definition(),
            &audit_context(),
        ))
        .unwrap();
        assert_eq!(
            result,
            TriggeredStart::Started {
                run_id: port.existing.id,
                run_status: if status == RunStatus::Running {
                    RunStatus::Succeeded
                } else {
                    status
                },
            }
        );
    }
}

#[test]
fn inserted_run_reports_one_durable_start_after_drive_race() {
    let mut port = inserted_port(RunStatus::Succeeded);
    port.drive_conflict = true;
    let result = block_on_ready(start_bound_run(
        &port,
        same_run_request(&port),
        &definition(),
        &audit_context(),
    ))
    .unwrap();
    assert_eq!(
        result,
        TriggeredStart::Started {
            run_id: port.existing.id,
            run_status: RunStatus::Succeeded,
        }
    );
}

#[test]
fn lost_activation_never_hides_missing_starting_or_foreign_state() {
    for shape in ["missing", "starting", "org", "definition", "object"] {
        let mut port = inserted_port(RunStatus::Running);
        let req = same_run_request(&port);
        port.transition_conflict = true;
        match shape {
            "missing" => port.missing = true,
            "starting" => port.existing.status = RunStatus::Starting,
            "org" => port.existing.org_id = OrgId::from_uuid(Uuid::new_v4()),
            "definition" => port.existing.definition_version += 1,
            "object" => port.existing.object_id = Some(Uuid::new_v4()),
            _ => unreachable!(),
        }
        let err = block_on_ready(start_bound_run(&port, req, &definition(), &audit_context()))
            .unwrap_err();
        assert_eq!(err.kind, ErrorKind::Conflict, "{shape}");
        assert!(port.commits.lock().unwrap().is_empty());
    }
}

#[test]
fn drive_refusals_are_not_successful_starts() {
    for status in [RunStatus::Running, RunStatus::Succeeded] {
        let mut port = inserted_port(status);
        port.drive_conflict = true;
        port.drive_material_conflict = status == RunStatus::Succeeded;
        let error = block_on_ready(start_bound_run(
            &port,
            same_run_request(&port),
            &definition(),
            &audit_context(),
        ))
        .unwrap_err();
        assert_eq!(error.kind, ErrorKind::Conflict);
    }
}

#[test]
fn same_run_id_duplicate_resumes_starting_run() {
    let port = conflict_port(RunStatus::Starting);
    assert_eq!(
        block_on_ready(start_bound_run(
            &port,
            same_run_request(&port),
            &definition(),
            &audit_context(),
        ))
        .unwrap(),
        TriggeredStart::AlreadyStarted
    );
    assert_eq!(port.transitions.lock().unwrap().len(), 1);
    assert_eq!(port.commits.lock().unwrap().len(), 1);
}
