# Installing Hardened Sitrec on AWS

A hardened Sitrec deployment is a full-server install that runs inside a network with no
route to the internet, authenticates every user with a client certificate, keeps user files
in a private object-storage bucket, and reaches no external data source unless the operator
stages a mirror of it inside the same network. This guide describes how to build, deploy,
configure and verify that shape on AWS. It is written for a person doing the deployment and
for an automated agent maintaining it, so every setting is named, every command is given,
and the status table below says exactly which parts exist in this release.

It complements, and does not replace, the general [install guide](Installing-and-configuring.md),
the [secure build](Secure-Build.md) reference, and the [VPS guide](Deploying-on-a-VPS.md),
which describes the same container on a single host with a public reverse proxy.

Everything here uses only generic AWS features. The region, the partition (which decides
the ARN prefix and whether FIPS endpoints are expected) and the certificate authority are
values you supply; nothing in the code assumes a particular one.

## Status of this guide

| Part | State | Where |
|---|---|---|
| Secure client bundle (`npm run build-secure`, outbound features removed at compile time, forced-off settings, runtime overrides can only tighten) | **Available** | `webpack.secure.js`, `scripts/secureClientEnv.js`, `src/secureStubs/`, [Secure-Build.md](Secure-Build.md) |
| Packaging the secure bundle into the standard image | **Available** | `Dockerfile.release` with `--build-arg DIST_DIR=dist-secure` |
| Client certificate authentication (`AUTH_MODE=cert`) behind a load balancer or Apache | **Available** | `sitrecServer/auth_cert.php`, `config/config.php.example`, section 7 |
| Object storage with role credentials, FIPS endpoints, or a custom endpoint | **Available** | `sitrecServer/s3_client.php`, section 6 |
| Same-origin object reads with a private bucket (`s3-proxy.php` signed stream) | **Available** | `sitrecServer/s3-proxy.php` |
| Reverse-proxy scheme handling (`X-Forwarded-Proto`) | **Available** | `sitrecServer/requestScheme.php` |
| Egress tripwire on the built artifact | **Available** | `scripts/auditBundleEgress.js`, runs in `postbuild-secure` |
| Infrastructure as code (one Terraform module, partition-neutral: network, endpoints, registry, buckets, balancer with mutual TLS, service, roles, logs, trail) | **Available** | `deploy/aws/`, section 8 |
| Partition lint (static checks in CI on every push; plan checks against a services snapshot for the target region) | **Available** | `deploy/aws/lint/`, section 12 |
| Trust store and user map fetched at container start | Planned; use a derived image for now (section 8.3) | `docker/entrypoint.sh` |
| Server endpoint allow-list in the secure artifact (the proxies, assistant relays, diagnostics and telemetry writers are not packaged; the audit checks the packaged tree and the identity seam) | **Available** | `scripts/secure-server-allowlist.json`, `webpackCopyPatterns.js`, `scripts/auditBundleEgress.js` |
| Mirror endpoint for staged map, elevation, element-set and wind data | Planned; use the custom-source settings against your own service for now (section 9) | `sitrecServer/mirror.php` |
| Response security headers set by the application | Planned; set them at the load balancer for now (section 8.1) | |
| Session idle timeout, in-application revocation, structured audit log | Planned; the load balancer does revocation, the audit line goes to the container log | |
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
        +--> your own map, elevation, element-set and wind services (section 9)
