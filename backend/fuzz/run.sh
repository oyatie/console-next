#!/usr/bin/env bash
# Coverage-guided fuzzing (libFuzzer via cargo-fuzz) of the untrusted-input parsers.
#   backend/fuzz/run.sh                     # every target, FUZZ_SECONDS (600) each
#   FUZZ_SECONDS=60 backend/fuzz/run.sh kr-ids json-patch
# Knobs: FUZZ_JOBS (2, libFuzzer -fork workers per target; crashes are kept and the run goes
# on), FUZZ_SANITIZER (none; `address` for ASan, ~3x slower), FUZZ_RSS_MB (4096).
# Findings land in artifacts/<target>/; triage.sum counts them per panic site, and one input
# per site is minimised with `cargo fuzz tmin` (minimized-from-*). A finding becomes a
# regression #[test] in the owning crate (README.md). Exit 1 when any target
# left a crash, timeout or OOM; 2 when the build fails.
# Needs: cargo install cargo-fuzz; the nightly in rust-toolchain.toml (rustup fetches it).
set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"
secs="${FUZZ_SECONDS:-600}" jobs="${FUZZ_JOBS:-2}" san="${FUZZ_SANITIZER:-none}"
targets=("$@"); [ ${#targets[@]} -gt 0 ] || targets=($(cargo fuzz list))
cargo fuzz build -s "$san" >/dev/null 2>&1 || { cargo fuzz build -s "$san"; exit 2; }
host="$(rustc -vV | sed -n 's/^host: //p')"
load() { sysctl -n vm.loadavg | awk '{print int($2)}'; }
rc=0
for t in "${targets[@]}"; do
  while [ "$(load)" -gt 30 ]; do echo "fuzz: load $(load) > 30, waiting" >&2; sleep 30; done
  a="artifacts/$t"; mkdir -p "corpus/$t" "$a"
  extra=(); [ "$t" = xlsx-read ] && [ -d ../../docs/reference ] && extra+=(../../docs/reference)
  cargo fuzz run "$t" -s "$san" "corpus/$t" ${extra[@]+"${extra[@]}"} -- \
    -max_total_time="$secs" -fork="$jobs" -ignore_crashes=1 -ignore_timeouts=1 -ignore_ooms=1 \
    -timeout=10 -rss_limit_mb="${FUZZ_RSS_MB:-4096}" -artifact_prefix="$a/" -print_final_stats=1 \
    > "$a/run.log" 2>&1
  # Triage: one line per distinct panic site and message head.
  : > "$a/triage.txt"; : > "$a/.sigs"
  for f in "$a"/crash-* "$a"/timeout-* "$a"/oom-*; do
    [ -f "$f" ] || continue
    case "$f" in *.log) continue ;; esac
    sig="$(perl -e 'alarm shift; exec @ARGV' 20 "target/$host/release/$t" "$f" 2>&1 | rg -A1 'panicked at' | tr '\n' ' ' \
      | sed -E 's/thread [^ ]+ \([0-9]+\) panicked at //; s/\(bytes [0-9.]+ of .*//' | cut -c1-160)"
    [ -n "$sig" ] || sig="${f##*/}"; sig="${sig%%-[0-9a-f]*[0-9a-f]}"
    if ! grep -qxF -- "$sig" "$a/.sigs"; then
      echo "$sig" >> "$a/.sigs"
      cargo fuzz tmin "$t" -s "$san" "$f" -- -runs=2000 > "$f.tmin.log" 2>&1
    fi
    echo "$sig" >> "$a/triage.txt"; rc=1
  done
  sort "$a/triage.txt" | uniq -c | sort -rn > "$a/triage.sum"; rm -f "$a/.sigs"
  last="$(rg -o '#[0-9]+: cov.*' "$a/run.log" | tail -1)"
  echo "fuzz $t: ${secs}s x $jobs, corpus $(ls "corpus/$t" | wc -l | tr -d ' '), findings $(wc -l < "$a/triage.txt" | tr -d ' ') at $(wc -l < "$a/triage.sum" | tr -d ' ') sites; ${last:-no stats}"
  sed 's/^/    /' "$a/triage.sum"
done
exit "$rc"
