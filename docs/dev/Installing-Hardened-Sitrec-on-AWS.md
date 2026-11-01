# Installing Hardened Sitrec on AWS

A hardened Sitrec deployment is a full-server install whose application tasks have no
default route to the internet. A public load balancer terminates HTTPS and authenticates
every user with a client certificate; private object storage holds user files; and external
data is used only when the operator stages an approved source on a reachable service. This
guide describes how to build, deploy, configure and verify that shape on AWS. It is written
for a person doing the deployment and for an automated agent maintaining it, so every
setting is named, the commands for the application steps are given, and the status table
below says exactly which parts exist in this release.

It complements, and does not replace, the general [install guide](Installing-and-configuring.md),
the [secure build](Secure-Build.md) reference, and the [VPS guide](Deploying-on-a-VPS.md),
which runs the published standard image on a single host with a public reverse proxy. In
this guide the **secure build** is what `npm run build-secure` makes, and a **standard
build** is any other build.

Everything here uses only generic AWS features. The region, the partition (which decides
the ARN prefix and whether FIPS endpoints are expected) and the certificate authority are
values you supply; the Terraform module assumes none of them.

## Status of this guide

| Part | State | Where |
|---|---|---|
| Secure build (`npm run build-secure`, outbound features removed or closed at compile time, forced-off settings, runtime overrides can only tighten) | **Available** | `webpack.secure.js`, `scripts/secureClientEnv.js`, `src/secureStubs/`, [Secure-Build.md](Secure-Build.md) |
| Packaging the secure build into the standard image | **Available** | `Dockerfile.release` with `--build-arg DIST_DIR=dist-secure` |
| Client certificate authentication (`AUTH_MODE=cert`) behind a load balancer or Apache | **Available** | `sitrecServer/auth_cert.php`, `config/config.php.example`, section 7 |
| Object storage with role credentials, FIPS endpoints, or a custom endpoint | **Available** | `sitrecServer/s3_client.php`, section 6 |
| Same-origin object reads with a private bucket (`s3-proxy.php` signed stream) | **Available** | `sitrecServer/s3-proxy.php` |
| Reverse-proxy scheme handling (`X-Forwarded-Proto`) | **Available** | `sitrecServer/requestScheme.php` |
| Egress tripwire on the built artifact | **Available** | `scripts/auditBundleEgress.js`, runs in `postbuild-secure` |
| Infrastructure as code (one Terraform module, partition-neutral: network, endpoints, registry, buckets, balancer with mutual TLS, service, roles, logs, trail) | **Available** | `deploy/aws/`, section 8 |
| Partition lint (static checks in CI on every push; plan checks against a services snapshot for the target region) | **Available** | `deploy/aws/lint/`, section 12 |
| Trust store and user map fetched at container start | Planned; use a derived image for now (section 8.3) | `docker/entrypoint.sh` |
| Server endpoint allow-list in the secure build (the proxies to public data providers, assistant relays, diagnostics and telemetry writers are not packaged; `proxy.php` and `customWindProxy.php` stay, for your own services (section 9); the audit checks the packaged tree and the identity seam) | **Available** | `scripts/secure-server-allowlist.json`, `webpackCopyPatterns.js`, `scripts/auditBundleEgress.js` |
| Mirror endpoint for staged map, elevation, element-set and wind data | Planned; use the custom-source settings against your own service for now (section 9) | `sitrecServer/mirror.php` |
| Response security headers | Partly: the image sets `X-Content-Type-Options` and `Referrer-Policy`; set the others at the load balancer (section 8.1) | `docker/security-headers.conf`, [SecurityHeaders.md](SecurityHeaders.md) |
| Structured audit log (`SITREC_AUDIT` records, always on with `AUTH_MODE=cert`) | **Available** | `sitrecServer/audit.php`, [AuditLogging.md](AuditLogging.md) |
| Session idle timeout, in-application revocation | Planned; the load balancer does revocation | |
| Assistant through an in-partition model service | Planned; keep `CHATBOT_ENABLED=false` | `sitrecServer/chatbot.php` |
| Canonical base URL setting instead of the `Host` header | Planned | `sitrecServer/config_paths.php` |

When a planned row becomes available, update this table, the section it points to, and
the "Maintaining this guide" section at the end.

## 1. The shape

```
user's browser, with a client certificate on a hardware token or in the OS store
        |  HTTPS, mutual TLS
        v
Application Load Balancer, HTTPS listener, mutual TLS in "verify" mode
   - server certificate from ACM (or imported)
   - trust store: your certificate-authority bundle (PEM, in S3) + revocation lists
   - forwards the verified leaf certificate in a request header
   - inserts the security response headers
   - access and connection logs to S3
        |  HTTP 8080, private subnets; the target security group admits only the balancer
        v
ECS service on Fargate, one task, the Sitrec image from your ECR
   - AUTH_MODE=cert; the trusted-proxy list is the balancer's subnets
   - saves go to S3 with the task role; reads come back through the same origin
   - no default route out; interface endpoints for ECR, logs, secrets; gateway endpoint for S3
        |
        +--> S3 bucket "data": user saves; private; Block Public Access; SSE-KMS

browser --> your own map and elevation services (direct browser requests)
task    --> your own current element-set and wind services (server-side proxies)
```

Only the load balancer subnets have an internet-gateway route. The application tasks are in
private subnets with no default route and no NAT gateway. Section 9 explains which custom
data requests originate in the browser and which originate in the task.

Why this shape: there is no host to patch, the image already runs as any user on port
8080, configuration is environment, saved sitches and user settings are in S3, and the
container's standard output is the log. The balancer does the part an assessor checks first, chain validation
and revocation, in a managed and logged way. The application does what only it can do:
identity extraction, policy check, user mapping.

A single-host variant uses the [VPS guide](Deploying-on-a-VPS.md)'s layout with three
changes: nginx instead of Caddy in front (nginx validates client certificates and checks
revocation; Caddy does not without a module), your secure image instead of the published
image, and no automatic update. The settings in this guide apply, except those tied to AWS:
`AUTH_CERT_HEADER` and `AUTH_TRUSTED_PROXIES` follow your nginx configuration, and storage
credentials follow your host.

## 2. Before you start

You need:

- An AWS account in the target partition, with permissions for VPC, ECR, ECS, ELB, ACM, S3,
  KMS, IAM, CloudWatch Logs and CloudTrail. Note the partition name and region:

  ```
  aws sts get-caller-identity
  aws ec2 describe-regions --region <any region you can use> --query 'Regions[].RegionName'
  ```

  The partition is the second field of the `Arn` that the first command prints. The ARN
  prefix is `arn:aws` in commercial regions and differs in other partitions; every
  policy below writes it as `PARTITION`. Every command below reads the region and account
  from your shell, so set them once:

  ```
  export AWS_REGION=<region>                 # the AWS CLI and SDKs read this
  export ACCOUNT=$(aws sts get-caller-identity --query Account --output text)
  export AWS_USE_FIPS_ENDPOINT=true          # if your partition expects FIPS endpoints
  export DNS_SUFFIX=amazonaws.com            # your partition's DNS suffix, if it differs
  export REGISTRY=$ACCOUNT.dkr.ecr.$AWS_REGION.$DNS_SUFFIX
  ```
- A DNS name for the site and a way to get a server certificate for it: ACM public issuance
  with DNS validation where available, otherwise a certificate from your own authority
  imported into ACM.
- Your client-certificate authority's bundle (root and intermediates, PEM) and its
  revocation list(s). See section 8.2 for the format rules the balancer enforces.
- A user map: which certificate identifiers may log in, and as which Sitrec user and groups.
  Section 7.3.