```

Why this shape: there is no host to patch, the image already runs as any user on port
8080, configuration is environment, the only state is S3, and the container's standard
output is the log. The balancer does the part an assessor checks first, chain validation
and revocation, in a managed and logged way. The application does what only it can do:
identity extraction, policy check, user mapping.

A single-host variant is the [VPS guide](Deploying-on-a-VPS.md) with nginx instead of Caddy
in front (nginx validates client certificates and checks revocation; Caddy does not without
a module). The container and every setting in this guide are the same.

## 2. Before you start

You need:

- An AWS account in the target partition, with permissions for VPC, ECR, ECS, ELB, ACM, S3,
  KMS, IAM, CloudWatch Logs and CloudTrail. Note the partition name and region:

  ```
  aws sts get-caller-identity
  aws ec2 describe-regions --query 'Regions[].RegionName'
  ```

  The ARN prefix is `arn:aws` in commercial regions and differs in other partitions; every
  policy below writes it as `PARTITION`. Every command below reads the region and account
  from your shell, so set them once:

  ```
  export AWS_REGION=<region>                 # the AWS CLI and SDKs read this
  export ACCOUNT=$(aws sts get-caller-identity --query Account --output text)
  export AWS_USE_FIPS_ENDPOINT=true          # if your partition expects FIPS endpoints
  ```
- A DNS name for the site and a way to get a server certificate for it: ACM public issuance
  with DNS validation where available, otherwise a certificate from your own authority
  imported into ACM.
- Your client-certificate authority's bundle (root and intermediates, PEM) and its
  revocation list(s). See section 8.2 for the format rules the balancer enforces.
- A user map: which certificate identifiers may log in, and as which Sitrec user and groups.
  Section 7.3.
- A machine that can build the image (Node 22, Docker or Podman) and push to ECR, or a
  way to carry a saved image in (section 5.3).
- Optionally, an internal map tile service and elevation service to point the app at.
  Without one the map is blank, by design, and the first tile error says so: it names the
  directory or service it expected, the setting that points at it, and the container mount
  point for pre-downloaded tiles.

## 3. Build the secure bundle

The hardened deployment runs the **secure bundle**, not the standard one. The difference is
compile-time: the modules that call external services are replaced with inert stubs, the
default map, elevation and element-set sources are disabled, every provider key is blank,
and a runtime setting can only make a security flag more restrictive, never less.
[Secure-Build.md](Secure-Build.md) has the full list.

```
npm ci
npm run build-secure          # writes dist-secure/ and runs the notices, secret and egress audits
```

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

The first should list about two dozen files and `vendor/`, and no `chatbot.php`,
`proxyADSBLive.php`, `streetview.php` or `info.php`.

## 4. Build the image

`Dockerfile.release` packages a pre-built output directory. Point it at the secure bundle:

```
docker build -f Dockerfile.release --build-arg DIST_DIR=dist-secure -t sitrec-hardened:local .
```

The image is the same runtime as every other Sitrec container: PHP 8.4 with Apache, the
entrypoint that turns environment variables into `shared.env.php` and the page's runtime
settings, port 8080, any UID. Nothing at container start touches the network.

If your environment mandates a particular base image, `Dockerfile.release` starts `FROM
php:8.4-apache`; substitute your image there. It must provide PHP 8.4 with the `openssl`,
`curl`, `json`, `mbstring`, `simplexml` and `zip` extensions, and Apache with `mod_rewrite`.

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
npm run audit-container -- --image=sitrec-hardened:local --profile=site
```

This writes a report, a bill of materials and the supporting evidence to `dist-audit/`. It
is the document to give whoever must accept the image, and it is worth reading yourself
first: it states what the image runs as, what the base image brings with it, which package
advisories a rebuild would close, and the runtime restrictions the image will tolerate —
which is the raw material for the task definition in section 8.4.

Use `--profile=site` for an image you build with your own configuration compiled in: the
credentials it carries are expected, and the report treats them as a handling requirement —
the image becomes as sensitive as its contents, and belongs only in a registry whose read
access matches. An image built from `config/shared.env.example`, which carries no
credential and takes its settings from the environment at container start, is reviewed with
the default `--profile=published` instead. See
[Container Security Review](Container-Security-Review.md).

### 4.2 Run it as a non-root user

The image declares no `USER`, so by default it runs as root. It does not need to: it
listens on the unprivileged port 8080 and its writable paths are world-writable precisely so
that any assigned UID can use them. **Give it a non-root identity and it works unchanged** —
Apache starts, the entrypoint still rewrites `shared.env.php`, `index.html` and the runtime
settings script, and the files it creates are owned by that user:

```
docker run --user 33:33 -p 8080:8080 <image>@<digest>     # 33 is www-data
```

In a task definition, set `"user": "33:33"` on the container; in Kubernetes, use
`securityContext.runAsUser: 33` with `runAsNonRoot: true`. The review's derived runtime
policy prints the full set of restrictions the image accepts, and `CFG-01` is the finding
this closes. A hardened deployment should do this.

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

```
aws ecr create-repository --repository-name sitrec \
    --image-tag-mutability IMMUTABLE --image-scanning-configuration scanOnPush=true \
    --encryption-configuration encryptionType=KMS
```

### 5.2 Push from a connected machine

