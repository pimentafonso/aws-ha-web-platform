#!/usr/bin/env bash
# Delete every stack of an environment, in reverse dependency order. Stacks
# that do not exist are skipped, so a half-finished deploy or teardown can be
# re-run. The account stacks (security, cicd) are never touched.
#
# Usage: scripts/destroy.sh <dev|prod>
#
# Environment:
#   CONFIRM_PROD=yes     required to destroy prod
#   PURGE_RETAINED=yes   prod: also delete the final database snapshot and
#                        schedule the retained data key for deletion (7 days).
#                        Without it they are kept and the script says what
#                        they cost and how to remove them.
#
# Runs with my own credentials: the GitHub deploy roles cannot delete stacks.
set -euo pipefail
# shellcheck source=scripts/lib.sh
source "$(dirname "$0")/lib.sh"

ENV="${1:-}"
case "$ENV" in dev | prod) ;; *) die "usage: destroy.sh <dev|prod>" ;; esac
if [[ $ENV == prod && ${CONFIRM_PROD:-} != yes ]]; then
  die "destroying prod deletes its database (a final snapshot is kept); set CONFIRM_PROD=yes to go ahead"
fi
require_cmd aws

TMP_DIR=$(mktemp -d)
trap 'rm -rf "$TMP_DIR"' EXIT

# delete_stack <stack> [region]
delete_stack() {
  local stack=$1 region=${2:-$REGION}
  if [[ $(stack_status "$stack" "$region") == NONE ]]; then
    info "$stack: not found, skipping"
    return
  fi
  log "deleting $stack ($region)"
  aws cloudformation delete-stack --stack-name "$stack" --region "$region"
  if ! aws cloudformation wait stack-delete-complete --stack-name "$stack" --region "$region"; then
    show_stack_failures "$stack" "$region"
    die "deleting $stack failed; fix the cause above and re-run"
  fi
}

# set_stack_param <stack> <key> <value> <capabilities...>
# Updates one parameter with the stack's current template, keeping every
# other value. Used to turn deletion protection off through CloudFormation,
# so the stack never drifts from what it manages.
set_stack_param() {
  local stack=$1 key=$2 value=$3 k
  shift 3
  [[ $(stack_status "$stack") != NONE ]] || return 0
  [[ $(stack_param "$stack" "$key") != "$value" ]] || return 0
  local -a params=()
  for k in $(aws cloudformation describe-stacks --stack-name "$stack" --region "$REGION" \
    --query 'Stacks[0].Parameters[].ParameterKey' --output text); do
    if [[ $k == "$key" ]]; then
      params+=("ParameterKey=$k,ParameterValue=$value")
    else
      params+=("ParameterKey=$k,UsePreviousValue=true")
    fi
  done
  log "$stack: setting $key=$value before deletion"
  aws cloudformation update-stack --stack-name "$stack" --region "$REGION" \
    --use-previous-template --parameters "${params[@]}" --capabilities "$@" >/dev/null
  if ! aws cloudformation wait stack-update-complete --stack-name "$stack" --region "$REGION"; then
    show_stack_failures "$stack"
    die "updating $stack failed"
  fi
}

# Deletes every object version and delete marker, 200 at a time (a short
# request also fits the Windows command line). CloudFormation cannot delete
# a bucket that still holds anything, and both buckets are versioned.
empty_bucket() {
  local bucket=$1 batch_file=$TMP_DIR/delete.json count=0
  aws s3api head-bucket --bucket "$bucket" >/dev/null 2>&1 || return 0
  log "emptying s3://$bucket (every version)"
  while :; do
    aws s3api list-object-versions --bucket "$bucket" --max-items 200 --output json \
      --query '{Objects: [Versions[].{Key: Key, VersionId: VersionId}, DeleteMarkers[].{Key: Key, VersionId: VersionId}][]}' \
      >"$batch_file"
    grep -q '"Key"' "$batch_file" || break
    aws s3api delete-objects --bucket "$bucket" --delete "file://$(aws_path "$batch_file")" >/dev/null
    count=$((count + $(grep -c '"Key"' "$batch_file")))
  done
  info "$count object versions deleted"
}

# The access-log bucket can still receive a late CloudFront or ALB log after
# it was emptied, so empty and delete the stack up to three times.
delete_logging_stack() {
  local stack=$ENV-logging attempt bucket
  [[ $(stack_status "$stack") != NONE ]] || { info "$stack: not found, skipping"; return; }
  bucket=$(stack_output "$stack" AccessLogBucketName)
  for attempt in 1 2 3; do
    empty_bucket "$bucket"
    log "deleting $stack (attempt $attempt)"
    aws cloudformation delete-stack --stack-name "$stack" --region "$REGION"
    if aws cloudformation wait stack-delete-complete --stack-name "$stack" --region "$REGION"; then
      return
    fi
  done
  show_stack_failures "$stack"
  die "deleting $stack failed"
}

