#!/usr/bin/env bash
# Delete every stack for an environment, in reverse dependency order.
# Usage: scripts/destroy.sh <dev|prod>
set -euo pipefail
ENV="${1:?usage: destroy.sh <dev|prod>}"

echo "destroy.sh: not implemented yet (stacks are added one at a time). ENV=$ENV" >&2
exit 1