```
aws ecr get-login-password | docker login --username AWS --password-stdin $ACCOUNT.dkr.ecr.$AWS_REGION.amazonaws.com
docker tag sitrec-hardened:local $ACCOUNT.dkr.ecr.$AWS_REGION.amazonaws.com/sitrec:<version>
docker push $ACCOUNT.dkr.ecr.$AWS_REGION.amazonaws.com/sitrec:<version>
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
docker tag sitrec-hardened:local $ACCOUNT.dkr.ecr.$AWS_REGION.amazonaws.com/sitrec:<version>
docker push $ACCOUNT.dkr.ecr.$AWS_REGION.amazonaws.com/sitrec:<version>
```

### 5.4 Pull-through cache from the public registry

Where policy allows the registry service to fetch from `ghcr.io` on your behalf, an ECR
pull-through cache rule for `ghcr.io/mickwest/sitrec2` avoids pushing at all. Note that the
published public image is the **standard** bundle, not the secure one; use it only for a
rehearsal, or build your own secure image as above.

## 6. Storage

### 6.1 Buckets

Create the data bucket with public access blocked, versioning on, and a customer-managed
KMS key:

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
lists; its policy must also let the load-balancing service read them.

A third bucket receives the balancer's access and connection logs, the VPC flow logs and
the CloudTrail trail. It is **different** in two ways, because the delivery services write
to it: encrypt it with S3-managed keys (`AES256`), not a customer-managed KMS key, and give
it the bucket policy that the load balancer access-logging page prescribes for your region:
an `s3:PutObject` grant on `<logs-bucket>/alb/AWSLogs/<account>/*` to the regional
load-balancer account, or to the `logdelivery.elasticloadbalancing.amazonaws.com` service
principal in regions that use it; plus the `delivery.logs.amazonaws.com` grant for flow
logs and the `cloudtrail.amazonaws.com` grant for the trail. Keep public access blocked
and versioning on as for the others.

### 6.2 Bucket policy

