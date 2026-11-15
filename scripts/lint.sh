#!/usr/bin/env bash
# Validate and security-scan every CloudFormation template, and lint the
# shell scripts.
set -euo pipefail
cd "$(dirname "$0")/.."

shopt -s nullglob
templates=(infra/templates/*.yaml)
if [ ${#templates[@]} -eq 0 ]; then
  echo "No templates yet in infra/templates/."
  exit 0
fi

cfn-lint "${templates[@]}"
checkov --quiet --framework cloudformation -d infra/templates

# ShellCheck is preinstalled on GitHub's Ubuntu runners. Locally it is
# optional, but CI must not skip it silently.
if command -v shellcheck >/dev/null 2>&1; then
  shellcheck -x scripts/*.sh
elif [ "${CI:-}" = true ]; then
  echo "shellcheck not found" >&2
  exit 1
else
  echo "shellcheck not found: skipping the shell scripts" >&2
fi