- A machine that can build the image (Node 22, Docker or Podman) and push to ECR, or a
  way to carry a saved image in (section 5.3). For the image review in section 4.1, also
  install `trivy` and `syft`. To use `deploy/aws/`, install Terraform 1.9 or newer;
  `terraform init` installs the module's AWS provider constraint (`~> 6.0`).
- Optionally, an internal map tile service and elevation service to point the app at.
  Without one the map is blank, by design, and the first tile error says so: it names the
  directory or service it expected, the setting that points at it, and the container mount
  point for pre-downloaded tiles.

### Choose a route

There are two ways to make the AWS resources. Choose one before you continue.

- **The Terraform module in `deploy/aws/`.** It creates the registry repository, the keys,
  the buckets, the network, the balancer and the service. Do sections 3 and 4. Run the first
  apply in section 8 to create the repository, and push the image (section 5.2). Then build
  and push the derived image (section 8.3) and do the full apply. Do not run the create
  commands in sections 5.1, 6.1, 6.2, 8.1 and 8.4: those sections describe what the module
  makes.
- **By hand.** Do every section in order, and do not use `deploy/aws/`.

Sections 7, 8.2, 8.3 and 9 to 11 apply to both routes.

## 3. Make the secure build

The hardened deployment runs the secure build, not a standard build. The difference is
compile-time: the modules that call external services are replaced with inert stubs, the
default map, elevation and element-set sources are disabled, every provider key is blank,
and a runtime setting can only make a security flag more restrictive, never less.
[Secure-Build.md](Secure-Build.md) has the full list.

```
npm ci
cp -n config/config-install.js.example config/config-install.js
cp -n config/config.js.example config/config.js
# writes dist-secure/ and runs the notices, secret and egress audits
SITREC_SHARED_ENV=config/shared.env.example npm run build-secure
```

A clean clone has no live configuration. The two copies give the build its local paths and
client defaults. `SITREC_SHARED_ENV` selects the example settings file, so the bundle and
the image hold only placeholders. Deployment settings arrive at container start.

The egress audit fails the build if the emitted code contains a hostname that is not on
`scripts/secure-egress-allowlist.json`, if a source map is present, or if any removed module's
marker is missing. A failure here is a finding, not something to allow-list. A passing run
prints what remains, by class: inert literals (namespaces, library links), gated ones (built-in
providers closed by the forced source flags, external links closed by the build flag), and
the one link a user may click. Read that summary once; it is the artifact's disclosure
surface.

The audit also checks the packaged server tree against `scripts/secure-server-allowlist.json`:
only the listed files may be present, the required includes must be present, and the packaged
`config.php` must carry the client certificate authentication seam. That last check exists
because a checkout's own `config/config.php` is never what the secure build ships; the
build always packages the tracked `config/config.php.example` and says so when it skips a
local copy.

Sanity check before packaging:

```
ls dist-secure/sitrecServer/
grep -c "__SITREC_SECURE_STUB__" dist-secure/*.bundle.js
```

The first should list about two dozen files, and no `chatbot.php`, `proxyADSBLive.php`,
`streetview.php` or `info.php`. `vendor/` appears only if your checkout has it; the image
build adds it. The second prints one line per bundle. Most show 0. At least one must show a
count above 0.

## 4. Build the image

`Dockerfile.release` packages a pre-built output directory. Point it at the secure build:

```
docker build -f Dockerfile.release --platform linux/amd64 \
    --build-arg DIST_DIR=dist-secure --build-arg WITH_GFS_WIND=0 -t sitrec-hardened:local .
```

`--platform linux/amd64` matches the task definition, which declares `X86_64`. Without it an
ARM machine, such as an Apple-silicon Mac, builds an image that cannot start (section 8.3).
`WITH_GFS_WIND=0` leaves out Python and the GRIB decoder. They serve only `windProxy.php`,
which the secure build does not package.

The image is the same runtime as every other Sitrec container: PHP 8.4 with Apache, the
entrypoint that turns environment variables into `shared.env.php` and the page's runtime
settings, port 8080, any UID. Nothing at container start touches the network.

If your environment mandates a particular base image, add
`--build-arg BASE_IMAGE=<registry>/<image>:<tag>`. It must be a Debian-family PHP 8.4 Apache
image with the helpers of the official image: `apt-get`, `docker-php-ext-install`, `a2enmod`,
`apache2-foreground` and `docker-php-entrypoint`. It must also provide the PHP `curl`,
`openssl` and `simplexml` extensions, because the build does not add them. The build also
pulls `composer:2` for the PHP dependencies; to change that image, edit its `FROM` line. The
project's CI tests only the default base, so review the result as in section 4.1.

The task definition pins an image **digest**, not a tag. A digest exists only once the image
is in a registry, so record it after the push in section 5:

```
aws ecr describe-images --repository-name sitrec --image-ids imageTag=<version> \
    --query 'imageDetails[0].imageDigest' --output text
```

If you add the trust store and user map as a derived image (section 8.3), that derived
image has its own digest, and **that** is the one the task definition must pin. Pinning the
base image's digest deploys a container without the trust files, and every login is refused
with `no_trust_store`.

### 4.1 Review the image

Before the image goes anywhere, review it:

```
npm run audit-container -- --image=sitrec-hardened:local --profile=published
```

> **If you followed an earlier version of this guide, re-run that command.** It used to say
> `--profile=site`, on the reasoning that a locally built hardened image carries its own
> configuration. Built as in section 3, it does not — see the paragraph below — and `site`
> is the *laxer* reading: it reports a baked-in credential as a handling requirement rather
> than as a defect. An audit run that way was more permissive than the image warranted.
> Re-run it without `--profile=site` and read the result; nothing else about your deployment
> is affected.

This writes a report, a bill of materials and the supporting evidence to `dist-audit/`. It
is the document to give whoever must accept the image, and it is worth reading yourself
first: it states what the image runs as, what the base image brings with it, which package
advisories a rebuild would close, and the runtime restrictions the image will tolerate —
which is the raw material for the task definition in section 8.4.

