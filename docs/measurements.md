# Measurements

A dated log of what I measured on real AWS, with the commands I used. Only numbers I measured go here. Spend figures come from AWS billing and are dated when I read them, because billing data lags by hours.

Environment for every run unless stated: one AWS account on the AWS Free plan (credits only, so nothing can be charged to a card), Region eu-west-1, AWS CLI 2.39.0 signed in with `aws login` as an IAM user with MFA, from my laptop in Lisbon.

## Session 0: account setup, 16 November 2026

### Account-level stacks

```
GUARDDUTY=disabled ALERT_EMAIL=... bash scripts/deploy.sh account
```

| Stack | Created in (CloudFormation stack events, review start to `CREATE_COMPLETE`) |
| --- | --- |
| `security` | 75 s (23:30:56 to 23:32:11 UTC) |
| `cicd` | 68 s (23:32:37 to 23:33:44 UTC) |
| Whole script, wall clock (`date +%s` before and after) | 202 s |

Both stacks created on the first attempt.

### What did not go as planned

- **GuardDuty is not available on the Free plan.** `aws guardduty list-detectors` returns `SubscriptionRequiredException` in eu-west-1 and us-east-1. I made the detector optional (`GUARDDUTY=disabled`) instead of upgrading the account, so the security stack deploys CloudTrail, the KMS key, the audit bucket and the alert topic without it.
- **IAM Identity Center would have ended the Free plan.** Enabling it with AWS Organizations upgrades the account to the paid plan and forfeits the Free plan credits, so the CLI signs in with `aws login` (console credentials, short-lived and refreshed automatically) instead of SSO. There are no long-lived access keys.

### Cost guards

- An AWS Budget of $20 a month with **credits and refunds excluded**. With the default settings (`IncludeCredit: true`) a budget nets credits off and stays at $0, so it would never alert while credits last. It emails at 50%, 80% and 100% of actual spend and at 100% of forecast.
- A CloudWatch alarm on `AWS/Billing` `EstimatedCharges` above $10 in us-east-1. On 16 November it read $0.00 while about $0.28 of credits had been used, so this metric appears to be net of credits. The budget is the alarm that counts.

## Session 1: dev deployed from my laptop, 16–17 November 2026

Dev was up from 23:52 to 00:54 UTC (62 minutes), plus a failed first attempt from 23:43 to 23:49 that rolled back.

### Deploy

```
ALERT_EMAIL=... bash scripts/deploy.sh dev
```

The first full deploy needed four attempts, because a real deploy found bugs that linting and local tests did not (see below). The stacks that already existed reported no changes on each new attempt, so every stack was created exactly once. Create times come from CloudFormation stack events, `CREATE_IN_PROGRESS` to `CREATE_COMPLETE`:

| Stack | Created in |
| --- | --- |
| `dev-network` | 171 s |
| `dev-logging` | 20 s |
| `dev-data` (RDS PostgreSQL, Valkey) | 576 s |
| `dev-registry` | 4 s |
| `dev-compute` (first create, service off) | 196 s |
| `dev-edge` (CloudFront) | 208 s |
| `dev-observability` | 14 s |

Because of the retries I do not have one clean wall-clock figure for a first deploy. The stack create times add up to 1,189 s (about 20 minutes), before the image build, the migration task and the compute updates.

Wall clock for whole runs of the script (`date +%s` before and after):

| Run | Time |
| --- | --- |
| Update with an app change (new arm64 image built under QEMU, pushed, migration, service rolled) | 334 s |
| No-change re-run (image already in ECR, every stack "No changes", migration still runs) | 129 s |

### Smoke test through CloudFront

`curl` against the distribution's default `*.cloudfront.net` name:

- `/health` 200. `/static/index.html` 200.
- `/ready`: the very first call returned **503 after 5.3 s** (`Connection terminated due to connection timeout` in the app log). The pool's first connection after the task started took longer than its 5 s connect timeout. That connection signs an IAM auth token and does a TLS handshake. Every later call returned 200 in about 0.35 s. I have not fixed this yet.
- Create 201, read 200, list 200, delete 204, read after delete 404.
- Cache: `X-App-Cache: MISS` on the first read of a note, `HIT` on the second.
- Both SNS email subscriptions (dev alarms, security alerts) confirmed. All 11 dev alarms in `OK`. The dashboard exists.

