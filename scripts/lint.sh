#!/usr/bin/env bash
# Validate and security-scan every CloudFormation template.
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