The secure build packages `config/shared.env` when the checkout has one, and
`config/shared.env.example` otherwise. A value in that file stays in the image layer, even
though the entrypoint rewrites the file at start. Build with
`SITREC_SHARED_ENV=config/shared.env.example` (section 3), and supply deployment settings
from the environment at container start. With that build, the strict `--profile=published`
is the right profile even for a locally built hardened image. Use `--profile=site` only if
you deliberately build a different image with the deployment's live configuration compiled
in. That profile still reports every credential-shaped value, but treats it as a handling
requirement: the image becomes as sensitive as its contents and belongs only in a registry
with matching read controls. See [Container Security Review](Container-Security-Review.md).
On an isolated network, follow its
[offline-database section](Container-Security-Review.md#running-inside-an-isolated-network).

### 4.2 Verify where the image came from

An image you built yourself needs no provenance check. An image you **pulled** does, and the
published ones carry a Sigstore-signed attestation naming the workflow, the commit and the
runner that produced that exact digest:

```
gh attestation verify oci://ghcr.io/mickwest/sitrec2:<tag> --repo MickWest/Sitrec2
```

This is worth doing before the image enters your registry, and worth recording in the
acceptance evidence alongside the digest from section 5. It answers a question the digest
alone cannot: not "are these the bytes I recorded" but "did these bytes come from that
source, built by that pipeline". Both architectures carry one.

The review from section 4.1 covers the rest of what a reviewer usually asks — it is
organised by the control areas of NIST SP 800-190 and ships a CycloneDX bill of materials
per architecture. See [Container Security Review](Container-Security-Review.md).

### 4.3 Run it as a non-root user

The image declares no `USER`, so by default it runs as root. It does not need to: it
listens on the unprivileged port 8080 and its writable paths are world-writable precisely so
that any assigned UID can use them. **Give it a non-root identity and it works unchanged** —
Apache starts, the entrypoint still rewrites `shared.env.php`, `index.html` and the runtime
settings script, and the files it creates are owned by that user:

```
docker run --user 1000 -p 8080:8080 <image>@<digest>
```

In a task definition, set `"user": "1000"` on the container (section 8.4 and the module do
this); in Kubernetes, use `securityContext.runAsUser: 1000` with `runAsNonRoot: true`. The
review's derived runtime policy prints the full set of restrictions the image accepts.
`CFG-01` reports the image's default, so it stays open in the review after you do this. This
setting is the deployment's answer to that finding; record it in the acceptance evidence. A
hardened deployment should do this.

Why it is not the image's default: when the container runs as root the entrypoint adds a
second listener on port 80, so that port mappings written before this image moved to 8080
keep working. Running non-root removes that listener. If you have inherited a mapping of the
form `-p 8080:80`, it must become `-p 8080:8080` at the same time — otherwise the container
starts, reports itself healthy, and serves nothing, because Docker is forwarding to a port
inside the container that nothing is listening on. The container log says so in a banner at
start-up. New installs are unaffected; the shipped `docker-compose.yml` already maps
`8080:8080`.

## 5. Put the image in your registry

### 5.1 Create the repository

With the Terraform module, skip this step: the module creates the repository
([Choose a route](#choose-a-route)).

```
aws ecr create-repository --repository-name sitrec \
    --image-tag-mutability IMMUTABLE --image-scanning-configuration scanOnPush=true \
    --encryption-configuration encryptionType=KMS
```

### 5.2 Push from a connected machine

```
aws ecr get-login-password | docker login --username AWS --password-stdin $REGISTRY
docker tag sitrec-hardened:local $REGISTRY/sitrec:<version>
docker push $REGISTRY/sitrec:<version>
```

Then record the digest (section 4).

### 5.3 Carry it in (no connected machine inside)

On the connected side, following the air-gapped section of the install guide:

```
docker save sitrec-hardened:local -o sitrec-image.tar
sha256sum sitrec-image.tar > sitrec-image.tar.sha256
```

Inside, after verifying the checksum:

```
docker load -i sitrec-image.tar
docker tag sitrec-hardened:local $REGISTRY/sitrec:<version>
docker push $REGISTRY/sitrec:<version>
```

### 5.4 Pull-through cache from the public registry

Where policy allows the registry service to fetch from `ghcr.io` on your behalf, an ECR
pull-through cache rule for `ghcr.io/mickwest/sitrec2` avoids pushing at all. Note that the
published public image holds a **standard** build, not the secure build; use it only for a
rehearsal, or build your own secure image as above.

## 6. Storage

With the Terraform module, skip sections 6.1 and 6.2: the module creates the buckets, the
key and the policies, under its own names. Section 6.3 applies to both routes.

### 6.1 Buckets

Create the data bucket with public access blocked, versioning on, and a customer-managed
KMS key. Turn on rotation for the key. The module's
[`storage.tf`](https://github.com/MickWest/Sitrec2/blob/main/deploy/aws/storage.tf) has the
exact key and bucket policy statements for all the buckets.

```
# In us-east-1 omit the --create-bucket-configuration option; there it is an error.
aws s3api create-bucket --bucket <data-bucket> \
    --create-bucket-configuration LocationConstraint=$AWS_REGION
aws s3api put-public-access-block --bucket <data-bucket> --public-access-block-configuration \
    BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true
aws s3api put-bucket-versioning --bucket <data-bucket> --versioning-configuration Status=Enabled
aws s3api put-bucket-encryption --bucket <data-bucket> --server-side-encryption-configuration \
    '{"Rules":[{"ApplyServerSideEncryptionByDefault":{"SSEAlgorithm":"aws:kms","KMSMasterKeyID":"<key-arn>"}}]}'
aws s3api put-bucket-ownership-controls --bucket <data-bucket> \
    --ownership-controls 'Rules=[{ObjectOwnership=BucketOwnerEnforced}]'
```

A second bucket, same treatment, holds the balancer's trust-store bundle and revocation
lists; its policy must also let the load-balancing service read them. The key policy must
also let that service decrypt: principal `elasticloadbalancing.<dns suffix>`, action
`kms:Decrypt`, with conditions `aws:SourceAccount` equal to your account and `kms:ViaService`
equal to `s3.<region>.<dns suffix>`.

A third bucket receives the balancer's access and connection logs, the VPC flow logs and
the CloudTrail trail. It is **different** in two ways, because the delivery services write
to it: encrypt it with S3-managed keys (`AES256`), not a customer-managed KMS key, and give
it the bucket policy that the load balancer access-logging page prescribes for your region:
an `s3:PutObject` grant on `<logs-bucket>/alb/access/AWSLogs/<account>/*` and
`<logs-bucket>/alb/connection/AWSLogs/<account>/*` to the regional load-balancer account, or
to the `logdelivery.elasticloadbalancing.<dns suffix>` service principal in regions that use
it; plus the `delivery.logs.<dns suffix>` grant for flow logs and the `cloudtrail.<dns suffix>`
grant for the trail. Keep public access blocked and versioning on as for the others.

The module also creates a fourth, empty `mirror` bucket for the planned mirror endpoint
(section 9). A build by hand does not need it.

### 6.2 Bucket policy

Deny object access that does not arrive through your VPC endpoint, unless it comes from the
administrator role you name. The task role uses the endpoint and needs no exception. Bucket
configuration and listing stay with IAM, so the identity that deploys can keep managing the
bucket.

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "ObjectsOnlyThroughTheEndpoint",
      "Effect": "Deny",
      "Principal": "*",
      "Action": ["s3:GetObject", "s3:GetObjectVersion", "s3:GetObjectAttributes",
                 "s3:GetObjectVersionAttributes", "s3:PutObject", "s3:DeleteObject",
                 "s3:DeleteObjectVersion"],
      "Resource": "arn:PARTITION:s3:::<data-bucket>/*",
      "Condition": {
        "StringNotEquals": {"aws:SourceVpce": "<vpce-id>"},
        "ArnNotLike": {"aws:PrincipalArn": "arn:PARTITION:iam::<account>:role/<admin-role>"}
      }
    }
  ]
}
```

```
aws s3api put-bucket-policy --bucket <data-bucket> --policy file://data-bucket-policy.json
```

### 6.3 How Sitrec uses the bucket

With the settings in section 8.4:

- Saves and uploads go **through the server** (`rehost.php` writes with the task role).
  `USE_S3_PRESIGNED_URLS=false` keeps the browser from being sent directly to the S3
  endpoint, which it usually cannot reach in an isolated network. This path is limited by
  PHP's `upload_max_filesize` and `post_max_size`. The image sets neither, so the PHP
  defaults of 2 MB and 8 MB apply, and a larger file does not upload. Raise them in the
  derived image (section 8.3).
- Reads come back **through the same origin**. `S3_READS_VIA_SERVER=true` makes the server
  answer every object reference with a `s3-proxy.php` URL on the application itself, which
  streams the object with the task role's credentials; range requests work, so video seeks
  work. Without it the server would hand the browser a presigned storage URL, which the
  browser cannot reach here.
- Objects are private at the storage layer: no public URL exists.
  `S3_DEFAULT_VISIBILITY=private` and empty ACL settings mean no ACL is ever sent, which is
  what Bucket Owner Enforced requires. Inside the site, an object key is a read capability.
  Sitrec does not check the owner on a read, so a caller who reaches `s3-proxy.php` with a
  complete key can read that object. See
  [File rehosting](FileRehosting.md#stable-object-references).
- The client is built once per request by `sitrecServer/s3_client.php` from these settings:

| Setting | Value here | Meaning |
|---|---|---|
| `S3_BUCKET`, `S3_REGION` | your values | the data bucket and its region |
| `S3_CREDENTIAL_SOURCE` | `role` | no keys in the configuration; the SDK's default chain finds the task role |
| `S3_USE_FIPS` | `true` | use the region's FIPS endpoint; set it explicitly, so that the configuration does not depend on the region default |
| `S3_READS_VIA_SERVER` | `true` | every object read is a same-origin `s3-proxy.php` URL; the browser never receives a storage URL |
| `S3_ENDPOINT` | unset | only for an S3-compatible store or a local test double |
| `S3_USE_PATH_STYLE` | unset | only with `S3_ENDPOINT` |

`S3_ACCESS_KEY_ID` and `S3_SECRET_ACCESS_KEY` are **not set** in this deployment.

## 7. Client certificate authentication

### 7.1 How it works

The balancer terminates mutual TLS. In "verify" mode it validates the client certificate
chain against the trust store and the revocation lists, refuses the connection otherwise,
and forwards the verified leaf certificate to the target in the request header
`X-Amzn-Mtls-Clientcert-Leaf` (URL-encoded PEM), plus subject, issuer, serial and validity
headers. Sitrec ignores those extra headers and works from the leaf alone.

`sitrecServer/auth_cert.php` then runs these checks, in order, and refuses at the first
failure with a fixed reason token that is written to the container log:

1. The request came from a trusted proxy (`AUTH_TRUSTED_PROXIES`; an empty list refuses
   every header, which is the safe default).
2. A certificate is present.
3. It parses.
4. It chains to `AUTH_TRUST_STORE` for the client-authentication purpose.
5. It is within its validity window.
6. Its extended key usage names client authentication (`AUTH_REQUIRE_CLIENT_EKU`).
7. It carries one of the configured certificate policy identifiers (`AUTH_POLICY_OIDS`), when
   that list is set.
8. An identifier is extracted (`AUTH_ID_SOURCE`) and matches `AUTH_ID_PATTERN`.
9. The identifier is in the user map (`AUTH_USER_MAP`).

Only then does the request carry a user id and groups. Under `AUTH_MODE=cert` the
`SITREC_DEFAULT_USERID` fallback and the loopback-administrator rule are unreachable.

A refusal does not stop the request. The request continues as anonymous (user 0): the page
loads, saves are refused with 401, and `s3-proxy.php` still serves an object to a caller who
has its key. Access to the site is decided at the balancer, so the trust store and the
allowed address ranges set who can reach it.

The application re-verifies the chain, validity and identity of the leaf. It does not check
revocation, and a certificate in a header does not prove that the sender holds the private
key. Protection against a forged header therefore comes from the trusted-proxy check, the
target security group and the balancer's handshake: in verify mode no request reaches the
target without a valid handshake, and the target security group admits only the balancer.

### 7.2 Settings

This table gives the value for this deployment. The install guide's
[Client certificate authentication](Installing-and-configuring.md#client-certificate-authentication)
section gives the meaning and the default of each setting.

| Setting | Value here |
|---|---|
| `AUTH_MODE` | `cert` |
| `AUTH_CERT_SOURCE` | `header` |
| `AUTH_CERT_HEADER` | `X-Amzn-Mtls-Clientcert-Leaf` |
| `AUTH_TRUSTED_PROXIES` | the balancer's subnet CIDRs, comma-separated |
| `AUTH_TRUST_STORE` | `/etc/sitrec/trust/ca-bundle.pem` |
| `AUTH_POLICY_OIDS` | your policy identifiers, comma-separated |
| `AUTH_ID_SOURCE` | `san_principal,cn_suffix` |
| `AUTH_ID_PATTERN` | a pattern matching your identifiers exactly |
| `AUTH_USER_MAP` | `/etc/sitrec/trust/users.json` (section 7.3) |
| `AUTH_REQUIRE_CLIENT_EKU` | `true` |

### 7.3 The user map

A JSON object keyed by identifier. Groups use Sitrec's numbers: 3 administrator, 2
registered, 9 verified, 14 sitrec.

```json
{
  "1234567890": { "user_id": 42, "groups": [2, 14] },
  "2345678901": { "user_id": 43, "groups": [3, 2, 14, 9] }
}
```

Choose small opaque user ids. Each must be a positive JSON integer, not a string. The user
id becomes the first path segment of every object the user saves, so never use the
certificate identifier itself as the user id.

Saving needs only a mapped user. Give group 3 only to administrators: a member can act as
any other user by adding `testUserID=<id>` to a request, and each use is written to the
audit log.

### 7.4 What the log shows

One `SITREC_AUDIT` record per identity resolution, with `event` set to `authentication`, in
the container log (CloudWatch). This stream is always on in certificate mode. Apache adds
its own prefix to each line; the JSON follows the `SITREC_AUDIT` marker:

```
… SITREC_AUDIT {"schema":"sitrec.audit.v1","timestamp":"…","request_id":"…","instance":"…","endpoint":"rehost.php","method":"GET","remote_addr":"10.40.128.23","actor_id":42,"effective_user_id":42,"event":"authentication","outcome":"accepted","reason":"ok","resource_sha256":null,"auth":"cert","identifier_sha256":"3f2a…"}
… SITREC_AUDIT {"schema":"sitrec.audit.v1","timestamp":"…","request_id":"…","instance":"…","endpoint":"rehost.php","method":"GET","remote_addr":"10.40.128.23","actor_id":0,"effective_user_id":0,"event":"authentication","outcome":"refused","reason":"identifier_unmapped","resource_sha256":null,"auth":"cert","identifier_sha256":"9b1c…"}
```

The same request also writes other events, such as `identity.read`.
[Server audit logging](AuditLogging.md) lists the events, and its
[Record format](AuditLogging.md#record-format) section lists the fields. The install guide's
[Client certificate authentication](Installing-and-configuring.md#client-certificate-authentication)
section lists the refusal reasons.

The identifier never appears in the log. Its full SHA-256 does, so you can correlate. A short
numeric identifier can be guessed and hashed, so protect the log.

### 7.5 What the application does not do yet

Revocation is the balancer's job (revocation lists in the trust store). Session idle
timeout is planned. Logout on a certificate-authenticated site is limited by the browser's
TLS session cache; tell users that a full logout means closing the browser.

## 8. The load balancer, the network and the service

The Terraform module in `deploy/aws/` builds everything in this section, and also the
registry repository, the keys and the buckets, from one variables file; its README has the
variables and the two-stage first apply (create the registry, push the derived image, apply
the rest). The steps below are the same resources described one by one, for reading the
module, for a console build, and for checking what the module made. Names in angle brackets
are yours.

```
cd deploy/aws
cp target.tfvars.example target.tfvars      # fill in; this file is ignored by git
terraform init

# First apply in a new account: create the repository, push the image (section 5.2),
# then build and push the derived image from section 8.3 and put its digest in
# target.tfvars.
terraform apply -var-file=target.tfvars -target=aws_ecr_repository.sitrec

# Full reviewed apply.
terraform plan -var-file=target.tfvars -out plan.tfplan
terraform show -json plan.tfplan > plan.json
node lint/refresh-services.mjs --region <region>                  # needs a commercial-region credential; section 12
node lint/partition-lint.mjs --region <region> --plan plan.json   # section 12
terraform apply plan.tfplan
```

### 8.1 Load balancer

1. VPC with two private subnets (tasks) and two subnets for the balancer, no NAT gateway,
   a gateway endpoint for S3, and interface endpoints for `ecr.api`, `ecr.dkr`, `logs`,
   `secretsmanager` and `ssmmessages` (the last one carries the shell used by checks 7
   and 11). Security groups: balancer 443 in from your users' address ranges; task 8080 in
   from the balancer's security group only; endpoints 443 in from the task.
2. ACM certificate for `<hostname>`.
3. Trust store from your CA bundle, then the revocation list:

   ```
   aws elbv2 create-trust-store --name sitrec-clients \
       --ca-certificates-bundle-s3-bucket <trust-bucket> --ca-certificates-bundle-s3-key ca-bundle.pem
   aws elbv2 add-trust-store-revocations --trust-store-arn <trust-store-arn> \
       --revocation-contents "S3Bucket=<trust-bucket>,S3Key=crl-root.pem,RevocationType=CRL"
   aws elbv2 add-trust-store-revocations --trust-store-arn <trust-store-arn> \
       --revocation-contents "S3Bucket=<trust-bucket>,S3Key=crl-intermediate.pem,RevocationType=CRL"
   ```

   One CRL per file, one call per file (section 8.2).

4. Application Load Balancer, target group (HTTP, port 8080, target type `ip`, health check
   path `/`, which returns the page to anyone; never use `sitrecServer/info.php`, the secure
   build does not contain it), HTTPS listener with the ACM certificate, a TLS 1.3 security
   policy (the module uses `ELBSecurityPolicy-TLS13-1-3-FIPS-2023-04`, or
   `ELBSecurityPolicy-TLS13-1-3-2021-06` with FIPS off) and mutual TLS in verify mode:

   ```
   aws elbv2 modify-listener --listener-arn <listener-arn> \
       --mutual-authentication "Mode=verify,TrustStoreArn=<trust-store-arn>,AdvertiseTrustStoreCaNames=on"
   ```

   Advertising the CA names makes the browser's certificate picker show only certificates
   from your authority, which removes the commonest user error.
5. Listener attributes: rename the certificate headers to a private name if you want an
   extra margin against header injection (then set `AUTH_CERT_HEADER` to match), and
   insert these response headers: `Strict-Transport-Security`, `X-Frame-Options: DENY`,
   `X-Content-Type-Options: nosniff`, and a `Content-Security-Policy`. The image itself sets
   only `X-Content-Type-Options` and `Referrer-Policy`. See AWS's
   [HTTP header modification documentation](https://docs.aws.amazon.com/elasticloadbalancing/latest/application/header-modification.html)
   for the exact attribute keys. Set the balancer's
   `X-Forwarded-For` processing to `remove` (the application never trusts it, and the
   trusted-proxy check uses the connection address), and turn on its
   drop-invalid-header-fields attribute.

   The module configures those response headers, removes `X-Forwarded-For`, drops invalid
   header fields, and suppresses the balancer's own identifying `server` response header. It
   does not rename the certificate headers. To do so, add the listener's header-name
   attribute in `edge.tf` and put `AUTH_CERT_HEADER` in `task_environment`.

   The tightest policy the application runs under with the features named below off, and
   the module's default (`csp`):

   ```
   default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline';
   img-src 'self' data: blob:; media-src 'self' blob:; font-src 'self' data:;
   worker-src 'self' blob:; connect-src 'self' blob:; object-src 'none'; base-uri 'none';
   form-action 'self'; frame-ancestors 'none'
   ```

   Each allowance is there for a reason. `'wasm-unsafe-eval'` is the WebAssembly the image
   decoders load; without it those features fail silently. Styles
   need `'unsafe-inline'` because the control-panel library injects its stylesheet as a
   `<style>` element, and a policy without it renders the whole page unstyled (serif text,
   stacked buttons, no 3D view), which is the first thing you will see if the policy is
   wrong. Scripts need no inline allowance: the container entrypoint writes the runtime
   settings to `sitrec-runtime-env.js` beside the page and references it, rather than
   injecting an inline script.

   `'unsafe-eval'` is absent, and this blocks the two parts of the application that compile
   code at runtime. The OpenCV library does not start, so the Motion (Background) tracking
   method (the default), Template Match, Motion Analysis and Camera Motion (Background) do
   not run; the load fails after a 60-second timeout. Scripts in Scripted Camera Moves do not
   compile. To use these features, add `'unsafe-eval'` to `script-src`.
6. Access logs and connection logs to the logs bucket, with the prefixes `alb/access` and
   `alb/connection`. The connection log records every
   handshake with the certificate serial and the failure reason, which is your
   authentication audit at the edge. Both need the logs bucket set up as in section 6.1
   (S3-managed keys and the delivery policy); with a KMS-encrypted bucket the balancer
   silently writes nothing.
7. The two other evidence sources the verification section relies on:

   ```
   # VPC flow logs, all traffic, to the logs bucket (checks 6 and 11)
   aws ec2 create-flow-logs --resource-type VPC --resource-ids <vpc-id> --traffic-type ALL \
       --log-destination-type s3 --log-destination arn:PARTITION:s3:::<logs-bucket>/flow/

   # A trail with S3 data events for the data bucket (checks 9 and 10)
   aws cloudtrail create-trail --name sitrec --s3-bucket-name <logs-bucket> --s3-key-prefix trail
   aws cloudtrail put-event-selectors --trail-name sitrec --event-selectors \
       '[{"ReadWriteType":"All","IncludeManagementEvents":true,"DataResources":[{"Type":"AWS::S3::Object","Values":["arn:PARTITION:s3:::<data-bucket>/"]}]}]'
   aws cloudtrail start-logging --name sitrec
   ```

### 8.2 Trust store bundle format

The balancer is strict: PEM only, each certificate between `-----BEGIN CERTIFICATE-----`
and `-----END CERTIFICATE-----`, comments only on lines starting with `#` and containing no
`-`, and **no blank lines**. Root plus intermediates, in one file. Revocation lists must be
PEM. Chain depth is limited to four. Check the limits page for the bundle and list sizes
before uploading a large authority's material. A revocation file holds exactly one CRL:
the balancer rejects a concatenated bundle with "More than one CRL objects in the
revocation file". An authority with a root and an intermediate therefore needs two
revocation entries, one file each. The module splits a concatenated `crl_path` bundle into
one object and one entry per CRL, so the same bundle a proxy would use is accepted.

### 8.3 Trust store and user map inside the container

The task needs two files at the paths named by `AUTH_TRUST_STORE` and `AUTH_USER_MAP`. Until
the entrypoint can fetch them at start, bake them into a derived image:

```
FROM <account>.dkr.ecr.<region>.<dns suffix>/sitrec@sha256:<digest>
COPY trust/ca-bundle.pem /etc/sitrec/trust/ca-bundle.pem
COPY trust/users.json    /etc/sitrec/trust/users.json
COPY sitrec-uploads.ini  /usr/local/etc/php/conf.d/sitrec-uploads.ini
```

`sitrec-uploads.ini` raises the PHP upload limits (section 6.3) to suit the default
`MAX_FILE_SIZE_MB` of 100:

```
upload_max_filesize = 100M
post_max_size = 110M
```

If you raise `MAX_FILE_SIZE_MB`, raise both values, and also `memory_limit` (128 MB by
default), because `rehost.php` reads the whole file into memory.

Push the derived image as a new tag. Changing a user is a rebuild of this thin layer; the
base image is unchanged.

Build this image for `X86_64` too, with `--platform linux/amd64` as in section 4. A task
started from an ARM image stops at once with an "exec format error". Check with
`docker image inspect <image> --format '{{.Architecture}}'` before pushing.

Reference the image in the task definition by the registry's standard hostname,
`<account>.dkr.ecr.<region>.<dns suffix>`, not its FIPS hostname. The registry interface
endpoint (section 8.1) resolves only the standard name inside the network, the FIPS name is
a separate endpoint service that not every partition offers, and a task with no route out
cannot pull from a name the endpoint does not serve. The failure looks like a pull timeout
followed by the service's deployment circuit breaker rolling back. Pushing from outside can
use either hostname; the digest is the same.

### 8.4 Task definition

Roles:

- **Execution role**: the AWS-managed ECS task execution policy (pull from ECR, write logs)
  plus `kms:Decrypt` on the ECR key.
- **Task role**: what the application needs. The module's role also has the object and list
  permissions on its `mirror` bucket, ready for the planned mirror endpoint.

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {"Effect": "Allow", "Action": ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"],
     "Resource": "arn:PARTITION:s3:::<data-bucket>/*"},
    {"Effect": "Allow", "Action": ["s3:ListBucket"],
     "Resource": "arn:PARTITION:s3:::<data-bucket>"},
    {"Effect": "Allow", "Action": ["kms:GenerateDataKey", "kms:Decrypt"],
     "Resource": "arn:PARTITION:kms:<region>:<account>:key/<key-id>"},
    {"Effect": "Allow", "Action": ["ssmmessages:CreateControlChannel", "ssmmessages:CreateDataChannel",
                                   "ssmmessages:OpenControlChannel", "ssmmessages:OpenDataChannel"],
     "Resource": "*"}
  ]
}
```

The last statement, together with the `ssmmessages` endpoint and the `--enable-execute-command`
flag below, is what lets an operator open a shell inside the running task for checks 7 and 11.
Remove all three once the deployment is verified if your policy forbids interactive access.
With the module, set `enable_exec = true` for the checks and `false` afterwards. The endpoint
stays, because the module always creates it.

Container definition (the environment is the whole site configuration; only variables
that are set exist in the container):

```json
{
  "family": "sitrec",
  "networkMode": "awsvpc",
  "requiresCompatibilities": ["FARGATE"],
  "cpu": "512",
  "memory": "1024",
  "executionRoleArn": "arn:PARTITION:iam::<account>:role/sitrec-execution",
  "taskRoleArn": "arn:PARTITION:iam::<account>:role/sitrec-task",
  "containerDefinitions": [{
    "name": "sitrec",
    "image": "<account>.dkr.ecr.<region>.<dns suffix>/sitrec@sha256:<digest>",
    "portMappings": [{"containerPort": 8080, "protocol": "tcp"}],
    "user": "1000",
    "readonlyRootFilesystem": false,
    "linuxParameters": {"initProcessEnabled": true},
    "logConfiguration": {"logDriver": "awslogs", "options": {
      "awslogs-group": "/sitrec/app", "awslogs-region": "<region>", "awslogs-stream-prefix": "sitrec"}},
    "environment": [
      {"name": "AUTH_MODE", "value": "cert"},
      {"name": "AUTH_CERT_SOURCE", "value": "header"},
      {"name": "AUTH_TRUSTED_PROXIES", "value": "<balancer-subnet-cidr-1>,<balancer-subnet-cidr-2>"},
      {"name": "AUTH_TRUST_STORE", "value": "/etc/sitrec/trust/ca-bundle.pem"},
      {"name": "AUTH_USER_MAP", "value": "/etc/sitrec/trust/users.json"},
      {"name": "AUTH_POLICY_OIDS", "value": "<your policy identifiers, or omit>"},
      {"name": "AUTH_ID_SOURCE", "value": "san_principal,cn_suffix"},
      {"name": "AUTH_ID_PATTERN", "value": "^[A-Za-z0-9._-]{3,64}$"},

      {"name": "SAVE_TO_S3", "value": "true"},
      {"name": "S3_BUCKET", "value": "<data-bucket>"},
      {"name": "S3_REGION", "value": "<region>"},
      {"name": "S3_CREDENTIAL_SOURCE", "value": "role"},
      {"name": "S3_USE_FIPS", "value": "true"},
      {"name": "S3_DEFAULT_VISIBILITY", "value": "private"},
      {"name": "S3_READS_VIA_SERVER", "value": "true"},
      {"name": "USE_S3_PRESIGNED_URLS", "value": "false"},
      {"name": "SETTINGS_SERVER_ENABLED", "value": "true"},

      {"name": "CHATBOT_ENABLED", "value": "false"},
      {"name": "SITREC_TRACK_STATS", "value": "false"},
      {"name": "LOG_UI_INTERACTIONS", "value": "false"},
      {"name": "SITREC_ENABLE_DEFAULT_MAP_SOURCES", "value": "false"},
      {"name": "SITREC_ENABLE_DEFAULT_ELEVATION_SOURCES", "value": "false"},
      {"name": "SITREC_ENABLE_DEFAULT_TLE_SOURCES", "value": "false"},
      {"name": "LOCAL_DOCS", "value": "true"},

      {"name": "SITREC_CUSTOM_MAP_INTERNAL_URL", "value": "https://<tiles>/imagery/{z}/{x}/{y}.jpg"},
      {"name": "SITREC_CUSTOM_MAP_INTERNAL_NAME", "value": "Imagery"},
      {"name": "SITREC_CUSTOM_ELEVATION_INTERNAL_URL", "value": "https://<tiles>/terrain/{z}/{x}/{y}.png"},
      {"name": "SITREC_CUSTOM_ELEVATION_INTERNAL_NAME", "value": "Elevation"},
      {"name": "DEFAULT_MAP_TYPE", "value": "CustomMap_INTERNAL"},
      {"name": "DEFAULT_ELEVATION_TYPE", "value": "CustomElevation_INTERNAL"}
    ]
  }]
}
```

Notes on that block:

- `user: 1000` runs Apache as an unprivileged user on port 8080; the image supports it.
- `readonlyRootFilesystem` stays `false` for now: the entrypoint rewrites `shared.env.php`,
  `sitrec-runtime-env.js` and `index.html` in the web root at start, and the element-set
  cache writes under `sitrec-cache/`. Making the root read-only with a tmpfs overlay is
  planned.
- The `CHATBOT_ENABLED`, `SITREC_TRACK_STATS`, `LOG_UI_INTERACTIONS`, `USE_S3_PRESIGNED_URLS`
  and three `SITREC_ENABLE_DEFAULT_*` lines are already forced off
  inside the secure build and cannot be turned back on at runtime; they are repeated here
  so the server-side settings agree and so the block is complete if someone runs the
  standard image by mistake. Do not run the standard image in production: its settings can
  be re-enabled at runtime.
- Custom map and elevation sources follow the [custom sources guide](CustomTerrainSources.md);
  the `_URL`, `_NAME`, `_MAX_ZOOM` and related suffixes are all forwarded to the browser.
  The source key is `CustomMap_<NAME>` or `CustomElevation_<NAME>`, which is why the two
  default values above include those prefixes. Point the URLs at services reachable from
  user workstations. Section 9 covers routing, CORS and content security policy.
- No `S3_ACCESS_KEY_ID`, no `XENFORO_PATH`, no `SITREC_DEFAULT_USERID`, no provider keys.
- No `ALLOW_OVERRIDE`, so a user cannot override any setting and Settings has no
  **SITREC_ ENV Override…** entry. To let users try their own sounding-file layouts, add
  `{"name": "ALLOW_OVERRIDE", "value": "SITREC_CUSTOM_SOUNDING_*"}`. See
  [the Secure Build](Secure-Build.md#the-users-sitrec_-env-override).

Register and run:

```
aws ecs create-cluster --cluster-name sitrec
aws logs create-log-group --log-group-name /sitrec/app
aws logs put-retention-policy --log-group-name /sitrec/app --retention-in-days 90
aws ecs register-task-definition --cli-input-json file://sitrec-task.json
aws ecs create-service --cluster sitrec --service-name sitrec --launch-type FARGATE \
    --task-definition sitrec --desired-count 1 --enable-execute-command \
    --network-configuration "awsvpcConfiguration={subnets=[<task-subnet-1>,<task-subnet-2>],securityGroups=[<task-sg>],assignPublicIp=DISABLED}" \
    --load-balancers "targetGroupArn=<target-group-arn>,containerName=sitrec,containerPort=8080"
