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

## Session 2: dev deployed by GitHub Actions, 17 November 2026

`deploy.yml`, dispatched on `main` for `dev`. It runs on the `ubuntu-24.04-arm` runner, assumes the dev deploy role through GitHub OIDC, and runs `deploy.sh dev` with `USE_EXEC_ROLE=true`, so CloudFormation acts as the dev execution role inside the workload permissions boundary. Teardown ran from my laptop with my own credentials. Dev was up from about 01:30 to 02:31 UTC; the network and logging stacks came up first, and the rest from about 01:50.

### What the first CI runs found

Four runs failed before one succeeded. Each fix went into the `cicd` stack (deployed with my own credentials) and was committed:

1. **OIDC subject.** GitHub issues this repository immutable subjects, which carry the owner and repository IDs: `repo:pimentafonso@350777569/aws-ha-web-platform@1456449290:environment:dev`. `GET /repos/<owner>/<repo>/actions/oidc/customization/sub` shows `use_immutable_subject: true`. The roles trusted the older `repo:pimentafonso/aws-ha-web-platform:...` form, so `AssumeRoleWithWebIdentity` was refused. The roles now trust the immutable form, which also stops a repository or account re-created under the same name from assuming them.
2. **LanguageExtensions transform.** CloudFormation expands the data stack's `AWS::LanguageExtensions` transform as the stack's service role. I had allowed `cloudformation:CreateChangeSet` on the transform for the deploy role only, so the execution role was refused.
3. **PassRole for Enhanced Monitoring.** RDS passes the monitoring role itself, inside `CreateDBInstance`, so `iam:PassedToService` is `rds.amazonaws.com`, not `monitoring.rds.amazonaws.com`.

This answers two open questions from M3. The deploy and execution roles did not have every permission CloudFormation needs; items 2 and 3 were missing. And the `ubuntu-24.04-arm` runner image includes the AWS CLI (2.40.0 on this run).

Public log check: the account ID appears as `***` throughout, including in the role ARN and the ECR host, because it is passed as a secret. A search of the full run log for 12-digit account numbers in ARNs or ECR hosts found none.

### Successful run

