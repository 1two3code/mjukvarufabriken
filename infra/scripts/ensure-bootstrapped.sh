#!/usr/bin/env bash
# Usage: infra/scripts/ensure-bootstrapped.sh <account> <region>
# One-time per account/region: runs `cdk bootstrap` only when the CDKToolkit stack is missing.
# Any other `describe-stacks` failure (denied, expired credentials, throttling) is NOT treated as
# "not bootstrapped" — the script fails loudly with the CLI's error instead of (re)running a
# bootstrap that would rewrite CDKToolkit with the CLI defaults.
set -euo pipefail
account=${1:?account}; region=${2:?region}
target="aws://$account/$region"

if output=$(aws cloudformation describe-stacks --stack-name CDKToolkit --region "$region" 2>&1); then
	echo "cdk bootstrap: $target already bootstrapped"
elif grep -q "does not exist" <<<"$output"; then
	echo "cdk bootstrap: bootstrapping $target"
	npx cdk bootstrap "$target"
else
	echo "cdk bootstrap: cannot tell whether $target is bootstrapped:" >&2
	echo "$output" >&2
	exit 1
fi