```

## 9. Data sources inside the network

The secure build itself contacts no external data source once you set `CURRENT_STARLINK`
and `CURRENT_ACTIVE` (table below): until then, `proxy.php` uses a public host for them. The
standalone tools under `tools/` can contact public hosts, see
[Not yet done](Secure-Build.md#not-yet-done). What the app can show depends on what you
stage:

| Data | Setting | What to stage |
|---|---|---|
| Elevation | `SITREC_CUSTOM_ELEVATION_<NAME>_*`, or `DEFAULT_ELEVATION_TYPE=Local` with the pyramid at `/var/www/html/sitrec-terrain/elevation` in the derived image | a Terrarium-format PNG tile pyramid; `scripts/download_local_tiles.js` builds a whole-world pyramid on a connected machine, to the zoom in `MAX_ELEV` (default 6), in `$SITREC_TERRAIN_DIR/elevation`, and also downloads public imagery to `MAX_IMG`, so check that licence first. `Local` reads no tile deeper than zoom 6. For more detail, use a custom source and set its `_MAX_ZOOM` |
| Imagery | `SITREC_CUSTOM_MAP_<NAME>_*` | your own imagery service with a tile URL template, such as a WMTS layer (set `_MAPPING=4326` for an equirectangular tile set); check the licence of any public imagery before copying it |
| Current satellite element sets | `CURRENT_STARLINK` and `CURRENT_ACTIVE`, fetched by the fixed-key `proxy.php` endpoint | scheduled OMM CSV catalogues on an internal web path. Set both settings. Each URL path must end in `.csv`, with no query string |
| Wind | `SITREC_USE_CUSTOM_WIND=true` and `CUSTOM_WIND_URL`, a template with `{YYYY}`, `{MM}`, `{DD}`, `{HH}` and `{LEVEL}`, fetched by `customWindProxy.php`. `SITREC_CUSTOM_WIND_MENU_NAME` sets the label | earth.nullschool-format JSON grids for the dates, cycles and levels of interest |

`SITREC_TERRAIN_URL` has no effect here: it applies only to the serverless build.

Map and elevation tiles are requested directly by each user's browser. Their services must
therefore be reachable from user workstations and must permit the site's origin with CORS.
The default content security policy permits only the site's own origin; either publish the
tiles below that origin or add the exact approved tile origins to `connect-src`. `img-src`
needs no tile origin: the browser fetches each tile, and the default policy already allows
the `blob:` URL that shows a map tile. These browser requests never traverse the task
security group.

`proxy.php` and `customWindProxy.php` fetch their configured URLs from the application task.
The Terraform module deliberately grants the task egress only to its AWS endpoints and S3,
so a separate route and narrowly scoped security-group egress rule are required before those
services can work. Without them each fetch fails within its connect limit of 5 seconds, with
an HTTP 502 (or, for `proxy.php`, the cached copy when there is one), so a missing route
does not hold a server worker. `CUSTOM_TLE` is not listed here because its historical-data endpoint,
`proxyStarlink.php`, is intentionally absent from the secure build.

If the browser sends an `Authorization` header, these proxies forward it to the configured
host, so a source can sit behind the same sign-on as the site. They do not forward it to
`celestrak.org`, or to any fixed public host that another proxy fetches.

Today each URL must resolve to a service your deployment provides. A built-in endpoint that
serves these data sets from the module's mirror bucket is planned.

Everything else the standard build can fetch (live feeds, aircraft traces, soundings,
geocoding, approximate location, public source videos, the assistant, street-level
imagery, photorealistic 3D tiles, star-field solving) is removed from the secure build or
gated off at compile time.

## 10. Verify

Run these after the service is healthy. Replace `alice.p12` with a client certificate your
authority issued; `curl` presents it with `--cert alice.p12:<password> --cert-type P12`.

| # | Check | Command | Pass when |
|---|---|---|---|
| 1 | No certificate, no service | `curl -sS https://<host>/` | the TLS handshake fails (curl exit 35 or 56, HTTP code 000); nothing is served; the connection log shows `Failed:UnmappedConnectionError` |
| 2 | Valid certificate, identity mapped | `curl -sS --cert alice.p12:PW --cert-type P12 "https://<host>/sitrecServer/rehost.php?getuser=1"` | JSON with the mapped `userID` and groups, never 0, never the administrator group unless mapped |
| 3 | Revoked certificate | same, with a revoked certificate | handshake refused (curl reports "connection reset by peer"); the connection log shows `Failed:ClientCertCrlHit` with the certificate's serial |
| 4 | Wrong certificate type | same, with a signature-only certificate | either the handshake is refused (the balancer and nginx both check the client-authentication purpose; the connection log shows `Failed:ClientCertPurposeInvalid`) or `userID` 0 with container log reason `eku_missing`; never a login |
| 5 | Header forgery | valid certificate plus `-H 'X-Amzn-Mtls-Clientcert-Leaf: <another valid user's PEM, URL-encoded>'` | **never** the header's identity. Two outcomes pass: the handshake's identity (the balancer replaced the client's header), or `userID` 0 with reason `multiple_certificates` in the container log (the balancer appended its header to the client's, and the application refused to choose). The second outcome is safe but means a client can lock itself out by sending the header; rename the header at the balancer (section 8.1) to close that too |
| 6 | Inside the network, not the balancer | from a shell in the VPC: `curl -m 5 -H 'X-Amzn-Mtls-Clientcert-Leaf: …' http://<task-ip>:8080/sitrecServer/rehost.php?getuser=1` | the connection times out, because the security group drops it (the flow logs show REJECT); from the task's own shell it is reachable, and the result is `userID` 0 with reason `untrusted_proxy` |
| 7 | Loopback is not administrator | `aws ecs execute-command --cluster sitrec --task <task-id> --container sitrec --interactive --command "curl -s localhost:8080/sitrecServer/rehost.php?getuser=1"` (needs the exec enablement from section 8.4) | `userID` 0 |
| 8 | Configuration endpoint | `curl … "https://<host>/sitrecServer/config_paths.php?FETCH_CONFIG"` | `APP` begins `https://<host>/` |
| 9 | Save and read back | in the browser, save a sitch with a video; then `aws s3api head-object` on the key, as the role in `admin_role_arn` (`<admin-role>` in section 6.2). Any other identity outside the VPC endpoint gets 403, so name that role before you run this check | object present with `ServerSideEncryption: aws:kms`; anonymous `curl` of the object's URL returns 403; playback in the app works (through `s3-proxy.php`) |
| 10 | FIPS endpoints in use | the trail's S3 data events for the data bucket (section 8.1, item 7), delivered to the logs bucket within about fifteen minutes | in every event whose identity is the task role, `requestParameters.Host` ends in `s3-fips.<region>.<dns suffix>`, `tlsDetails.tlsVersion` is TLS 1.3, and `vpcEndpointId` is the gateway endpoint's id (so the FIPS hostname is reached through the endpoint, not the internet) |
| 11 | No route out | `aws ecs execute-command … --command "curl -m 5 https://example.com"` | fails; the VPC flow logs (section 8.1, item 7) show only endpoint traffic and any narrowly allowed internal-source traffic |
| 12 | Browser origins | browser developer tools, network panel, load a sitch, open terrain, save | every request is to `<host>`, or to an exact custom-source origin you intentionally added to routing, CORS and the content security policy |
| 13 | Response headers | `curl -sI --cert … https://<host>/` | `strict-transport-security`, `x-frame-options`, `content-security-policy` present; no `server: awselb/2.0` header. The image's Apache sends its own `Server` line, which may appear here |
| 14 | Image provenance | `aws ecs describe-tasks` → image digest | equals the digest of the derived image you pushed in section 8.3 |
| 15 | Logs | one accepted login, one refusal | both `authentication` records present in the CloudWatch stream; the connection log has the serial |

