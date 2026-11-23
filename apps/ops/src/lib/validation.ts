// SPDX-License-Identifier: LicenseRef-Proprietary
import { COPY } from "../copy";

const UTC_Z_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?Z$/;
const BANNED_PLACEHOLDERS = new Set(["no data", "n/a", "—"]);

function hasControlChars(s: string): boolean {
  for (const ch of s) {
    const code = ch.charCodeAt(0);
    if (code <= 31 || code === 127) return true;
  }
  return false;
}

function hasControlOrWs(s: string): boolean {
  return /\s/.test(s) || hasControlChars(s);
}

export type SilenceMatcherDraft = {
  name: string;
  value: string;
  is_equal: boolean;
  is_regex: boolean;
};

export function isValidUtcZTimestamp(raw: string): boolean {
  const m = UTC_Z_RE.exec(raw);
  if (!m) return false;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  const hour = Number(m[4]);
  const minute = Number(m[5]);
  const second = Number(m[6]);
  const ms = Date.UTC(year, month - 1, day, hour, minute, second);
  const d = new Date(ms);
  return (
    !Number.isNaN(ms) &&
    d.getUTCFullYear() === year &&
    d.getUTCMonth() + 1 === month &&
    d.getUTCDate() === day &&
    d.getUTCHours() === hour &&
    d.getUTCMinutes() === minute &&
    d.getUTCSeconds() === second
  );
}

export function buildDrillRequest(input: {
  repo: "1" | "2" | "auto";
  drillType: "name" | "time";
  target: string;
  window: "window" | "now";
}):
  | {
      ok: true;
      payload: {
        repo: "1" | "2" | "auto";
        drill_type: "name" | "time";
        target: string | null;
        window: "window" | "now";
      };
    }
  | { ok: false; error: string } {
  const trimmed = input.target.trim();
  if (trimmed && (hasControlOrWs(trimmed) || BANNED_PLACEHOLDERS.has(trimmed.toLowerCase()))) {
    return { ok: false, error: COPY.recovery.drillTargetInvalid };
  }
  if (input.drillType === "time" && (!trimmed || !isValidUtcZTimestamp(trimmed))) {
    return { ok: false, error: COPY.recovery.drillTimeUtcError };
  }
  return {
    ok: true,
    payload: {
      repo: input.repo,
      drill_type: input.drillType,
      target: trimmed || null,
      window: input.window,
    },
  };
}

export function parseMatcherLines(raw: string): SilenceMatcherDraft[] {
  return raw
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .flatMap((line) => {
      const idx = line.indexOf("=");
      if (idx <= 0) return [];
      const name = line.slice(0, idx).trim();
      const val = line.slice(idx + 1).trim().replace(/^"(.*)"$/, "$1");
      return name && val ? [{ name, value: val, is_equal: true, is_regex: false }] : [];
    });
}

export function hasWatchdogMatcher(matchers: readonly SilenceMatcherDraft[]): boolean {
  return matchers.some(
    (m) => m.name.trim().toLowerCase() === "alertname" && m.value.trim().toLowerCase() === "watchdog",
  );
}

export function validateSilenceDraft(input: {
  matchers: readonly SilenceMatcherDraft[];
  endsAt: string;
  comment: string;
  maxHours: 4 | 72;
  nowMs?: number;
}): string | null {
  if (input.matchers.length === 0) {
    return COPY.alertActions.silenceMatchersEmpty;
  }
  if (hasWatchdogMatcher(input.matchers)) {
    return COPY.alertActions.silenceWatchdogReason;
  }
  if (!input.matchers.some((m) => m.name.trim().toLowerCase() === "alertname")) {
    return COPY.alertActions.silenceAlertnameRequired;
  }
  const trimmedComment = input.comment.trim();
  if (
    trimmedComment.length < 10 ||
    hasControlChars(input.comment) ||
    BANNED_PLACEHOLDERS.has(trimmedComment.toLowerCase())
  ) {
    return COPY.alertActions.silenceCommentShort;
  }
  const trimmedEnds = input.endsAt.trim();
  if (!isValidUtcZTimestamp(trimmedEnds)) {
    return COPY.alertActions.silenceEndsAtUtcError;
  }
  const nowMs = input.nowMs ?? Date.now();
  const endsMs = Date.parse(trimmedEnds);
  if (endsMs <= nowMs) {
    return COPY.alertActions.silenceEndsAtPastError;
  }
  if (endsMs - nowMs > input.maxHours * 3_600_000) {
    return input.maxHours === 4 ? COPY.alertActions.silenceTtl4hError : COPY.alertActions.silenceTtl72hError;
  }
  return null;
}
