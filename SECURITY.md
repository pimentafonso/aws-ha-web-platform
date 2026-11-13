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
| Network | Dev NAT instance: no SSH key or inbound SSH (SSM Session Manager only), IMDSv2 required, encrypted disk, security group allowing only HTTPS in from the VPC and HTTPS out | A cheaper NAT should not become the easiest way into the VPC. Limiting it to port 443 also stops workloads using it for anything other than HTTPS. |
| Detection | VPC flow logs (all traffic) in prod, to a KMS-encrypted log group with 365-day retention. Off in dev (`LoggingMode=minimal`) | Lets me investigate rejected or unexpected connections after the fact. Only the account's CloudWatch Logs service can use the key, and the delivery role can only write to that one log group. Dev carries only test traffic, so I accept the gap there to keep it free. |
| Data | KMS encryption for RDS, ElastiCache, S3, Secrets Manager and logs | _TBD_ |
| Secrets | Database credentials in Secrets Manager, injected into tasks at start | _TBD_ |
| Transport | ACM certificates, TLS from viewer to CloudFront and from CloudFront to ALB | _TBD_ |
| Edge | AWS WAF managed rule groups and rate limiting | _TBD_ |
| Detection | CloudTrail and GuardDuty | _TBD_ |

## What is not in this repository

No AWS account IDs, access keys, secrets or real domain names are committed. Account-specific values are passed in at deploy time through environment variables or GitHub repository variables.
