#!/bin/sh
# Append operator-supplied allowlist hosts (comma-separated) to the static filter before
# starting tinyproxy. Used by the C1 egress fence: with the fence on, job→api status reports
# ride this proxy, and the api hostname is per-environment (set as FILTER_ALLOW_EXTRA on the
# proxy service by infra/lib/resources-stack.ts). Unset — the sidecar and docker compose — the
# filter is exactly apps/job/proxy/filter, unchanged.
set -eu
if [ -n "${FILTER_ALLOW_EXTRA:-}" ]; then
	printf '%s\n' "$FILTER_ALLOW_EXTRA" | tr ',' '\n' >> /etc/tinyproxy/filter
fi
exec tinyproxy -d -c /etc/tinyproxy/tinyproxy.conf