## 11. Operate

- **Update the application**: make a new secure build and image, push it, rebuild the
  derived image on it (section 8.3), push that, register a new task definition revision with
  the derived image's digest, and update the service. With the module, set `image` to that
  digest and apply. Roll back by pointing the service at the previous revision.
- **Add or remove a user**: edit `users.json`, rebuild the thin derived image, new revision.
- **Rotate a revocation list**: upload the new file to the trust bucket and call
  `add-trust-store-revocations`; no application change. With the module, edit the local file
  and run `terraform apply` instead.
- **Change the CA bundle**: upload the new file to the trust bucket and call
  `modify-trust-store`, or with the module edit the local file and run `terraform apply`.
  Then put the same bundle in `trust/ca-bundle.pem`, rebuild the derived image (section 8.3)
  and deploy a new revision. The application checks each certificate against its own copy,
  so a new authority added only at the balancer is refused with `chain_untrusted`.
- **Rotate the server certificate**: ACM renews managed certificates; for imported ones,
  import the new certificate and update the listener.
- **Logs**: application and audit lines in the CloudWatch group; edge authentication in the
  balancer's connection log; storage access in CloudTrail data events. Set retention on all
  three.
- **Backup**: bucket versioning is the undo; add a lifecycle rule and, if required, a
  replication rule to a second bucket in the same partition.