### Latency

```
k6 run -e BASE_URL=https://<distribution>.cloudfront.net loadtest/latency.js
```

k6 0.43.1 on my laptop in Lisbon, over my home internet connection, to dev through CloudFront, 17 November 2026 00:36–00:38 UTC. Constant arrival rate of 5 iterations a second for 2 minutes. 693 requests in total, 0 failed. This measures what one client sees at a low rate. It says nothing about capacity.

| Route | Requests | p50 | p95 | p99 | Max |
| --- | --- | --- | --- | --- | --- |
| All | 693 | 55.0 ms | 88.5 ms | 110.1 ms | 463.2 ms |
| `GET /health` | 97 | 53.9 ms | 77.1 ms | 103.2 ms | 111.0 ms |
| `GET /ready` | 63 | 55.3 ms | 79.8 ms | 98.6 ms | 101.4 ms |
| `GET /api/notes/:id` | 314 | 55.0 ms | 85.5 ms | 99.5 ms | 126.7 ms |
| `GET /api/notes` | 55 | 56.2 ms | 87.7 ms | 114.2 ms | 129.3 ms |
| `POST` then `DELETE /api/notes` | 144 | 54.5 ms | 86.8 ms | 97.5 ms | 123.6 ms |

The 463 ms maximum is one of the 20 setup and teardown requests, outside the per-route rows. Of the 314 note reads, 294 (93.6%) were cache hits. The 20 misses match the 60 s cache TTL: 10 seeded notes, each missed once at first and once more after expiring during the 2-minute run.

### Teardown

```
bash scripts/destroy.sh dev
```

937 s wall clock. Afterwards I listed, in eu-west-1 and where relevant us-east-1:
- CloudFormation stacks;
- EC2 instances, volumes and snapshots;
- Elastic IPs, ENIs, NAT gateways and non-default VPCs;
- load balancers;
- RDS instances, snapshots and automated backups;
- ElastiCache clusters, replication groups and snapshots;
- ECS clusters, ECR repositories and CloudFront distributions;
- S3 buckets and log groups;
- Secrets Manager (including secrets pending deletion);
- alarms and dashboards;
- customer-managed KMS keys.

Left over:
- The account stacks (`security`, `cicd`) and their audit bucket, as intended.
- The dev data KMS key, `PendingDeletion` until 24 November (the 7-day minimum). KMS does not charge for keys scheduled for deletion.
- `RDSOSMetrics`, an empty log group that RDS Enhanced Monitoring creates outside the stack. I deleted it by hand.

### Bugs a real deploy found

Each was fixed in its own commit on the `m4-deploy` branch:

1. The Free plan refused the dev NAT instance: `t4g.nano` is not Free Tier eligible. Dev now uses `t4g.micro` ($0.0092/hour instead of $0.0046).
2. `deploy.sh` printed `None` instead of the failure reason. It asked for the latest 40 stack events, and the rollback events had pushed the failure out of that window.
3. The task execution roles could not create log streams. `!GetAtt LogGroup.Arn` already ends in `:*`, so `${AppLogGroup.Arn}:log-stream:*` matched nothing.
4. The migration task could not read the RDS CA bundle. In the Dockerfile, `ADD --chmod=444` also gave the directory it created mode 444, with no execute bit.
5. CloudFront replaces an origin's `X-Cache` header with its own, so the app's cache header never reached clients. It is now `X-App-Cache`.
6. k6 0.43.1 cannot parse object spread, which the first version of the k6 script used.

The deploy also answered one open question: `aws cloudformation deploy` accepts an empty override (`MigrationImageTag=`).

### Spend

At 00:55 UTC on 17 November the Free plan credit balance still read $179.72 (`aws freetier get-account-plan-state`), and the budget's actual spend $0.00. Billing data lags by hours, so the real figure for this session is still to come.
