#!/usr/bin/env bash
# Deploy the platform with the AWS CLI v2, in dependency order. Every step is
# idempotent: re-running it applies only what changed.
#
# Usage:
#   scripts/deploy.sh account    security and cicd stacks, once per account,
#                                with my own administrator credentials
#   scripts/deploy.sh dev|prod   every stack of an environment
#
# Environment (private values never come from files in the repository):
#   ALERT_EMAIL            account and observability: where alarms are emailed
#   DOMAIN_NAME            prod: the delegated subdomain, e.g. notes.example.com
#   IMAGE_TAG              image to deploy; default: the current commit SHA
#   USE_EXEC_ROLE=true     deploy through the cicd stack's CloudFormation
#                          execution role and workload boundary (CI sets this)
#   SKIP_DELEGATION_CHECK=true  prod: carry on even if public DNS does not yet
#                          show the subdomain delegated to Route 53
#   ALLOW_DIRTY=true       build an image from a tree with uncommitted changes
set -euo pipefail
# shellcheck source=scripts/lib.sh
source "$(dirname "$0")/lib.sh"

usage() { die "usage: deploy.sh <account|dev|prod>"; }
TARGET="${1:-}"
case "$TARGET" in account | dev | prod) ;; *) usage ;; esac
ENV=$TARGET
cd "$REPO_ROOT"

ROLE_ARGS=()
BOUNDARY=""

# deploy_stack <stack> <template> <region> <capabilities|-> [Key=Value ...]
# Parameters come from infra/parameters/<env>/<template>.json, then the
# Key=Value overrides (deploy-time and private values).
deploy_stack() {
  local stack=$1 template=$2 region=$3 caps=$4
  shift 4
  local param_dir=$ENV status
  [[ $ENV == account ]] && param_dir=account
  local -a params caps_list caps_args=()
  mapfile -t params < <(merged_parameters "infra/parameters/$param_dir/$template.json" "$@")
  if [[ $caps != - ]]; then
    IFS=, read -ra caps_list <<<"$caps"
    caps_args=(--capabilities "${caps_list[@]}")
  fi

  status=$(stack_status "$stack" "$region")
  if [[ $status == ROLLBACK_COMPLETE ]]; then
    show_stack_failures "$stack" "$region"
    die "$stack failed on creation and was rolled back; delete it, then deploy again"
  fi

  log "$stack ($region): ${status/NONE/creating}"
  if ! aws cloudformation deploy \
    --stack-name "$stack" \
    --template-file "infra/templates/$template.yaml" \
    --region "$region" \
    --no-fail-on-empty-changeset \
    --tags "Project=$PROJECT" "Environment=$ENV" \
    "${caps_args[@]}" \
    "${ROLE_ARGS[@]}" \
    ${params[@]+--parameter-overrides "${params[@]}"}; then
    show_stack_failures "$stack" "$region"
    die "deploying $stack failed"
  fi
}

deploy_account() {
  [[ ${USE_EXEC_ROLE:-} != true ]] || die "the account stacks are deployed with my own credentials, not the execution role"
  require_env ALERT_EMAIL
  deploy_stack security security "$REGION" - "AlertEmail=$ALERT_EMAIL"
  deploy_stack cicd cicd "$REGION" CAPABILITY_NAMED_IAM
  log "cicd outputs"
  aws cloudformation describe-stacks --stack-name cicd --region "$REGION" \
    --query 'Stacks[0].Outputs[].[OutputKey, OutputValue]' --output text >&2
  info "Check your inbox and confirm the SNS subscription for security alerts."
}