- **Persistent data**: the bucket only. The task's local `sitrec-upload/` and
  `sitrec-cache/` are scratch and are lost on every deployment, by design.

## 12. Rehearsing in a commercial region first

You can prove the whole shape in an ordinary AWS region before you have access to the
target partition, as long as you impose the same constraints on yourself. The module makes
that a variables file: `rehearsal.tfvars.example` names a commercial region with FIPS on
and the exec shell enabled, `target.tfvars.example` names the target with placeholders, and
the other differences are `allow_destroy`, log retention and the custom data sources. The
partition lint keeps the two from drifting apart: on every push it
scans the module and the server code for ARN, endpoint and region literals and for the
resource types an isolated deployment never uses, and before an apply it checks the plan's
every service against a snapshot of what the target region offers, fetched from AWS's
public infrastructure parameters with `deploy/aws/lint/refresh-services.mjs` (this needs a
credential with `ssm:GetParametersByPath` in a commercial region; snapshots are never
committed). The plan's values are checked against the plan's own partition and region,
read from its `aws_partition` and `aws_region` data sources, so a plan made in the
rehearsal account is a valid input: a hard-coded partition or region shows up as a value
that does not match the account the plan was made in. The constraints, then:

- Set `AWS_USE_FIPS_ENDPOINT=true` and `S3_USE_FIPS=true`; commercial US regions have FIPS
  endpoints too.
