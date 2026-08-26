#!/usr/bin/env bash
# Usage: infra/scripts/deploy.sh <env> [stack...]   e.g. infra/scripts/deploy.sh dev
# Loads AWS credentials from the root .env, then deploys resources-<env>, mf-<env> and ops-<env> (or the given stacks).
set -euo pipefail
cd "$(dirname "$0")/.."
env=${1:?env (dev|live)}; shift || true
set -a; . ../.env; set +a
export CDK_DEFAULT_ACCOUNT=$(aws sts get-caller-identity --query Account --output text)
export CDK_DEFAULT_REGION=${AWS_REGION:-eu-north-1}
stacks=${*:-"resources-$env mf-$env ops-$env"}
npx cdk deploy $stacks --require-approval never --outputs-file "cdk-outputs-$env.json"
