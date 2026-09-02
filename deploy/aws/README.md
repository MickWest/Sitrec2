# Sitrec on AWS: the hardened deployment module

Terraform for the shape described in
[Installing Hardened Sitrec on AWS](../../docs/dev/Installing-Hardened-Sitrec-on-AWS.md):
one Sitrec task on Fargate behind an Application Load Balancer that
authenticates users by client certificate, in a VPC whose tasks have no route
to the internet, with user data in S3 and every access logged.

The module is written to apply unchanged in any AWS partition. Every ARN,
service principal and endpoint name is built from the `aws_partition`,
`aws_caller_identity` and `aws_region` data sources; no `.tf` file names a
region or a partition. `deploy/aws/lint/` checks a plan against the services
the target partition actually offers.

## What it builds

| Area | Resources |
|---|---|
| Network | VPC; two private subnets (tasks) and two public subnets (balancer only) in two availability zones; internet gateway routed from the public subnets only; **no NAT gateway**; gateway endpoint for S3; interface endpoints for `ecr.api`, `ecr.dkr`, `logs`, `secretsmanager`, `ssmmessages` and, behind `enable_bedrock_endpoint`, `bedrock-runtime`; security groups: balancer 443 in from `client_cidrs`, task 8080 in from the balancer only, endpoints 443 in from the task only |
| Storage | Four buckets (`data`, `mirror`, `truststore`, `logs`): public access blocked, versioning on, bucket owner enforced; a customer-managed KMS key for the first three; S3-managed keys for `logs`, which the log delivery services require; the logs bucket policy for balancer logs, flow logs and the trail; the data bucket policy that denies object access except through the VPC endpoint or from `admin_role_arn` |
| Registry | An ECR repository with immutable tags, scan on push, and its own KMS key |
| Edge | ACM certificate validated by DNS when `route53_zone_id` is set (plus the alias record), otherwise `certificate_arn`; a trust store from your CA bundle with an optional revocation list, both uploaded by Terraform; the balancer with `X-Forwarded-For` removed, invalid header fields dropped, access and connection logs on; a TLS 1.3 listener with mutual TLS in verify mode and CA name advertisement, inserting `Strict-Transport-Security`, `X-Frame-Options`, `X-Content-Type-Options` and `Content-Security-Policy`; target group HTTP 8080, target type `ip`, health check `/` |
| Compute | ECS cluster; task definition (user 1000, port 8080, init process, awslogs) with the hardened environment; service with one task, rolling deployment, private subnets, no public address, ECS Exec behind `enable_exec` |
| IAM | Execution role: the managed ECS execution policy plus decrypt on the registry key. Task role: object read, write and delete on the data and mirror buckets, list on both, generate-data-key and decrypt on the storage key, the session-channel permissions when `enable_exec` is on, model invocation when the Bedrock endpoint is on |
| Observability | Log group with `log_retention_days`; VPC flow logs (all traffic) to the logs bucket; a trail with management events and S3 data events for the data bucket |

## What it deliberately does not do

- **Build or push the image.** The task runs the *derived* image, the Sitrec
  image with the trust store bundle and the user map copied to
  `/etc/sitrec/trust/`. Build it and push it to the repository this module
  creates (`ecr_repository_url` output), then set `image` to its digest.
- **DNS outside Route 53.** With no `route53_zone_id`, point `hostname` at the
  `balancer_dns_name` output yourself and pass an ACM `certificate_arn`.
- **Hold deployment-specific values.** The region, the hostname, the client
  ranges, the authority bundle, the certificate policy identifiers, the
  internal tile services and the administrative role all arrive through a
  `.tfvars` file that git ignores. The tree holds only the two `.example`
  templates.
- **Stage data.** The mirror bucket exists; filling it is section 9 of the
  guide.
- **Open the task's egress.** The task may reach the interface endpoints and
  S3, nothing else. Internal map, elevation and element-set services need a
  rule added to the task security group.

## Variables

Every variable is documented in `variables.tf`. The ones without a default:

| Variable | Meaning |
|---|---|
| `region` | Region to deploy into; the partition follows from it |
| `image` | The derived image, by digest: `sha256:<hex>` (resolved against the module's repository) or a full `<registry>/<repo>@sha256:<hex>` |
| `hostname` | What users type |
| `client_cidrs` | Address ranges admitted at the balancer |
| `trust_store_bundle_path` | Local path to the CA bundle (PEM, no blank lines) |

And one of `route53_zone_id` or `certificate_arn`.

`task_environment` is merged over the hardened defaults (`AUTH_MODE=cert`,
`AUTH_CERT_SOURCE=header`, the trusted-proxy list from the balancer subnets,
the trust file paths, the S3 settings with the role credential source and
server-side reads, chat and telemetry off, the default data sources off,
`LOCAL_DOCS=true`). Put your `AUTH_POLICY_OIDS`, `AUTH_ID_*` and
`SITREC_CUSTOM_*_INTERNAL_*` settings there. Never a secret: the environment
is in the task definition and in state.

## The two variable files

- `rehearsal.tfvars.example`: an ordinary commercial region, `fips = true`,
  `enable_exec = true`, your own test authority. Section 12 of the guide.
- `target.tfvars.example`: the target partition, every value a placeholder.

Copy one to `<name>.tfvars` and fill it in. `*.tfvars` is ignored by git;
the `.example` files are tracked.

## Running it

```
cd deploy/aws
terraform init
terraform plan  -var-file=rehearsal.tfvars -out=plan.tfplan
terraform apply plan.tfplan
```

The repository must hold the image before the service can start. On a fresh
account, create the repository first, push, then apply the rest:

```
terraform apply -var-file=rehearsal.tfvars -target=aws_ecr_repository.sitrec
# build and push the derived image to the ecr_repository_url output
terraform apply -var-file=rehearsal.tfvars
```

`terraform validate` needs no credentials (`terraform init -backend=false`
first). A plan against the target partition can be checked with
`deploy/aws/lint/` before it is applied.

The identity running Terraform needs, beyond the usual create permissions,
read access to the trust store bucket and decrypt on the storage key: the
trust store is created from the uploaded bundle. The key policy delegates to
IAM for the account, so an ordinary administrative role has both.

## Notes

- **State** contains the task environment and every resource id. Keep it in a
  backend with the same protections as the data bucket; the module ships with
  no backend block so the choice is yours.
- **The data bucket policy** denies object reads, writes and deletes unless
  the request arrives through the VPC endpoint or from `admin_role_arn`.
  Bucket configuration and listing are governed by IAM alone, so the
  deploying identity can keep managing the bucket; the objects are what must
  not leave.
- **Changing users** is a rebuild of the derived image and a new `image`
  digest. **Changing the authority bundle or the revocation list** is an
  edit of the local file: Terraform uploads the new version and re-pins the
  trust store to it.
- **`fips = true`** selects FIPS endpoints for the provider, the FIPS TLS 1.3
  security policy on the listener, and `S3_USE_FIPS=true` in the task. Turn it
  off only in a partition without FIPS endpoints.
- The trail is single-region and includes global service events. The logs
  bucket has no expiry rule; add one to taste.
