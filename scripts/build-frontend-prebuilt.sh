#!/usr/bin/env bash
# Build the Next.js standalone output on the host and stage it for frontend/Dockerfile.prebuilt.
# Use when the Docker build cannot reach registry.npmjs.org (e.g. restricted corporate networks).
# Requires frontend/node_modules to be installed already (npm ci on a network that allows it).
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
frontend="$repo_root/frontend"
staging="$frontend/.prebuilt"

if [[ ! -d "$frontend/node_modules/next" ]]; then
  echo "error: $frontend/node_modules is missing; run 'npm ci' in frontend/ on an unrestricted network first" >&2
  exit 1
fi

cd "$frontend"
# Rewrites are serialized at build time, so the in-network backend address is baked in here.
NEXT_TELEMETRY_DISABLED=1 BACKEND_URL="${BACKEND_URL:-http://backend:8000}" npm run build

# Recreate only the script-owned staging directory.
rm -rf "$staging"
mkdir -p "$staging"
cp -R .next/standalone "$staging/standalone"
cp -R .next/static "$staging/static"
cp -R public "$staging/public"

# Output tracing copies the host's macOS-only sharp binaries; they cannot load in the Linux image
# and the app does not use next/image optimization, so drop them to keep the image Linux-clean.
find "$staging/standalone/node_modules/@img" -maxdepth 1 -type d -name '*darwin*' -exec rm -rf {} + 2>/dev/null || true

echo "staged prebuilt frontend in $staging"
