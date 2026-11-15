# Helpers shared by deploy.sh and destroy.sh. Source it, don't run it.
# Its constants are used by those scripts, not here (SC2034).
# shellcheck shell=bash disable=SC2034
# Needs bash 4+ and the AWS CLI v2. Runs the same in Git Bash on Windows,
# on Linux and in GitHub Actions.

# The app image bundles the eu-west-1 RDS CA, so the platform lives here.
# Only the CloudFront certificate and WAF web ACL go to us-east-1.
readonly REGION=eu-west-1
readonly GLOBAL_REGION=us-east-1
readonly PROJECT=aws-ha-web-platform

export AWS_PAGER=""
# Git Bash would rewrite arguments such as /aws-ha-web-platform/dev/notes-api
# or /static/* into Windows paths before the AWS CLI sees them.
export MSYS_NO_PATHCONV=1

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
readonly REPO_ROOT

log() { printf '\n==> %s\n' "$*" >&2; }
info() { printf '    %s\n' "$*" >&2; }
die() { printf '\nerror: %s\n' "$*" >&2; exit 1; }

require_cmd() {
  local cmd
  for cmd in "$@"; do
    command -v "$cmd" >/dev/null 2>&1 || die "$cmd is not installed or not on PATH"
  done
}

require_env() {
  local name
  for name in "$@"; do
    [[ -n "${!name:-}" ]] || die "set $name in the environment (it is never read from the repository)"
  done
}

# A path the AWS CLI can open with file://, also when it is a Windows binary.
aws_path() {
  if command -v cygpath >/dev/null 2>&1; then cygpath -m "$1"; else printf '%s' "$1"; fi
}

# stack_status <stack> [region]; prints NONE when the stack does not exist.
stack_status() {
  aws cloudformation describe-stacks --stack-name "$1" --region "${2:-$REGION}" \
    --query 'Stacks[0].StackStatus' --output text 2>/dev/null || echo NONE
}

# stack_output <stack> <output key> [region]
stack_output() {
  local value
  value=$(aws cloudformation describe-stacks --stack-name "$1" --region "${3:-$REGION}" \
    --query "Stacks[0].Outputs[?OutputKey=='$2'].OutputValue | [0]" --output text)
  [[ -n "$value" && "$value" != None ]] || die "stack $1 has no output $2"
  printf '%s' "$value"
}

# stack_param <stack> <parameter key> [region]
stack_param() {
  aws cloudformation describe-stacks --stack-name "$1" --region "${3:-$REGION}" \
    --query "Stacks[0].Parameters[?ParameterKey=='$2'].ParameterValue | [0]" --output text
}

# Prints the most recent failure reasons of a stack, to explain a failed
# deploy or delete without opening the console.
show_stack_failures() {
  aws cloudformation describe-stack-events --stack-name "$1" --region "${2:-$REGION}" \
    --max-items 40 --output text \
    --query "StackEvents[?contains(ResourceStatus, 'FAILED')].[LogicalResourceId, ResourceStatusReason]" \
    >&2 2>/dev/null || true
}

# Prints Key=Value lines: the parameter file first, then the overrides, a
# later value replacing an earlier one. Parameter files use the create-stack
# format, one parameter per line, which keeps this parser free of jq.
merged_parameters() {
  local file=$1 key kv value
  shift
  local -A values=()
  local -a order=()
  if [[ -f "$file" ]]; then
    while IFS='=' read -r key value; do
      [[ -v "values[$key]" ]] || order+=("$key")
      values[$key]=$value
    done < <(sed -nE 's/.*"ParameterKey": *"([^"]+)", *"ParameterValue": *"([^"]*)".*/\1=\2/p' "$file")
  fi
  for kv in "$@"; do
    key=${kv%%=*}
    [[ -v "values[$key]" ]] || order+=("$key")
    values[$key]=${kv#*=}
  done
  for key in "${order[@]}"; do
    printf '%s=%s\n' "$key" "${values[$key]}"
  done
}
