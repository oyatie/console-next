// SPDX-License-Identifier: LicenseRef-Proprietary
import type { components } from "@console/api/ops-schema";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  deleteOpsSilence,
  opsQueryKeys,
  postOpsAlertAck,
  postOpsChangesCanary,
  postOpsChangesFreeze,
  postOpsChangesRollback,
  postOpsIncidentDeclare,
  postOpsIncidentEvent,
  postOpsIncidentPublicDraft,
  postOpsJobRerun,
  postOpsObligationEvent,
  postOpsObligationOpen,
  postOpsOncallPageTest,
  postOpsPromoteFeedback,
  postOpsPromoteRequest,
  postOpsPromoteSignoff,
  postOpsRecoveryBackup,
  postOpsRecoveryDrill,
  postOpsSilence,
  type OpsAlertDetail,
} from "./api";
import type { IncidentEventPayload, ObligationEventPayload } from "./api-types";

type S = components["schemas"];

export function useAlertAckMutation(groupKey: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: S["AckRequest"]) => postOpsAlertAck(groupKey, body),
    onSuccess: (res) => {
      qc.setQueryData<OpsAlertDetail>(opsQueryKeys.alertDetail(groupKey), {
        evaluated_at: res.evaluated_at,
        group: res.group,
      });
      void qc.invalidateQueries({ queryKey: ["ops", "alerts"], refetchType: "active" });
      void qc.invalidateQueries({ queryKey: opsQueryKeys.home, refetchType: "active" });
    },
  });
}

export function useCreateSilenceMutation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: S["SilenceCreateRequest"]) => postOpsSilence(body),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: opsQueryKeys.silences, refetchType: "active" });
      void qc.invalidateQueries({ queryKey: ["ops", "alerts"], refetchType: "active" });
      void qc.invalidateQueries({ queryKey: opsQueryKeys.home, refetchType: "active" });
    },
  });
}

export function useExpireSilenceMutation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => deleteOpsSilence(id),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: opsQueryKeys.silences, refetchType: "active" });
      void qc.invalidateQueries({ queryKey: ["ops", "alerts"], refetchType: "active" });
      void qc.invalidateQueries({ queryKey: opsQueryKeys.home, refetchType: "active" });
    },
  });
}

export function useJobRerunMutation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (name: string) => postOpsJobRerun(name),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: opsQueryKeys.actions, refetchType: "active" });
      void qc.invalidateQueries({ queryKey: opsQueryKeys.jobs, refetchType: "active" });
      void qc.invalidateQueries({ queryKey: opsQueryKeys.home, refetchType: "active" });
    },
  });
}

export function useOncallPageTestMutation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => postOpsOncallPageTest(),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: opsQueryKeys.oncall, refetchType: "active" });
      void qc.invalidateQueries({ queryKey: opsQueryKeys.actions, refetchType: "active" });
      void qc.invalidateQueries({ queryKey: opsQueryKeys.home, refetchType: "active" });
    },
  });
}

export function useDeclareIncidentMutation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: S["DeclareIncidentRequest"]) => postOpsIncidentDeclare(body),
    onSuccess: (res) => {
      qc.setQueryData(opsQueryKeys.incidentDetail(res.incident.id), res);
      void qc.invalidateQueries({ queryKey: opsQueryKeys.incidents, refetchType: "active" });
      void qc.invalidateQueries({ queryKey: opsQueryKeys.home, refetchType: "active" });
    },
  });
}

export function useIncidentEventMutation(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: IncidentEventPayload) => postOpsIncidentEvent(id, body),
    onSuccess: (res) => {
      qc.setQueryData(opsQueryKeys.incidentDetail(id), res);
      void qc.invalidateQueries({ queryKey: opsQueryKeys.incidents, refetchType: "active" });
      void qc.invalidateQueries({ queryKey: opsQueryKeys.home, refetchType: "active" });
    },
  });
}

