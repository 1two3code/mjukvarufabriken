#!/usr/bin/env bash
# Usage: infra/scripts/deploy.sh <env> [stack...]   e.g. infra/scripts/deploy.sh qa
# Loads AWS credentials (AWS_* only) from the root .env, makes sure the account is CDK-bootstrapped
# in every region the requested stacks use (the stack region, plus us-east-1 when a budget-<env>
# stack is in the list — AWS Budgets is a us-east-1 service), then deploys resources-<env>, mf-<env>,
# ops-<env>, budget-<env> in that order. With explicit stacks only those are deployed
# (`--exclusively`; their dependencies must already exist). Same stack list and bootstrap guard
# (scripts/ensure-bootstrapped.sh) as .github/workflows/deploy-environment.yml.
set -euo pipefail
cd "$(dirname "$0")/.."
env=${1:?env (dev|qa|live)}; shift || true
# Deploy progression: dev → qa → live (environments.md phase 1). Reject anything else early.
case "$env" in
dev | qa | live) ;;
*) echo "unknown env '$env' (expected dev|qa|live)" >&2; exit 1 ;;
esac
# live-only domain guard (hardening audit 2026-08-30, finding B1): without a domain, live's SES
# identity/grant never get created even though email.transport is 'ses', and live has no
# githubOAuth fallback — magic-link sign-in silently fails and the sole admin can never sign in
# to a "successfully" deployed live. Fails fast, before any AWS calls.
if [ "$env" = "live" ]; then npx tsx scripts/check-live-domain.ts; fi
# Optional --assume-role: assume OrganizationAccountAccessRole in the env's account (MF_ACCOUNT) so a
# local deploy can target a SEPARATE member account. Stripped from the stack list.
assume_role=
rest=
for a in "$@"; do if [ "$a" = "--assume-role" ]; then assume_role=1; else rest="$rest $a"; fi; done
set -- $rest
# Build only this env's stacks (lib/config.ts reads the un-namespaced MF_* below for it; synth then
# needs only apps/*/dist/$env).
export MF_ENV="$env"
# Per-env infra values (cert ARNs, hosted-zone id, account) written by scripts/provision-env — optional.
if [ -f "./.env.$env" ]; then set -a; . "./.env.$env"; set +a; fi
# Only the AWS_* lines — the root .env also holds api secrets the deploy has no use for.
set -a; eval "$(grep -E '^AWS_[A-Z_]+=' ../.env || true)"; set +a
if [ -n "$assume_role" ]; then
	: "${MF_ACCOUNT:?--assume-role needs MF_ACCOUNT (provision-env writes infra/.env.$env, or set it)}"
	echo "assuming OrganizationAccountAccessRole in $MF_ACCOUNT" >&2
	read -r AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY AWS_SESSION_TOKEN < <(aws sts assume-role \
		--role-arn "arn:aws:iam::$MF_ACCOUNT:role/OrganizationAccountAccessRole" \
		--role-session-name mf-deploy --query 'Credentials.[AccessKeyId,SecretAccessKey,SessionToken]' --output text)
	export AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY AWS_SESSION_TOKEN; unset AWS_PROFILE
fi
export CDK_DEFAULT_ACCOUNT=$(aws sts get-caller-identity --query Account --output text)
export CDK_DEFAULT_REGION=${AWS_REGION:-eu-north-1}
# Wrong-account guard: if the env pins an account (MF_ACCOUNT), the creds must match it.
if [ -n "${MF_ACCOUNT:-}" ] && [ "$MF_ACCOUNT" != "$CDK_DEFAULT_ACCOUNT" ]; then
	echo "refusing: env '$env' targets account $MF_ACCOUNT but creds are $CDK_DEFAULT_ACCOUNT — use --assume-role or switch creds" >&2
	exit 1
fi

if [ $# -gt 0 ]; then
	stacks=$*
	exclusively=--exclusively
else
	stacks="resources-$env mf-$env ops-$env budget-$env"
	exclusively=
fi

scripts/ensure-bootstrapped.sh "$CDK_DEFAULT_ACCOUNT" "$CDK_DEFAULT_REGION"
case " $stacks " in
*" budget-"*) scripts/ensure-bootstrapped.sh "$CDK_DEFAULT_ACCOUNT" us-east-1 ;;
esac

npx cdk deploy $stacks $exclusively --require-approval never --outputs-file "cdk-outputs-$env.json"