# Build the arm64 image and push it, tagged with the commit SHA. Tags are
# immutable, so an image that is already there is never rebuilt.
push_image() {
  local uri registry
  uri=$(stack_output "$ENV-registry" RepositoryUri)
  registry=${uri%%/*}
  if aws ecr describe-images --region "$REGION" --repository-name "${uri#*/}" \
    --image-ids "imageTag=$IMAGE_TAG" >/dev/null 2>&1; then
    log "image $IMAGE_TAG is already in ECR"
    return
  fi
  require_cmd docker
  if [[ -n $(git status --porcelain) && ${ALLOW_DIRTY:-} != true ]]; then
    die "uncommitted changes: the image tag would not match its source (commit, or set ALLOW_DIRTY=true)"
  fi
  log "building and pushing $uri:$IMAGE_TAG (linux/arm64)"
  aws ecr get-login-password --region "$REGION" | docker login --username AWS --password-stdin "$registry"
  # A plain single-platform manifest: no attestation manifests for the
  # untagged-image lifecycle rule to expire from under the tag.
  docker buildx build --platform linux/arm64 --provenance=false --sbom=false \
    --tag "$uri:$IMAGE_TAG" --push app
}

# Stop unless public DNS already delegates the subdomain to this hosted zone:
# until it does, ACM cannot validate the certificates and compute would hang.
check_delegation() {
  local name_servers first
  name_servers=$(stack_output prod-dns NameServers)
  first=${name_servers%%,*}
  if nslookup -type=NS "$DOMAIN_NAME" 2>/dev/null | grep -qi "${first%.}"; then
    info "$DOMAIN_NAME is delegated to Route 53"
    return
  fi
  log "$DOMAIN_NAME is not delegated yet. At the parent domain's DNS provider, add NS records for it:"
  tr ',' '\n' <<<"$name_servers" | sed 's/^/    /' >&2
  [[ ${SKIP_DELEGATION_CHECK:-} == true ]] || die "re-run once the NS records resolve (or set SKIP_DELEGATION_CHECK=true)"
}

# Run the one-off migration task in the private app subnets with the app
# security group, wait for it and fail the deploy unless it exited 0.
run_migration() {
  local cluster task_definition subnets security_group task_arn exit_code
  cluster=$(stack_output "$ENV-compute" ClusterName)
  task_definition=$(stack_output "$ENV-compute" MigrationTaskDefinitionArn)
  subnets=$(stack_output "$ENV-network" PrivateAppSubnetIds)
  security_group=$(stack_output "$ENV-data" AppSecurityGroupId)

  log "running the migration task (${task_definition##*/})"
  task_arn=$(aws ecs run-task --region "$REGION" --cluster "$cluster" \
    --task-definition "$task_definition" --launch-type FARGATE --count 1 \
    --started-by deploy.sh \
    --network-configuration "awsvpcConfiguration={subnets=[$subnets],securityGroups=[$security_group],assignPublicIp=DISABLED}" \
    --query 'tasks[0].taskArn' --output text)
  [[ $task_arn == arn:* ]] || die "the migration task did not start"

  aws ecs wait tasks-stopped --region "$REGION" --cluster "$cluster" --tasks "$task_arn"
  exit_code=$(aws ecs describe-tasks --region "$REGION" --cluster "$cluster" --tasks "$task_arn" \
    --query 'tasks[0].containers[0].exitCode' --output text)
  if [[ $exit_code != 0 ]]; then
    aws ecs describe-tasks --region "$REGION" --cluster "$cluster" --tasks "$task_arn" \
      --query 'tasks[0].[stoppedReason, containers[0].reason]' --output text >&2 || true
    aws logs get-log-events --region "$REGION" \
      --log-group-name "$(stack_output "$ENV-compute" AppLogGroupName)" \
      --log-stream-name "migrate/migrate/${task_arn##*/}" --limit 50 \
      --query 'events[].message' --output text >&2 || true
    die "the migration task exited with $exit_code"
  fi
  info "migration finished (exit 0)"
}