Deny everything that does not arrive through your VPC endpoint or from the task role:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "OnlyFromTheVpcEndpoint",
      "Effect": "Deny",
      "Principal": "*",
      "Action": "s3:*",
      "Resource": ["arn:PARTITION:s3:::<data-bucket>", "arn:PARTITION:s3:::<data-bucket>/*"],
      "Condition": {
        "StringNotEquals": {"aws:SourceVpce": "<vpce-id>"},
        "ArnNotLike": {"aws:PrincipalArn": "arn:PARTITION:iam::<account>:role/<admin-role>"}
      }
    }
  ]
}
```

### 6.3 How Sitrec uses the bucket

With the settings in section 8.4:

- Saves and uploads go **through the server** (`rehost.php` writes with the task role).
  `USE_S3_PRESIGNED_URLS=false` keeps the browser from being sent directly to the S3
  endpoint, which it usually cannot reach in an isolated network.
- Reads come back **through the same origin**. `S3_READS_VIA_SERVER=true` makes the server
  answer every object reference with a `s3-proxy.php` URL on the application itself, which
  streams the object with the task role's credentials; range requests work, so video seeks
  work. Without it the server would hand the browser a presigned storage URL, which the
  browser cannot reach here.
- Objects are private. `S3_DEFAULT_VISIBILITY=private` and empty ACL settings mean no ACL
  is ever sent, which is what Bucket Owner Enforced requires.
- The client is built once per request by `sitrecServer/s3_client.php` from these settings:

| Setting | Value here | Meaning |
|---|---|---|
| `S3_BUCKET`, `S3_REGION` | your values | as today |
| `S3_CREDENTIAL_SOURCE` | `role` | no keys in the configuration; the SDK's default chain finds the task role |
| `S3_USE_FIPS` | `true` (or leave unset in a region whose name starts with the FIPS-expecting prefix, where it defaults on) | use the region's FIPS endpoint |
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

Because the application re-verifies the leaf itself, a forged header carrying a certificate
the balancer would not have accepted is worthless. Two more layers make forgery
irrelevant in practice: in verify mode no request reaches the target without a valid
handshake, and the target security group admits only the balancer.

### 7.2 Settings

| Setting | Value here | Default | Meaning |
|---|---|---|---|
| `AUTH_MODE` | `cert` | `forum` | `forum` is the existing behaviour; `none` makes every request anonymous |
| `AUTH_CERT_SOURCE` | `header` | `header` | `apache` when Apache itself terminates TLS and exports `SSL_CLIENT_CERT` |
| `AUTH_CERT_HEADER` | `X-Amzn-Mtls-Clientcert-Leaf` | same | rename it if you rename the header at the balancer (section 8.1) |
| `AUTH_TRUSTED_PROXIES` | the balancer's subnet CIDRs, comma-separated | empty (refuse all) | addresses or CIDRs, IPv4 and IPv6 |
| `AUTH_TRUST_STORE` | `/etc/sitrec/trust/ca-bundle.pem` | empty (refuse) | PEM bundle: root and intermediates |
| `AUTH_POLICY_OIDS` | your policy identifiers, comma-separated | empty (no check) | at least one must be present on the leaf |
| `AUTH_ID_SOURCE` | `san_principal,cn_suffix` | same | first source that yields wins: `san_principal` takes the part before `@` of a principal-style name in the Subject Alternative Name; `cn_suffix` takes the Common Name after its last `.`; `cn` takes the whole Common Name |
| `AUTH_ID_PATTERN` | a pattern matching your identifiers exactly | `^[A-Za-z0-9._-]{3,64}$` | the identifier must fully match |
| `AUTH_USER_MAP` | `/etc/sitrec/trust/users.json` | empty (refuse) | section 7.3 |
| `AUTH_REQUIRE_CLIENT_EKU` | `true` | `true` | refuse a signature or encryption certificate presented for login |

### 7.3 The user map

A JSON object keyed by identifier. Groups use Sitrec's numbers: 3 administrator, 2
registered, 9 verified, 14 sitrec.

```json
{
  "1234567890": { "user_id": 42, "groups": [2, 14] },
  "2345678901": { "user_id": 43, "groups": [3, 2, 14, 9] }
}
```

Choose small opaque user ids. The user id becomes the first path segment of every object
the user saves, so never use the certificate identifier itself as the user id.

### 7.4 What the log shows

One JSON line per identity resolution, in the container log (CloudWatch):

```
{"auth":"cert","outcome":"accepted","reason":"ok","user_id":42,"identifier_sha256":"3f2a…","remote_addr":"10.0.1.23"}
{"auth":"cert","outcome":"refused","reason":"identifier_unmapped","user_id":0,"identifier_sha256":"9b1c…","remote_addr":"10.0.1.23"}
```

Reason tokens: `untrusted_proxy`, `no_certificate`, `multiple_certificates` (a header holding
more than one certificate block is refused rather than picking one), `not_verified_by_server`,
`certificate_unparseable`, `no_trust_store`, `chain_untrusted`, `not_yet_valid`, `expired`,
`eku_missing`, `policy_missing`, `identifier_missing`, `identifier_invalid`, `pattern_invalid`,
`no_user_map`, `user_map_invalid`, `identifier_unmapped`, `mapping_invalid`, and `ok`.
The identifier never appears in the log; the hash prefix lets you correlate.

### 7.5 What the application does not do yet

Revocation is the balancer's job (revocation lists in the trust store). Session idle
timeout and a structured audit trail beyond the line above are planned. Logout on a
certificate-authenticated site is limited by the browser's TLS session cache; tell users
that a full logout means closing the browser.

## 8. The load balancer, the network and the service

The Terraform module in `deploy/aws/` builds everything in this section from one variables
file; its README has the variables and the two-stage first apply (create the registry,
push the derived image, apply the rest). The steps below are the same resources described
one by one, for reading the module, for a console build, and for checking what the module
made. Names in angle brackets are yours.

```
cd deploy/aws
cp target.tfvars.example target.tfvars      # fill in; this file is ignored by git
terraform init
terraform plan -var-file=target.tfvars -out plan.tfplan
terraform show -json plan.tfplan > plan.json
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
   path `/`, which returns the page to anyone; never use `sitrecServer/info.php`, it is
   admin-only and returns 403), HTTPS listener with the ACM certificate and mutual TLS in
   verify mode:

   ```
   aws elbv2 modify-listener --listener-arn <listener-arn> \
       --mutual-authentication "Mode=verify,TrustStoreArn=<trust-store-arn>,AdvertiseTrustStoreCaNames=on"
   ```

   Advertising the CA names makes the browser's certificate picker show only certificates
   from your authority, which removes the commonest user error.
