# Security

This document explains each security control in the platform and why it is there. _Sections are filled in as the stacks are built._

## Reporting a vulnerability

This is a personal reference project. If you find a security issue, please open a private security advisory on this repository rather than a public issue.

## Controls

| Area | Control | Why |
|---|---|---|
| Identity | GitHub OIDC role assumption for CI, no stored access keys | _TBD_ |
| Identity | Least-privilege IAM for task role, execution role and deploy role | _TBD_ |
| Network | Application and data tiers in private subnets, ALB reachable only from CloudFront | _TBD (ALB part, compute and edge stacks)_ |
| Network | Data subnets have no default route; app subnets reach the internet only outbound through NAT | A database or cache cannot be reached from, or send data to, the internet even if a security group is misconfigured. |
| Network | No subnet auto-assigns public IPv4 addresses | Only the NAT Gateways (Elastic IPs) and the ALB are publicly addressable, and only by explicit design. |
| Network | S3 gateway endpoint policy limited to `s3:GetObject` on the Region's ECR layer bucket | The endpoint serves image pulls only, so it cannot be used to copy data out to an arbitrary bucket. |
| Network | Interface endpoints (prod) for ECR, CloudWatch Logs and Secrets Manager; their security group allows only HTTPS from the VPC CIDR and has no egress | Secret retrieval, image pulls and log delivery stay on the AWS network. |
| Detection | VPC flow logs (all traffic) to a KMS-encrypted log group, 30-day retention in dev, 365 in prod | Lets me investigate rejected or unexpected connections after the fact. Only the account's CloudWatch Logs service can use the key, and the delivery role can only write to that one log group. |
| Data | KMS encryption for RDS, ElastiCache, S3, Secrets Manager and logs | _TBD_ |
| Secrets | Database credentials in Secrets Manager, injected into tasks at start | _TBD_ |
| Transport | ACM certificates, TLS from viewer to CloudFront and from CloudFront to ALB | _TBD_ |
| Edge | AWS WAF managed rule groups and rate limiting | _TBD_ |
| Detection | CloudTrail and GuardDuty | _TBD_ |

## What is not in this repository

No AWS account IDs, access keys, secrets or real domain names are committed. Account-specific values are passed in at deploy time through environment variables or GitHub repository variables.
