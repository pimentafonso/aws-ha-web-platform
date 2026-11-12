#!/usr/bin/env bash
# Deploy every stack for an environment, in dependency order.
# Usage: scripts/deploy.sh <dev|prod>
set -euo pipefail
ENV="${1:?usage: deploy.sh <dev|prod>}"

echo "deploy.sh: not implemented yet (stacks are added one at a time). ENV=$ENV" >&2
exit 1