5. Listener attributes: rename the certificate headers to a private name if you want an
   extra margin against header injection (then set `AUTH_CERT_HEADER` to match), and
   insert the response headers the application does not yet set itself:
   `Strict-Transport-Security`, `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`,
   and a `Content-Security-Policy`. Check the "HTTP header modification" page of the
   Elastic Load Balancing guide for the exact attribute keys. Set the balancer's
   `X-Forwarded-For` processing to `remove` (the application never trusts it, and the
   trusted-proxy check uses the connection address).

   The tightest policy the application runs under, and the module's default (`csp`):

   ```
   default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline';
   img-src 'self' data: blob:; media-src 'self' blob:; font-src 'self' data:;
   worker-src 'self' blob:; connect-src 'self' blob:; object-src 'none'; base-uri 'self';
   form-action 'self'; frame-ancestors 'none'
   ```

   Each allowance is there for a reason. `'wasm-unsafe-eval'` is the WebAssembly the image
   decoders and the tracking code load; without it those features fail silently. Styles
   need `'unsafe-inline'` because the control-panel library injects its stylesheet as a
   `<style>` element, and a policy without it renders the whole page unstyled (serif text,
   stacked buttons, no 3D view), which is the first thing you will see if the policy is
   wrong. Scripts need no inline allowance: the container entrypoint writes the runtime
   settings to `sitrec-runtime-env.js` beside the page and references it, rather than
   injecting an inline script. `'unsafe-eval'` is deliberately absent: the application
   compiles no code at runtime, so nothing needs it.
6. Access logs and connection logs to the logs bucket. The connection log records every
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
FROM <account>.dkr.ecr.<region>.amazonaws.com/sitrec@sha256:<digest>
COPY trust/ca-bundle.pem /etc/sitrec/trust/ca-bundle.pem
COPY trust/users.json    /etc/sitrec/trust/users.json
```

Push it as a new tag. Changing a user is a rebuild of this thin layer; the base image is
unchanged.

Build for the architecture the task definition declares (`X86_64` in the module). A
machine with an ARM processor, such as an Apple-silicon Mac, builds an ARM image by
default, and a task started from one stops at once with an "exec format error". Pass
`--platform linux/amd64` to both the base build and the derived build, and check with
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
- **Task role**: exactly what the application needs.

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

Container definition (the environment is the whole site configuration; only variables
that are set exist in the container):

```json
{
  "family": "sitrec",
  "networkMode": "awsvpc",
  "requiresCompatibilities": ["FARGATE"],
  "cpu": "512",
  "memory": "1024",
  "executionRoleArn": "arn:PARTITION:iam::<account>:role/sitrec-exec",
  "taskRoleArn": "arn:PARTITION:iam::<account>:role/sitrec-task",
  "containerDefinitions": [{
    "name": "sitrec",
    "image": "<account>.dkr.ecr.<region>.amazonaws.com/sitrec@sha256:<digest>",
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
      {"name": "DEFAULT_MAP_TYPE", "value": "INTERNAL"},
      {"name": "DEFAULT_ELEVATION_TYPE", "value": "INTERNAL"}
    ]
  }]
}
```

Notes on that block:

- `user: 1000` runs Apache as an unprivileged user on port 8080; the image supports it.
- `readonlyRootFilesystem` stays `false` for now: the entrypoint rewrites `shared.env.php`
  and `index.html` in the web root at start, and the element-set cache writes under
  `sitrec-cache/`. Making the root read-only with a tmpfs overlay is planned.
- The `CHATBOT_ENABLED` and the three `SITREC_ENABLE_DEFAULT_*` lines are already forced off
  inside the secure bundle and cannot be turned back on at runtime; they are repeated here
  so the server-side settings agree and so the block is complete if someone runs the
  standard image by mistake. Do not run the standard image in production: its settings can
  be re-enabled at runtime.
- Custom map and elevation sources follow the [custom sources guide](CustomTerrainSources.md);
  the `_URL`, `_NAME`, `_MAX_ZOOM` and related suffixes are all forwarded to the browser.
  Point them at a service inside your network. Section 9 covers staging data.
- No `S3_ACCESS_KEY_ID`, no `XENFORO_PATH`, no `SITREC_DEFAULT_USERID`, no provider keys.

Register and run:

```
aws ecs register-task-definition --cli-input-json file://sitrec-task.json
aws ecs create-service --cluster sitrec --service-name sitrec --launch-type FARGATE \
    --task-definition sitrec --desired-count 1 --enable-execute-command \
    --network-configuration "awsvpcConfiguration={subnets=[<task-subnet-1>,<task-subnet-2>],securityGroups=[<task-sg>],assignPublicIp=DISABLED}" \
    --load-balancers "targetGroupArn=<target-group-arn>,containerName=sitrec,containerPort=8080"
