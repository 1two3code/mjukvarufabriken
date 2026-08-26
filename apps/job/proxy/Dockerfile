# Egress allowlist sidecar for build jobs: tinyproxy with FilterDefaultDeny. Built from the
# public alpine image (no third-party proxy image to trust); the same image runs in docker
# compose (`--profile job`) and as the Fargate sidecar.
FROM --platform=linux/amd64 alpine:3.22

RUN apk add --no-cache tinyproxy

COPY tinyproxy.conf /etc/tinyproxy/tinyproxy.conf
COPY filter /etc/tinyproxy/filter

EXPOSE 8888
CMD ["tinyproxy", "-d", "-c", "/etc/tinyproxy/tinyproxy.conf"]
