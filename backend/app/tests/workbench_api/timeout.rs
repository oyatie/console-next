//! Deadline behavior is independent of the native-data PostgreSQL proof.

use super::*;

#[tokio::test(start_paused = true)]
async fn hung_source_times_out_while_other_envelopes_remain_authoritative() {
    let mut readers = ok_readers();
    readers.pending_action = true;
    let started = tokio::time::Instant::now();
    let json = serde_json::to_value(compose(&readers, context()).await.unwrap()).unwrap();
    assert_eq!(started.elapsed(), std::time::Duration::from_millis(750));
    assert_eq!(json["partial"], true);
    assert_eq!(
        json["action_inbox"],
        serde_json::json!({"status":"unavailable","code":"source_timeout"})
    );
    assert_eq!(json["todos"]["status"], "ok");
    assert_eq!(json["calendar"]["status"], "ok");
}