```

## 9. Data sources inside the network

The secure bundle contacts no external data source. What the app can show depends on what
you stage:

| Data | Setting | What to stage |
|---|---|---|
| Elevation | `SITREC_CUSTOM_ELEVATION_<NAME>_*` or `SITREC_TERRAIN_URL` | a Terrarium-format PNG tile pyramid; `scripts/download_local_tiles.js` builds one for an area on a connected machine |
| Imagery | `SITREC_CUSTOM_MAP_<NAME>_*`, or a WMS/WMTS source in `config.js` | your own imagery service; check the licence of any public imagery before copying it |
| Satellite element sets | `CUSTOM_TLE` with `CACHE_CUSTOM_TLE`; `CURRENT_STARLINK` and `CURRENT_ACTIVE` for the fixed-key proxy | a scheduled copy of the public catalogues onto an internal web path |
| Wind | `CUSTOM_WIND_URL` via `customWindProxy.php` | GRIB2 grids for the dates of interest |

Each of these settings takes a URL template; today the URL must be a service your network
serves. A built-in endpoint that serves these from a second bucket is planned.

Everything else the standard build can fetch (live feeds, aircraft traces, soundings,
geocoding, approximate location, public source videos, the assistant, street-level
imagery, photorealistic 3D tiles, star-field solving) is absent from the secure bundle.

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
| 6 | Inside the network, not the balancer | from a shell in the VPC: `curl -H 'X-Amzn-Mtls-Clientcert-Leaf: …' http://<task-ip>:8080/sitrecServer/rehost.php?getuser=1` | connection refused by the security group; if reachable, `userID` 0 with reason `untrusted_proxy` |
| 7 | Loopback is not administrator | `aws ecs execute-command --cluster sitrec --task <task-id> --container sitrec --interactive --command "curl -s localhost:8080/sitrecServer/rehost.php?getuser=1"` (needs the exec enablement from section 8.4) | `userID` 0 |
| 8 | Configuration endpoint | `curl … "https://<host>/sitrecServer/config_paths.php?FETCH_CONFIG"` | `APP` begins `https://<host>/` |
| 9 | Save and read back | in the browser, save a sitch with a video; then `aws s3api head-object` on the key | object present with `ServerSideEncryption: aws:kms`; anonymous `curl` of the object's URL returns 403; playback in the app works (through `s3-proxy.php`) |
| 10 | FIPS endpoints in use | the trail's S3 data events for the data bucket (section 8.1, item 7), delivered to the logs bucket within about fifteen minutes | in every event whose identity is the task role, `requestParameters.Host` ends in `s3-fips.<region>.<dns suffix>`, `tlsDetails.tlsVersion` is TLS 1.3, and `vpcEndpointId` is the gateway endpoint's id (so the FIPS hostname is reached through the endpoint, not the internet) |
| 11 | No route out | `aws ecs execute-command … --command "curl -m 5 https://example.com"` | fails; the VPC flow logs (section 8.1, item 7) show only endpoint traffic |
| 12 | No foreign origin from the page | browser developer tools, network panel, load a sitch, open terrain, save | every request is to `<host>` |
| 13 | Response headers | `curl -sI --cert … https://<host>/` | `strict-transport-security`, `x-frame-options`, `content-security-policy` present; no `server: awselb` |
| 14 | Image provenance | `aws ecs describe-tasks` → image digest | equals the digest you recorded in section 4 |
| 15 | Logs | one accepted login, one refusal | both JSON lines present in the CloudWatch stream; the connection log has the serial |

## 11. Operate

- **Update the application**: build a new secure bundle and image, push, register a new task
  definition revision with the new digest, update the service. Roll back by pointing the
  service at the previous revision.
- **Add or remove a user**: edit `users.json`, rebuild the thin derived image, new revision.
- **Rotate the CA bundle or revocation list**: upload the new file to the trust bucket and
  call `modify-trust-store` or `add-trust-store-revocations`; no application change.
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
nothing else differs. The partition lint keeps the two from drifting apart: on every push it
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
  and the like), so the rehearsal cannot drift into using one.
- Write every ARN with the partition taken from `aws sts get-caller-identity`, never
  literally.
- Mint your own certificate authority for the trust store (root, intermediate, users, a
  revocation list with one revoked user, a signature-only certificate for check 4). The
  repository's `tests/authCertMode.test.js` shows the `openssl` commands that produce a
  working set, and the same certificates loaded onto a hardware security token (any token
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
| `sitrecServer/auth_cert.php` settings, checks or reason tokens | sections 7.1, 7.2, 7.4 |
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