[Run 43998407149](https://github.com/pimentafonso/aws-ha-web-platform/actions/runs/43998407149), 01:49:01 to 02:11:55 UTC, 22 min 54 s. The network and logging stacks already existed from the failed runs, so they reported no changes. Step times from the timestamps in the run log:

| Step | Time |
| --- | --- |
| `dev-data` (create) | 10 min 15 s |
| `dev-registry` (create) | 39 s |
| arm64 image build and push, natively on the arm64 runner | 19 s |
| `dev-compute` (create, service off) | 3 min 43 s |
| Migration task | 48 s |
| `dev-compute` (update, service on) | 1 min 44 s |
| `dev-edge` (create) | 4 min 12 s |
| `dev-observability` (create) | 37 s |

### Smoke test

The same checks as session 1, all passing, with one repeat: the first `/ready` after the deploy again returned **503 after 5.3 s**, and the next one 200 in 1.4 s. So the slow first database connection reproduces. A likely cause is that the first `getAuthToken()` also fetches the task role's credentials from the ECS credentials endpoint, on top of the first IAM-authenticated login. I have not confirmed this. Since then the app opens its first connection at start-up rather than on the first request, and the connect timeout is 10 s instead of 5. That fix has not run on AWS yet; the next deploy will show whether the first `/ready` is fast.

### Teardown

The first `destroy.sh dev` run failed after 263 s. CloudFormation could not delete the CloudFront distribution: *"The distribution you are trying to delete has not been disabled"*. I had started the teardown about a minute after the deploy finished. The stack had disabled the distribution at 02:14:32, but the delete at 02:17:25 still saw it enabled. Re-running a minute later succeeded: 717 s. `destroy.sh` now waits for the distribution to finish deploying and retries, up to three times. It also removes the `RDSOSMetrics` log group once no database is left, which I had deleted by hand twice.

The leftover check came back clean, the same as session 1. What remains: the account stacks, the audit bucket, and three dev data keys pending deletion, which are not billed (one each from session 1, the rolled-back attempt and this session).

### Spend

At 02:33 UTC on 17 November the credit balance still read $179.72, and the budget's actual spend $0.00. Billing has not caught up with either session yet.

## Session 3: prod and failover tests, 17 November 2026

Prod deployed from my laptop with my own credentials, served at a subdomain of a domain I own (written `notes.example.com` here), delegated from Cloudflare to the Route 53 zone with four NS records. Prod was up from 10:31 to 12:46 UTC (2 hours 15 minutes), counting the failed attempts below.

```
DB_INSTANCE_CLASS=db.t4g.micro DB_BACKUP_RETENTION_DAYS=1 \
  DOMAIN_NAME=notes.example.com ALERT_EMAIL=... bash scripts/deploy.sh prod
```

### What the Free plan refused

Prod is designed for a Multi-AZ `db.t4g.small` with 7 days of backups. The Free plan refused both, each after the data stack had spent about 11 minutes creating and then rolling back:

1. *"The specified backup retention period exceeds the maximum available to free tier customers."* Dev's 1 day had been accepted.
2. *"This instance size isn't available with free plan accounts."* for `db.t4g.small`.

I added deploy-time overrides (`DB_BACKUP_RETENTION_DAYS`, `DB_INSTANCE_CLASS`) rather than changing prod's committed parameters, and deployed prod with a **Multi-AZ `db.t4g.micro` and 1 day of backups**. The Free plan accepted Multi-AZ. Every number below is for that database, not the designed `db.t4g.small`.

### Other things that went wrong

- My `aws login` session expired after about 12 hours, during the data stack's create. CloudFormation finished the stack; only my CLI's wait failed with `ExpiredToken`. I signed in again and re-ran the script.
- `docker login` to ECR failed with *"The stub received bad data"*. The ECR token was 2,592 characters, over the 2,560-byte limit of Windows Credential Manager, where Docker Desktop stores logins. The image was pushed on a second attempt, and the script then found it in ECR. Dev's sessions had not hit this.
- `destroy.sh prod` failed on two paths dev never runs. The Windows AWS CLI ends every line of text output with CRLF, and Bash kept the CR, so the ACM validation record's value broke the Route 53 change JSON and a parameter name failed to match. `lib.sh` now strips CR from all AWS CLI output. Then turning off the database's deletion protection with `update-stack --use-previous-template` got *"No updates are to be performed"* on the data stack, which uses the `AWS::LanguageExtensions` transform. Sending the repository's template instead worked, and `destroy.sh` now does that.

### Deploy

Create times from CloudFormation stack events:

| Stack | Created in |
| --- | --- |
| `prod-dns` (hosted zone) | 46 s |
| `prod-network` (2 NAT gateways, 4 interface endpoints in 2 AZs) | 2 min 1 s |
| `prod-logging` | 20 s |
| `prod-data` (Multi-AZ PostgreSQL, 2-node Valkey) | 18 min 13 s |
| `prod-registry` | 5 s |
| `prod-compute` (create, service off) | 3 min 38 s |
| `prod-compute` (update, service on) | 1 min 12 s |
| `prod-edge-global` (ACM certificate, WAF, us-east-1) | 2 min 38 s |
| `prod-edge` (CloudFront) | 3 min 29 s |
| `prod-observability` | 14 s |

Inside `prod-data`, the Multi-AZ instance took 17 min 48 s and Valkey 6 min 3 s. The ACM certificate took 2 min 35 s to validate over DNS. The arm64 image build and push took 25 s under QEMU, with the dependency layers cached from dev. The last script run, from compute onwards, took 922 s.

### Smoke test

Through `https://notes.example.com`: `/ready` 200 on the first call (0.87 s), `/health` 200, `/static/index.html` 200, create 201, read 200 with `X-App-Cache: MISS` then `HIT`, list 200, delete 204, read after delete 404. HTTP redirects to HTTPS (301), HSTS is set, and the certificate is issued by Amazon. A request straight to the load balancer's DNS name timed out: its security group only admits CloudFront.

The first-connection fix from session 2 worked. Both tasks logged `database connection ready` at start-up after **7.2 and 7.4 s**, longer than the old 5 s connect timeout, which explains the 503s in dev. With the connection opened at start-up, no request waited for it.

### Failover tests

Each test ran `loadtest/latency.js` with `--out csv` against prod and triggered the failure about a minute in. Error windows come from the per-request CSV; recovery times from ECS, RDS and ElastiCache events.

**1. One of two Fargate tasks stopped** (`aws ecs stop-task`, 11:48:25 UTC, k6 at 10 iterations a second).

| Event | Time after the stop |
| --- | --- |
| Task deregistered from the target group | 28 s |
| Replacement task started | 29 s |
| Replacement registered and healthy | 58 s |
| Service steady again (2 of 2) | 67 s |

**0 failed requests** of the 658 sent in the minute after the stop. The other task carried the traffic.

**2. RDS Multi-AZ failover** (`aws rds reboot-db-instance --force-failover`, 11:58:41 UTC, k6 at 2 iterations a second).

RDS reported *failover started* at 11:58:58 and *completed* at 11:59:27: **29 s**. The app took **about 6 minutes** to recover: database routes returned 500 or 503 from 11:59:02 until about 12:05:02. `/health` kept answering 200, so the ALB kept both tasks in service, as designed. 531 of 863 requests in the 7-minute run failed (61.5%).

The PostgreSQL log of the new primary shows why. Its IAM authentication service (`rdsauthproxy` on port 1108) at first refused connections, then answered `403 Forbidden` to the app's tokens, which signed in fine before and after. Logins waiting on it held connection slots until they timed out, so other connections got *"sorry, too many clients already"*. Sign-ins started succeeding again at about 12:05. I changed nothing; it recovered on its own. The `prod-api-5xx` alarm fired at 12:02:22 (3 min 20 s after the first error) and cleared at 12:12:22.

So with IAM database authentication, a Multi-AZ failover cost about 6 minutes of database errors, not the 29 s RDS reports. This is one run, on a `db.t4g.micro` that the Free plan forced; I cannot tell from one run whether the instance size mattered. Options I have not tried yet: RDS Proxy in front of the database, a password-based fallback login, or backing off new connections while sign-ins fail.

**3. Valkey failover** (`aws elasticache test-failover`, 12:10:16 UTC, k6 at 2 iterations a second).

ElastiCache reported the failover from node `-001` to `-002` completed at 12:10:40, **22 s** after the API call registered (12:10:18). The app logged Redis errors (`ECONNREFUSED`, then connection timeouts) from 12:10:20 to 12:10:54, 34 s, and served those reads from PostgreSQL. **0 failed requests** of 687. Every cached read in 12:10:30–12:11:00 was a miss; hits came back from 12:11:00.

### WAF rate limit

Not planned this way: test 1's k6 run at 10 iterations a second went over the rate rule's limit of 1,000 requests per IP per 5 minutes. After 1,408 requests in 128 s, WAF answered `403` to every request from my IP, 2,337 of them. The WAF metric `BlockedRequests` for `rate-limit-per-ip` adds up to 2,338 over 11:49–11:53. The block lifted between 34 s and 4 min 13 s after the run ended: a request at 11:53:52 was still blocked, and one at 11:57:31 got through. The later tests ran at 2 iterations a second to stay under the limit.

### Teardown

```
CONFIRM_PROD=yes PURGE_RETAINED=yes bash scripts/destroy.sh prod
```

Four runs because of the two bugs above: 741 s, 128 s and 30 s, each failing, then 767 s for the database, cache, logging and network stacks. With `PURGE_RETAINED=yes` it also deleted the final database snapshot and scheduled the data key for deletion.

The leftover check (the same list as session 1, in eu-west-1 and us-east-1, plus CloudFront distributions, Route 53 hosted zones and ACM certificates) found nothing billable: only the account stacks, their audit bucket and the billing alarm. The hosted zone existed for about 2 hours; Route 53 does not charge for a zone deleted within 12 hours of being created.

### Spend

At 12:48 UTC on 17 November the credit balance still read $179.72 and both budgets $0.00, the same as before sessions 1 and 2. Billing has not caught up with any of the three sessions yet.