# ACM's DNS validation records were created in the hosted zone through the
# certificates; Route 53 refuses to delete a zone that still has records
# other than its own NS and SOA. Only the _<token>.<name> CNAMEs are removed.
remove_validation_records() {
  local zone name ttl value
  [[ $(stack_status prod-dns) != NONE ]] || return 0
  zone=$(stack_output prod-dns HostedZoneId)
  aws route53 list-resource-record-sets --hosted-zone-id "$zone" --output text \
    --query "ResourceRecordSets[?Type=='CNAME' && starts_with(Name, '_')].[Name, TTL, ResourceRecords[0].Value]" |
    while read -r name ttl value; do
      [[ -n $name ]] || continue
      info "removing validation record $name"
      printf '{"Changes":[{"Action":"DELETE","ResourceRecordSet":{"Name":"%s","Type":"CNAME","TTL":%s,"ResourceRecords":[{"Value":"%s"}]}}]}' \
        "$name" "$ttl" "$value" >"$TMP_DIR/change.json"
      aws route53 change-resource-record-sets --hosted-zone-id "$zone" \
        --change-batch "file://$(aws_path "$TMP_DIR/change.json")" >/dev/null
    done
}

# A secret deleted with a recovery window keeps its name until the window
# ends, which would make the next deploy fail. Finish any such deletion.
purge_deleted_secrets() {
  local name deleted
  for name in "$PROJECT/$ENV/origin-verify" "$PROJECT/$ENV/valkey-auth-token"; do
    deleted=$(aws secretsmanager describe-secret --secret-id "$name" --region "$REGION" \
      --query DeletedDate --output text 2>/dev/null) || continue
    if [[ -n $deleted && $deleted != None ]]; then
      info "removing secret $name (pending deletion)"
      aws secretsmanager delete-secret --secret-id "$name" --region "$REGION" \
        --force-delete-without-recovery >/dev/null
    fi
  done
}

# prod keeps a final snapshot (DeletionPolicy Snapshot) and the KMS key that
# encrypts it (Retain). Both cost money until removed.
handle_retained() {
  local key_arn=$1 db_instance=$2 snapshot
  snapshot=$(aws rds describe-db-snapshots --region "$REGION" \
    --db-instance-identifier "$db_instance" --snapshot-type manual \
    --query 'reverse(sort_by(DBSnapshots, &SnapshotCreateTime))[0].DBSnapshotIdentifier' --output text)
  if [[ ${PURGE_RETAINED:-} == yes ]]; then
    if [[ -n $snapshot && $snapshot != None ]]; then
      log "deleting final snapshot $snapshot"
      aws rds delete-db-snapshot --region "$REGION" --db-snapshot-identifier "$snapshot" >/dev/null
    fi
    log "scheduling deletion of the data key in 7 days"
    aws kms schedule-key-deletion --region "$REGION" --key-id "$key_arn" --pending-window-in-days 7 >/dev/null
    return
  fi
  log "kept: final snapshot ${snapshot:-none} and its KMS key $key_arn"
  info "Snapshot storage is billed per GB-month and the key at \$1 a month (list prices)."
  info "To remove both:"
  info "  aws rds delete-db-snapshot --region $REGION --db-snapshot-identifier $snapshot"
  info "  aws kms schedule-key-deletion --region $REGION --key-id $key_arn --pending-window-in-days 7"
}

log "destroying $ENV (account stacks security and cicd are kept)"

delete_stack "$ENV-observability"

if [[ $(stack_status "$ENV-edge") != NONE ]]; then
  empty_bucket "$(stack_output "$ENV-edge" StaticBucketName)"
fi
delete_stack "$ENV-edge"
[[ $ENV == prod ]] && delete_stack prod-edge-global "$GLOBAL_REGION"

[[ $ENV == prod ]] && set_stack_param prod-compute AlbDeletionProtection false CAPABILITY_IAM
delete_stack "$ENV-compute"

if [[ $ENV == prod ]]; then
  remove_validation_records
  delete_stack prod-dns
fi

delete_stack "$ENV-registry" # EmptyOnDelete removes the images

data_key="" db_instance=""
if [[ $(stack_status "$ENV-data") != NONE ]]; then
  data_key=$(stack_output "$ENV-data" DataKeyArn)
  db_instance=$(stack_output "$ENV-data" DbInstanceId)
fi
[[ $ENV == prod ]] && set_stack_param prod-data DbDeletionProtection false CAPABILITY_IAM CAPABILITY_AUTO_EXPAND
delete_stack "$ENV-data"
purge_deleted_secrets

delete_logging_stack
delete_stack "$ENV-network"

if [[ $ENV == prod && -n $data_key ]]; then
  handle_retained "$data_key" "$db_instance"
fi

log "$ENV destroyed"