- Build the network with no internet gateway route for the tasks and no NAT gateway; use
  endpoints only.
- Attach a permissions boundary or organisation policy to the deploying role that denies
  every service the target partition lacks (a content-delivery network, managed app hosting
  and the like), so the rehearsal cannot drift into using one. `deploy/aws/rehearsal-scp.json`
  is a starting policy.
- Write every ARN with the partition taken from `aws sts get-caller-identity`, never
  literally.
- Mint your own certificate authority for the trust store (root, intermediate, users, a
  revocation list with one revoked user, a signature-only certificate for check 4). The
  repository's `tests/authCertMode.test.js` shows the `openssl` commands for the root,
  intermediate, user and signature-only certificates. It has no revocation list: make one
  with `openssl ca -revoke` and then `openssl ca -gencrl`. The same certificates loaded onto
  a hardware security token (any token
  that implements the standard smart-card authentication slot) rehearse the real user
  experience: PIN prompt, certificate picker, token removal. Three things cost time the
  first time: macOS ignores a smart card that has no card-holder identifier and container
  objects, so a fresh token must have both written before any browser offers its
  certificates; Safari stores a per-site certificate preference after a visit where only
  one identity matched and then stops asking; Chrome keeps its picker choice for the whole
  browser session.
- Run the checks in section 10; they are the same in both places.

