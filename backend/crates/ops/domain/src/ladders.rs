// SPDX-License-Identifier: LicenseRef-Proprietary
use serde::{Deserialize, Serialize};

macro_rules! ladder {
    ($name:ident { $($variant:ident $(= $word:literal)?),+ $(,)? }) => {
        #[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
        pub enum $name { $( $(#[serde(rename = $word)])? $variant ),+ }
    };
}

// Severity order applies to Health, Drift and EvidenceState; other ladders are vocabularies.
ladder!(Health {
    Healthy,
    Progressing,
    Suspended,
    Degraded,
    Missing,
    Unknown
});
ladder!(Drift {
    Synced,
    OutOfSync,
    Unknown
});
ladder!(EvidenceState {
    Verified,
    Monitoring,
    Stale,
    Unknown
});
ladder!(PublicComponent { Operational, DegradedPerformance = "Degraded performance", PartialOutage = "Partial outage", MajorOutage = "Major outage", Maintenance, Unknown });
ladder!(AlertState {
    Firing,
    Acked,
    Silenced,
    Inhibited,
    Resolved
});
ladder!(AlertMessage { Firing = "FIRING", Update = "UPDATE", StillFiring = "STILL FIRING", Resolved = "RESOLVED" });
ladder!(Severity { Page, Ticket });
ladder!(Incident {
    Investigating,
    Identified,
    Monitoring,
    Resolved
});
ladder!(IncidentSeverity { Sev1 = "SEV1", Sev2 = "SEV2", Sev3 = "SEV3", Sev4 = "SEV4" });
ladder!(Release { Building, Signed, OnPreview = "On preview", Canary, Watching, Active, RolledBack = "Rolled back", Failed });
ladder!(Promotion { Watching, Blocked, Ready, Promoting, Superseded, IntegrationOnly = "Integration-only" });
ladder!(Credential { Ok = "OK", Due, Overdue, Unknown, Missing, Planned });
ladder!(JobState { Succeeded, Failed, Late, NeverReported = "Never reported", Running });
ladder!(Recovery { Queued, DeferredToWindow = "Deferred to window", Running, Done, Failed });
ladder!(TwoPerson { WaitingForApprover = "Waiting for approver", Approved, Refused, Expired, NotPossibleNow = "Not possible now" });
ladder!(Live {
    Live,
    Paused,
    Reconnecting,
    Offline
});
ladder!(WorkKind { Page = "page", Overdue = "overdue", Due = "due", Ticket = "ticket" });