export function useIncidentPublicDraftMutation(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: S["PublicDraftRequest"]) => postOpsIncidentPublicDraft(id, body),
    onSuccess: (res) => {
      qc.setQueryData(opsQueryKeys.incidentDetail(id), {
        evaluated_at: res.evaluated_at,
        incident: res.incident,
      });
      void qc.invalidateQueries({ queryKey: opsQueryKeys.incidents, refetchType: "active" });
      void qc.invalidateQueries({ queryKey: opsQueryKeys.actions, refetchType: "active" });
      void qc.invalidateQueries({ queryKey: opsQueryKeys.home, refetchType: "active" });
    },
  });
}

export function useChangesFreezeMutation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: S["FreezeRequest"]) => postOpsChangesFreeze(body),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: opsQueryKeys.changes, refetchType: "active" });
      void qc.invalidateQueries({ queryKey: opsQueryKeys.actions, refetchType: "active" });
      void qc.invalidateQueries({ queryKey: opsQueryKeys.home, refetchType: "active" });
    },
  });
}

export function useChangesCanaryMutation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: S["CanaryRequest"]) => postOpsChangesCanary(body),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: opsQueryKeys.changes, refetchType: "active" });
      void qc.invalidateQueries({ queryKey: opsQueryKeys.actions, refetchType: "active" });
      void qc.invalidateQueries({ queryKey: opsQueryKeys.home, refetchType: "active" });
    },
  });
}

export function useChangesRollbackMutation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: S["RollbackRequest"]) => postOpsChangesRollback(body),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: opsQueryKeys.changes, refetchType: "active" });
      void qc.invalidateQueries({ queryKey: opsQueryKeys.actions, refetchType: "active" });
      void qc.invalidateQueries({ queryKey: opsQueryKeys.home, refetchType: "active" });
    },
  });
}

export function usePromoteSignoffMutation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: S["SignoffRequest"]) => postOpsPromoteSignoff(body),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: opsQueryKeys.promote, refetchType: "active" });
      void qc.invalidateQueries({ queryKey: opsQueryKeys.home, refetchType: "active" });
    },
  });
}

export function usePromoteFeedbackMutation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: S["FeedbackRequest"]) => postOpsPromoteFeedback(body),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: opsQueryKeys.promote, refetchType: "active" });
      void qc.invalidateQueries({ queryKey: opsQueryKeys.home, refetchType: "active" });
    },
  });
}

export function usePromoteRequestMutation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: S["PromoteRequest"]) => postOpsPromoteRequest(body),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: opsQueryKeys.promote, refetchType: "active" });
      void qc.invalidateQueries({ queryKey: opsQueryKeys.actions, refetchType: "active" });
      void qc.invalidateQueries({ queryKey: opsQueryKeys.home, refetchType: "active" });
    },
  });
}

export function useRecoveryBackupMutation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: S["BackupRequest"]) => postOpsRecoveryBackup(body),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: opsQueryKeys.recovery, refetchType: "active" });
      void qc.invalidateQueries({ queryKey: opsQueryKeys.actions, refetchType: "active" });
      void qc.invalidateQueries({ queryKey: opsQueryKeys.home, refetchType: "active" });
    },
  });
}

export function useRecoveryDrillMutation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: S["DrillRequest"]) => postOpsRecoveryDrill(body),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: opsQueryKeys.recovery, refetchType: "active" });
      void qc.invalidateQueries({ queryKey: opsQueryKeys.actions, refetchType: "active" });
      void qc.invalidateQueries({ queryKey: opsQueryKeys.home, refetchType: "active" });
    },
  });
}

export function useOpenObligationMutation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: S["OpenObligationRequest"]) => postOpsObligationOpen(body),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["ops", "obligations"], refetchType: "active" });
      void qc.invalidateQueries({ queryKey: opsQueryKeys.home, refetchType: "active" });
    },
  });
}

export function useObligationEventMutation(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: ObligationEventPayload) => postOpsObligationEvent(id, body),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: opsQueryKeys.obligationDetail(id), refetchType: "active" });
      void qc.invalidateQueries({ queryKey: ["ops", "obligations"], refetchType: "active" });
      void qc.invalidateQueries({ queryKey: opsQueryKeys.home, refetchType: "active" });
    },
  });
}