The certificate path can even be rehearsed on a development machine with no cloud at all.
nginx does what the balancer does with three lines in the server block, plus one in the PHP
location that hands the verified leaf to the application in the balancer's header shape:

```
ssl_client_certificate /path/to/chain.crt;
ssl_crl                /path/to/crl.pem;
ssl_verify_client      optional;
# in the PHP location:
fastcgi_param HTTP_X_AMZN_MTLS_CLIENTCERT_LEAF $ssl_client_escaped_cert;
```

With `AUTH_MODE=cert`, `AUTH_TRUSTED_PROXIES` set to the addresses nginx sees the browser
from, and the same trust store and user map, the browser's certificate picker, the refusals
for a signature-only or revoked certificate, and the header-forgery check all behave as they
will behind the balancer. Without that `fastcgi_param` line a client on a trusted address can
supply the header itself, which is the reason the line, and the trusted-proxy rule, exist.

What a rehearsal cannot tell you: your real authority's certificate profile and revocation
list sizes against the balancer's limits, whether your users' workstations route to the S3
endpoint, and the target partition's service availability on the day. Verify those on the
first day of access.

## 13. Maintaining this guide

This guide names files and settings. When any of these change, change the guide in the
same commit:

| If you change | Update |
|---|---|
| `scripts/secureClientEnv.js` forced values, or `src/secureFlags.js` | section 3, the task-definition notes in 8.4, and Secure-Build.md |
| `scripts/secureStubs.js` (a module added to or removed from the stub list) | section 9's last paragraph, and Secure-Build.md |
| `sitrecServer/auth_cert.php` settings, checks or reason tokens | sections 7.1, 7.2, 7.4, and the install guide's certificate section |
| `sitrecServer/audit.php` record fields or events | sections 7.4 and 7.5, check 15, and AuditLogging.md |
| `sitrecServer/s3_client.php` settings | section 6.3 |
| `docker/entrypoint.sh` `CLIENT_VARS` / `SERVER_VARS` | any table that lists a setting the entrypoint must forward |
| `Dockerfile.release` build arguments or base image | section 4 |
| `deploy/aws/*.tf` resources, variables or the task environment defaults | sections 6, 7.2, 8 and the status table |
| `deploy/aws/lint/partition-lint.mjs` checks or its resource map | section 12 and `deploy/aws/lint/README.md` |
| a planned row in the status table becoming real | the status table and the section it points to |

An agent asked to "update the hardened AWS guide" should diff the files in the left column
against the sections in the right column, and should run `npx jest tests/docsRegistry.test.js`
afterwards, because this file is listed there as an intentionally unregistered developer
document.
