#!/usr/bin/env bash
# SPDX-License-Identifier: LicenseRef-Proprietary
# Notify adapter: Telegram Bot API, sendMessage to one chat (core.telegram.org/bots/api
# #sendmessage). Health: #getchatmember for the bot itself (its id is the token's part
# before the colon), which checks the token, the chat and that the bot may post there:
# creator, administrator (in a channel: can_post_messages) or member; restricted, left
# or kicked fails. The chat is a group, supergroup or channel (negative id).
# Contract: host/obs/notify.sh. Secrets: CONSOLE_TELEGRAM_BOT_TOKEN and
# CONSOLE_TELEGRAM_CHAT_ID from the environment (CD: scripts/notify.sh), else from the
# env file (host: Vault, optional, rendered by render-env.sh); neither = not configured
# (exit 3). The token is part of the API URL, so the URL reaches curl as a config on a
# pipe (-K), never in argv, a file or a log line.
# Severity shows: a page rings; a ticket or CD notice arrives silently
# (disable_notification), its title says which ([console page|ticket|cd]). Forum topics:
# CONSOLE_TELEGRAM_THREADS (host/settings.env, not a secret), "page:<id> ticket:<id>
# cd:<id>", posts each severity to its topic (message_thread_id); unset = the chat itself.
# Rate limits (core.telegram.org/bots/faq: ~1 message a second per chat, 20 a minute per
# group): the senders batch (one message per relay run and kind), every send is followed by
# NOTIFY_TELEGRAM_GAP seconds (1), and a 429 is retried once after its retry_after (<= 30 s).
# Run budget (notify.sh): NOTIFY_TIME_LEFT, when set, caps this call: curl's --max-time
# and a 429's wait both fit in what is left (else no retry: the fallback takes it).
set -uo pipefail
env_file="${CONSOLE_ENV_FILE:-/run/console/env}"
api="${NOTIFY_TELEGRAM_API:-https://api.telegram.org}"
get() { [[ -n "${!1:-}" ]] && { printf '%s' "${!1}"; return; }; sed -n "s/^$1=//p" "$env_file" 2>/dev/null | tail -n 1; }
usage() { echo "usage: notify-telegram.sh send SEVERITY ROUTE TITLE [LINK] <BODY | health" >&2; exit 2; }
[[ "${1:-}" == send || "${1:-}" == health ]] || usage
tok="$(get CONSOLE_TELEGRAM_BOT_TOKEN)" chat="$(get CONSOLE_TELEGRAM_CHAT_ID)"
[[ -n "$tok" && -n "$chat" ]] || exit 3
# Also keeps the curl config below well-formed (no quote can reach it).
[[ "$tok" =~ ^[0-9]+:[A-Za-z0-9_-]+$ && "$chat" =~ ^-?[0-9]+$ ]] || { echo "notify-telegram: token or chat id malformed" >&2; exit 1; }

left() { echo $((${NOTIFY_TIME_LEFT:-3600} - SECONDS)); } # seconds of the run budget left (none: an hour)
call() { # METHOD [curl args]: 0 on HTTP 200 (response in $resp); a 429 waits its retry_after once. Text: $body_file
  local out code rc after try t
  for try in 1 2; do
    rc=0 t="$(left)"
    ((t <= 10)) || t=10
    ((t >= 1)) || t=1
    out="$(curl -sS --max-time "$t" -w '\n%{http_code}' "${@:2}" <"${body_file:-/dev/null}" \
      -K <(printf 'url = "%s/bot%s/%s"\ndata = "chat_id=%s"\n' "$api" "$tok" "$1" "$chat") 2>/dev/null)" || rc=$?
    code="${out##*$'\n'}" resp="${out%$'\n'*}"
    [[ "$rc" == 0 && "$code" == 200 ]] && return 0
    after="$(jq -r '.parameters.retry_after // empty' <<<"$resp" 2>/dev/null)"
    [[ "$try" == 1 && "$code" == 429 && "$after" =~ ^[0-9]+$ && "$after" -le 30 && "$after" -lt "$(left)" ]] || break # the retry needs time too
    sleep "$after"
  done
  echo "notify-telegram: $1 failed (curl exit ${rc}, HTTP ${code:-none})" >&2
  return 1
}

if [[ "$1" == health ]]; then
  call getChatMember --data "user_id=${tok%%:*}" || exit 1
  st="$(jq -r 'if .result.status == "administrator" and .result.can_post_messages == false then "administrator without can_post_messages"
    else .result.status // "unknown" end' <<<"$resp" 2>/dev/null)"
  [[ "$st" =~ ^(creator|administrator|member)$ ]] && exit 0
  echo "notify-telegram: the bot cannot post in the chat (status ${st:-unreadable})" >&2
  exit 1
fi
thread="$(get CONSOLE_TELEGRAM_THREADS | tr ' ' '\n' | sed -n "s/^$2:\([0-9][0-9]*\)$/\1/p" | head -n 1)"
args=(--data-urlencode "text@-")
[[ "$2" == page ]] || args+=(--data disable_notification=true)
[[ -z "$thread" ]] || args+=(--data "message_thread_id=${thread}")
# Plain text (no parse_mode: nothing to escape). Telegram takes 4096 characters:
# cut at 4000 bytes, minus a split UTF-8 sequence at the end.
body_file="$(mktemp)" && trap 'rm -f "$body_file"' EXIT || exit 1
{ printf '%s\n\n' "$4"; cat; [[ -z "${5:-}" ]] || printf '\n%s' "$5"; } | head -c 4000 | iconv -c -f UTF-8 -t UTF-8 >"$body_file"
call sendMessage "${args[@]}" && { sleep "${NOTIFY_TELEGRAM_GAP:-1}"; exit 0; }
exit 1
