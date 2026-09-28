#!/bin/sh
# Nightly pg_dump with rotation: keeps 14 dailies and 8 weeklies (Sunday) in /backups.
# Runs inside the timescale image so pg_dump matches the server major.
# Restore procedure (TimescaleDB needs pre/post restore hooks): see docs/OPERATIONS.md.
set -eu

BACKUP_HOUR="${BACKUP_HOUR:-3}"
KEEP_DAILY="${KEEP_DAILY:-14}"
KEEP_WEEKLY="${KEEP_WEEKLY:-8}"

mkdir -p /backups/daily /backups/weekly

run_backup() {
  stamp="$(date -u +%Y-%m-%dT%H%M%SZ)"
  tmp="/backups/daily/.hub-${stamp}.dump.partial"
  out="/backups/daily/hub-${stamp}.dump"
  echo "backup: starting ${out}"
  # -Fc: custom format (compressed, selective restore). Timescale internals are dumped with it.
  pg_dump -Fc --no-owner --file="${tmp}"
  mv "${tmp}" "${out}"
  if [ "$(date -u +%u)" = "7" ]; then
    cp "${out}" "/backups/weekly/"
  fi
  # Rotate: newest first, delete beyond the keep count.
  ls -1t /backups/daily/hub-*.dump 2>/dev/null | tail -n +"$((KEEP_DAILY + 1))" | xargs -r rm -f
  ls -1t /backups/weekly/hub-*.dump 2>/dev/null | tail -n +"$((KEEP_WEEKLY + 1))" | xargs -r rm -f
  echo "backup: done ${out}"
}

if [ "${1:-}" = "--once" ]; then
  run_backup
  exit 0
fi

while :; do
  now_h="$(date -u +%H | sed 's/^0//')"
  if [ "${now_h:-0}" = "${BACKUP_HOUR}" ]; then
    run_backup || echo "backup: FAILED" >&2
    sleep 3700
  else
    sleep 600
  fi
done
