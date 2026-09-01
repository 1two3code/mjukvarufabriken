# Egress allowlist sidecar for build jobs: tinyproxy with FilterDefaultDeny. Built from the
# public alpine image (no third-party proxy image to trust); the same image runs in docker
# compose (`--profile job`) and as the Fargate sidecar.
FROM --platform=linux/amd64 alpine:3.22

RUN apk add --no-cache tinyproxy

COPY tinyproxy.conf /etc/tinyproxy/tinyproxy.conf
COPY filter /etc/tinyproxy/filter
COPY entrypoint.sh /entrypoint.sh

EXPOSE 8888
# The entrypoint appends FILTER_ALLOW_EXTRA (comma-separated hosts) to the filter — the C1
# fence routes job->api reports through this proxy and the api host is per-environment.
# Without the env var it starts tinyproxy on the static filter, byte-identical behaviour.
ENTRYPOINT ["/bin/sh", "/entrypoint.sh"]
