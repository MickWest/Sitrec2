# Partition lint

The hardened deployment in `deploy/aws/` must run in an AWS partition that lacks some
services and uses a different ARN prefix. The module is written to be partition-neutral:
ARNs are built from `data.aws_partition`, no region or endpoint is a literal, and no
resource type is used that an isolated partition does not offer. This lint is the proof
that it stays so. CI runs the static layer on every push; an operator runs both layers
before an apply.

```
npm run lint-partition                                       # static checks, the CI job
node deploy/aws/lint/partition-lint.mjs --region <r> --plan plan.json   # static + plan checks
```

Exit status is 0 when nothing failed, 1 on any failure, 2 on a usage error (bad
arguments, unreadable plan or snapshot). Findings are printed grouped by check, then a
summary line; add `--json` for machine-readable output.

## Static checks

Run over a set of source roots — by default `deploy/aws`, `sitrecServer`, `src` and
`docker`; override with `--sources <dir>...`. Every text file is read (binary files and
`node_modules`, `vendor`, `.git`, `.terraform` and build output are skipped; symlinked
directories are not followed; the lint's own directory is never scanned). Comments
(`#`, `//`, `/* */`, `<!-- -->`, chosen by file type) are stripped before matching, so a
comment may name any of these. Markdown files are exempt from all of them.

| Check | Where | Result |
|---|---|---|
| `arn-literal` — `arn:aws:` in code | any file | fail |
| `endpoint-literal` — `amazonaws.com` in code | `.tf`, `.tfvars` | fail |
| `endpoint-literal` — `amazonaws.com` in code | every other file | informational |
| `region-literal` — a region name (`us-east-1`, `eu-west-2`, ...) | `.tf`, `.tfvars` | fail |
| `forbidden-resource` — `resource "<type>"` of a type below | `.tf`, `.tfvars` | fail |

`*.tfvars.example` files are exempt from the region check: they show an operator what to
fill in. The application has endpoint hostnames in PHP and JavaScript on purpose — it
parses and generates commercial S3 URLs, with tests — so those are reported for
awareness, never as failures.

Forbidden resource types: `aws_cloudfront_*`, `aws_apprunner_*`, `aws_amplify_*`,
`aws_lightsail_*`, `aws_nat_gateway`. Either the service does not exist in the target
partition or the design of an isolated deployment excludes it.

## Plan checks

```
cd deploy/aws
terraform plan -out plan.tfplan
terraform show -json plan.tfplan > plan.json
node ../../deploy/aws/lint/partition-lint.mjs --region <target region> --plan plan.json
```

Every `resource_changes[].type` in the plan (except resources being deleted) is mapped to
an AWS service code with `RESOURCE_SERVICE_MAP` in `partition-lint.mjs`. Resource types
from other providers (`random_*`, `tls_*`, ...) are ignored; `aws_partition`,
`aws_region` and the like are provider metadata and make no service call.

| Check | Result |
|---|---|
| `service-availability` — a used service is absent from the region's snapshot | fail |
| `service-availability` — the snapshot is for a different region than `--region` | fail |
| `unknown-resource-type` — an `aws_*` type not in the map (named, so the map can grow) | warning |
| `forbidden-resource` — a forbidden type in the plan (same list as above) | fail |
| `plan-arn-literal` — `arn:aws:` in any planned value, output or variable | fail |
| `plan-endpoint-region` — a hostname ending in `amazonaws.com` whose region segment is not the target region | fail |

A hostname with no region segment (a service principal such as
`ecs-tasks.amazonaws.com`) is partition-independent and passes. Run the plan against the
target region: most ARNs are then "known after apply", so what the value scan catches is
exactly the literals that came from configuration.

The map (resource type prefix → service code, as named in the snapshot):

| Resource types | Service |
|---|---|
| `aws_lb*`, `aws_alb*`, `aws_elb*` (listeners, target groups, trust stores) | `elasticloadbalancing` |
| `aws_ecs_*` | `ecs` |
| `aws_ecr_*` | `ecr` |
| `aws_s3_*` | `s3` |
| `aws_kms_*` | `kms` |
| `aws_iam_*` | `iam` |
| `aws_cloudwatch_log_*` | `logs` |
| `aws_cloudwatch_event_*` | `events` |
| other `aws_cloudwatch_*` | `cloudwatch` |
| `aws_cloudtrail*` | `cloudtrail` |
| `aws_acm_*` | `acm` |
| `aws_route53_*` | `route53` |
| `aws_vpc*`, `aws_subnet*`, `aws_route*`, `aws_internet_gateway*`, `aws_nat_gateway`, `aws_security_group*`, `aws_vpc_endpoint*`, `aws_flow_log`, `aws_network_acl*`, `aws_eip*`, `aws_default_*`, `aws_ami*`, `aws_instance`, `aws_launch_template`, `aws_availability_zones` | `ec2` |
| `aws_secretsmanager_*` | `secretsmanager` |
| `aws_ssm_*` | `ssm` |
| `aws_sns_*` / `aws_sqs_*` / `aws_lambda_*` / `aws_dynamodb_*` | `sns` / `sqs` / `lambda` / `dynamodb` |
| `aws_db_*`, `aws_rds_*` | `rds` |
| `aws_efs_*` / `aws_elasticache_*` | `efs` / `elasticache` |
| `aws_appautoscaling_*` / `aws_autoscaling_*` | `application-autoscaling` / `autoscaling` |
| `aws_wafv2_*` | `wafv2` |
| `aws_cloudfront_*` / `aws_apprunner_*` / `aws_amplify_*` / `aws_lightsail_*` | `cloudfront` / `apprunner` / `amplify` / `lightsail` |
| `aws_caller_identity` | `sts` |
| `aws_partition`, `aws_region`, `aws_regions`, `aws_default_tags`, `aws_arn`, `aws_service`, `aws_service_principal` | none (metadata) |

When the lint warns about an unknown type, add a row: the service code is the last path
segment of the matching `/aws/service/global-infrastructure/regions/<r>/services/<code>`
parameter, which a fresh snapshot lists.

## The services snapshot

The list of services a region offers comes from AWS's public global-infrastructure
parameters in Systems Manager Parameter Store. They can only be queried from a
commercial region, whatever region they describe, so the query always goes through
`us-east-1` (override with `--source-region`). Any credentials that can call
`ssm:GetParametersByPath` in a commercial account will do.

```
node deploy/aws/lint/refresh-services.mjs --region <target region>
node deploy/aws/lint/refresh-services.mjs --region <r1> --region <r2> --profile <name>
```

This writes `deploy/aws/lint/snapshots/<region>.json`:

```json
{ "region": "<region>", "fetchedAt": "<ISO timestamp>", "services": ["acm", "ec2", "..."] }
```

`partition-lint.mjs --region <r>` reads `snapshots/<r>.json` by default; point
`--snapshot <file>` at another location if you keep them elsewhere. The tool shells out to
the AWS CLI (`aws` on `PATH`, or the binary named by `AWS_CLI`) rather than adding an SDK.

**Snapshots are never committed.** `snapshots/` is gitignored in the repository root
`.gitignore`, because a snapshot names the target region and partition. Refresh it before
every plan check; the report prints the `fetchedAt` timestamp it used.

## Tests

`npx jest tests/partitionLint.test.js` runs both tools as child processes over fixture
trees, plans and snapshots (Jest maps every `.mjs` import to a stub, so the exported
functions are exercised through `node --input-type=module`). Fixture region names are
invented (`xx-isolated-1`, `xx-other-9`).