# First deploy: the service starts with no tasks, the migration creates the
# app's database user, then the service starts. Later deploys: the migration
# task moves to the new image first, then the service rolls to it, so the
# schema is always ahead of the code (migrations must stay backwards
# compatible with the previous release).
deploy_compute() {
  local prefix_list status current_tag current_enabled
  prefix_list=$(aws ec2 describe-managed-prefix-lists --region "$REGION" \
    --filters Name=prefix-list-name,Values=com.amazonaws.global.cloudfront.origin-facing \
    --query 'PrefixLists[0].PrefixListId' --output text)
  [[ $prefix_list == pl-* ]] || die "CloudFront origin-facing prefix list not found in $REGION"
  local -a common=("CloudFrontPrefixListId=$prefix_list" "PermissionsBoundaryArn=$BOUNDARY")

  status=$(stack_status "$ENV-compute")
  if [[ $status == NONE ]]; then
    deploy_stack "$ENV-compute" compute "$REGION" CAPABILITY_IAM "${common[@]}" \
      "ImageTag=$IMAGE_TAG" "MigrationImageTag=" "ServiceEnabled=false"
  else
    current_tag=$(stack_param "$ENV-compute" ImageTag)
    current_enabled=$(stack_param "$ENV-compute" ServiceEnabled)
    deploy_stack "$ENV-compute" compute "$REGION" CAPABILITY_IAM "${common[@]}" \
      "ImageTag=$current_tag" "MigrationImageTag=$IMAGE_TAG" "ServiceEnabled=$current_enabled"
  fi
  run_migration
  deploy_stack "$ENV-compute" compute "$REGION" CAPABILITY_IAM "${common[@]}" \
    "ImageTag=$IMAGE_TAG" "MigrationImageTag=" "ServiceEnabled=true"
}

sync_static() {
  local bucket distribution
  bucket=$(stack_output "$ENV-edge" StaticBucketName)
  distribution=$(stack_output "$ENV-edge" DistributionId)
  log "syncing static/ to s3://$bucket/static/"
  aws s3 sync static/ "s3://$bucket/static/" --delete --region "$REGION"
  aws cloudfront create-invalidation --distribution-id "$distribution" \
    --paths '/static/*' --query 'Invalidation.Id' --output text >/dev/null
}

deploy_environment() {
  require_cmd git
  require_env ALERT_EMAIL
  [[ $ENV == dev ]] || require_env DOMAIN_NAME
  IMAGE_TAG=${IMAGE_TAG:-$(git rev-parse HEAD)}

  local account
  account=$(aws sts get-caller-identity --query Account --output text)
  if [[ ${USE_EXEC_ROLE:-} == true ]]; then
    ROLE_ARGS=(--role-arn "arn:aws:iam::$account:role/$PROJECT-$ENV-cfn-exec")
    BOUNDARY="arn:aws:iam::$account:policy/$PROJECT-workload-boundary"
  fi
  log "deploying $ENV, image $IMAGE_TAG${ROLE_ARGS[*]:+, through the execution role}"

  deploy_stack "$ENV-network" network "$REGION" CAPABILITY_IAM "PermissionsBoundaryArn=$BOUNDARY"
  deploy_stack "$ENV-logging" logging "$REGION" -
  deploy_stack "$ENV-data" data "$REGION" CAPABILITY_IAM,CAPABILITY_AUTO_EXPAND "PermissionsBoundaryArn=$BOUNDARY"
  deploy_stack "$ENV-registry" registry "$REGION" -
  push_image

  local edge_args=()
  if [[ $ENV == prod ]]; then
    deploy_stack prod-dns dns "$REGION" - "DomainName=$DOMAIN_NAME"
    check_delegation
  fi

  deploy_compute

  if [[ $ENV == prod ]]; then
    # Exports cannot cross Regions, so the hosted zone id goes to us-east-1
    # and the certificate and web ACL ARNs come back as plain parameters.
    deploy_stack prod-edge-global edge-global "$GLOBAL_REGION" - \
      "DomainName=$DOMAIN_NAME" "HostedZoneId=$(stack_output prod-dns HostedZoneId)"
    edge_args=(
      "ViewerCertificateArn=$(stack_output prod-edge-global ViewerCertificateArn "$GLOBAL_REGION")"
      "WebAclArn=$(stack_output prod-edge-global WebAclArn "$GLOBAL_REGION")"
    )
  fi
  deploy_stack "$ENV-edge" edge "$REGION" - "${edge_args[@]}"
  sync_static

  deploy_stack "$ENV-observability" observability "$REGION" - "AlertEmail=$ALERT_EMAIL"

  log "done: $(stack_output "$ENV-edge" SiteUrl)"
}

require_cmd aws
if [[ $TARGET == account ]]; then deploy_account; else deploy_environment; fi
