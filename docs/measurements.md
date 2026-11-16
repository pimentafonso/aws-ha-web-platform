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
