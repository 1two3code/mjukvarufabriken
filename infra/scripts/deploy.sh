#!/usr/bin/env bash
# Usage: infra/scripts/deploy.sh <env> [stack...]   e.g. infra/scripts/deploy.sh dev
# Loads AWS credentials from the root .env, makes sure the account is CDK-bootstrapped in the
# stack region AND in us-east-1 (budget-<env> lives there — AWS Budgets is a us-east-1 service),
# then deploys resources-<env>, mf-<env>, ops-<env>, budget-<env> in that order (or the given
# stacks). Same stack list and bootstrap guard as .github/workflows/deploy-environment.yml.
set -euo pipefail
cd "$(dirname "$0")/.."
env=${1:?env (dev|live)}; shift || true
set -a; . ../.env; set +a
export CDK_DEFAULT_ACCOUNT=$(aws sts get-caller-identity --query Account --output text)
export CDK_DEFAULT_REGION=${AWS_REGION:-eu-north-1}

# One-time per account/region; a no-op when the CDKToolkit stack already exists there.
ensure_bootstrapped() {
	local region=$1
	if aws cloudformation describe-stacks --stack-name CDKToolkit --region "$region" >/dev/null 2>&1; then
		echo "cdk bootstrap: aws://$CDK_DEFAULT_ACCOUNT/$region already bootstrapped"
	else
		echo "cdk bootstrap: bootstrapping aws://$CDK_DEFAULT_ACCOUNT/$region"
		npx cdk bootstrap "aws://$CDK_DEFAULT_ACCOUNT/$region"
	fi
}
ensure_bootstrapped "$CDK_DEFAULT_REGION"
ensure_bootstrapped us-east-1

stacks=${*:-"resources-$env mf-$env ops-$env budget-$env"}
npx cdk deploy $stacks --require-approval never --outputs-file "cdk-outputs-$env.json"
