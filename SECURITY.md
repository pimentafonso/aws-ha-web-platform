# Security

This document explains each security control in the platform and why it is there. _Sections are filled in as the stacks are built._

## Reporting a vulnerability

This is a personal reference project. If you find a security issue, please open a private security advisory on this repository rather than a public issue.

## Controls

| Area | Control | Why |
|---|---|---|
| Identity | GitHub OIDC role assumption for CI, no stored access keys | _TBD_ |
| Identity | Least-privilege IAM for task role, execution role and deploy role | _TBD_ |
| Network | Application and data tiers in private subnets, ALB reachable only from CloudFront | _TBD_ |
| Data | KMS encryption for RDS, ElastiCache, S3, Secrets Manager and logs | _TBD_ |
| Secrets | Database credentials in Secrets Manager, injected into tasks at start | _TBD_ |
| Transport | ACM certificates, TLS from viewer to CloudFront and from CloudFront to ALB | _TBD_ |
| Edge | AWS WAF managed rule groups and rate limiting | _TBD_ |
| Detection | CloudTrail and GuardDuty | _TBD_ |

## What is not in this repository

No AWS account IDs, access keys, secrets or real domain names are committed. Account-specific values are passed in at deploy time through environment variables or GitHub repository variables.
