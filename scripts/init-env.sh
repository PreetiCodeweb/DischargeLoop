#!/usr/bin/env bash
# Create the local .env from docker.env.example with freshly generated secrets.
# Prompts (hidden input) for the admin and demo-staff passwords. Never overwrites an existing .env.
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
env_file="$repo_root/.env"
template="$repo_root/docker.env.example"

if [[ -e "$env_file" ]]; then
  echo "error: $env_file already exists; edit it directly or move it away first" >&2
  exit 1
fi
command -v python3 >/dev/null 2>&1 || { echo "error: python3 is required" >&2; exit 1; }

gen() { python3 -c 'import secrets; print(secrets.token_urlsafe(32))'; }

read_password() {
  local prompt="$1" value
  while true; do
    read -r -s -p "$prompt" value; echo >&2
    if [[ -z "$value" ]]; then printf '%s' ""; return; fi
    if (( ${#value} < 6 || ${#value} > 72 )); then echo "  must be 6-72 characters" >&2; continue; fi
    printf '%s' "$value"; return
  done
}

admin_pw="$(read_password 'Admin password (6-72 chars): ')"
[[ -n "$admin_pw" ]] || { echo "error: admin password is required" >&2; exit 1; }
demo_pw="$(read_password 'Demo staff password (6-72 chars, empty = no demo staff): ')"

umask 077
python3 - "$template" "$env_file" "$admin_pw" "$demo_pw" "$(gen)" "$(gen)" "$(gen)" "$(gen)" "$(gen)" <<'PY'
import sys
template, out, admin_pw, demo_pw, pg, app, mig, key, hl7 = sys.argv[1:]
values = {"DL_POSTGRES_PASSWORD": pg, "DL_APP_DB_PASSWORD": app, "DL_MIGRATION_DB_PASSWORD": mig,
          "DL_SECRET_KEY": key, "DL_HL7_INGEST_TOKEN": hl7, "DL_ADMIN_PASSWORD": admin_pw, "DL_DEMO_USER_PASSWORD": demo_pw}
lines = []
for line in open(template, encoding="utf-8"):
    name = line.split("=", 1)[0].strip()
    lines.append(f"{name}={values[name]}\n" if name in values and line.strip().endswith("=") else line)
open(out, "w", encoding="utf-8").writelines(lines)
PY
echo "created $env_file (mode 600). Secrets were generated locally and not printed."
