// SPDX-License-Identifier: LicenseRef-Proprietary
import { useCommand } from "../../../lib/react/command";
import { dryRun, recordImportRowIdentifier, repairImportCells } from "../api";
import type { ImportDryRun } from "../domain/contract";
import type { Picks } from "../domain/steps";

export function useCellRepairCommand(onDryRun: (d: ImportDryRun) => void) {
  const cmd = useCommand({
    run: async (args: { runId: string; sourceKey: string; field: string; value: string; picks: Picks }) => {
      await repairImportCells(args.runId, { [args.sourceKey]: { [args.field]: args.value } });
      return dryRun(args.runId, args.picks);
    },
    onSuccess: onDryRun,
  });
  return {
    run: (args: { runId: string; sourceKey: string; field: string; value: string; picks: Picks }) => cmd.mutate(args),
    isPending: cmd.isPending,
    error: cmd.error,
    reset: cmd.reset,
  };
}

export function useRowIdentifierCommand(onDryRun: (d: ImportDryRun) => void, onSexDerived?: (sex: string | undefined) => void) {
  const cmd = useCommand({
    forget: true,
    run: async (args: {
      runId: string;
      sourceKey: string;
      takeRrn: () => string;
      idType?: "RRN" | "ARC" | "DOMESTIC_RESIDENCE";
      picks: Picks;
    }) => {
      let secret = args.takeRrn();
      try {
        const res = await recordImportRowIdentifier(args.runId, args.sourceKey, {
          rrn: secret,
          ...(args.idType ? { id_type: args.idType } : {}),
        });
        const nextDry = await dryRun(args.runId, args.picks);
        return { res, nextDry };
      } finally {
        secret = "";
      }
    },
    onSuccess: ({ res, nextDry }) => {
      onSexDerived?.(res.sex_derived);
      onDryRun(nextDry);
    },
  });
  return {
    run: (args: {
      runId: string;
      sourceKey: string;
      takeRrn: () => string;
      idType?: "RRN" | "ARC" | "DOMESTIC_RESIDENCE";
      picks: Picks;
    }) => cmd.mutate(args),
    isPending: cmd.isPending,
    error: cmd.error,
    reset: cmd.reset,
  };
}
