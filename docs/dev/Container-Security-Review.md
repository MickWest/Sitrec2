# Container Security Review

An automated review of a built Sitrec container image, producing a report an operator can
hand to whoever must accept the image into their environment.

```bash
npm run audit-container -- --image=ghcr.io/mickwest/sitrec2:latest
```

It writes `dist-audit/container-security-review.md` (the report), a matching `.json`, a
CycloneDX `sbom.cdx.json`, and the raw evidence under `dist-audit/evidence/`.

## Why this exists, when the bundle is already audited

Sitrec already audits its **bundle**. `auditBundleSecrets.js` proves no credential is in
the output; `auditBundleEgress.js` proves no unlisted host literal is. Both fail the build,
and both are correct.

Both also judge *a directory that a web server will serve*. That is the right question for
a bundle, and it is why the secrets audit permits `shared.env.php`: the file begins `<?php`
and PHP never hands it out, so its contents are not published by serving the directory.

A container image is a different object under a different threat model. Anyone who can pull
the image can read every layer:

```bash
docker save <image> | tar -xO --wildcards '*/layer.tar' | tar -xO 'var/www/html/shared.env.php'
```

No web server stands between that reader and the file, so the `<?php` guard protects
nothing. Same bytes, different exposure — and until this script, nothing re-asked the
bundle's questions at the layer where the answer changes.

That is the gap this fills. It also answers the questions a bundle audit never had reason
to ask: what user the container runs as, what the base image drags in, what an operator
must restrict at run time.

## Two kinds of image

The same evidence gets two different verdicts, because two different kinds of image are
built from this repository.

| | Published image | Site image |
|---|---|---|
| Built from | `config/shared.env.example` | the deployment's own `config/shared.env` |
| Made by | the release workflow, pushed to the registry | `npm run build`, `docker build`, an operator's own build |
| Who pulls it | anyone | one deployment |
| Credentials in it | must be placeholders only | **expected**, by design |
| A real credential is | a **critical failure** that stops the release | a **handling requirement** |
| Flag | `--profile=published` (the default) | `--profile=site` |

Under `--profile=site` the report still lists every credential it found — the evidence does
not change, the verdict does. What it says instead is that the image is exactly as
sensitive as what it carries: it must live in a registry whose read access matches the
credentials' own, and must never be pushed to a public or shared registry.

`published` is the default, so an unlabelled run of an unknown image never under-reports.

## Where it runs

**In the release workflow** — the authoritative gate. `.github/workflows/docker.yml` runs
the review over the image it just built, as `--profile=published --fail-on=critical`, in the
**`package`** job. That job is a two-way matrix, so **both published architectures are
reviewed**, each on a runner of its own architecture with no emulation. `smoke-test` needs
`package` and `manifest` needs both, so an image carrying a credential never becomes a
version tag or `latest`.

The report is written to the run summary, so it renders as formatted Markdown on the run
page in the browser — no download. The report, the bill of materials and the evidence are
also uploaded as a `container-security-review-amd64` / `-arm64` artifact with 90-day
retention, which is what you send to someone who asks for one.

The two architectures are packaged from the same `dist/` by the same Dockerfile, so their
credentials are necessarily identical and `IMG-01` cannot differ between them. Their base
layers are separate builds of Debian, so their advisory load, setuid inventory and installed
tooling can differ, which is why both are reviewed rather than one taken as representative.

Only a credential stops a release. The posture findings — root by default, the
world-writable webroot, the base image's advisory backlog — are reported for the operator
rather than treated as blockers, because they are the deployment's to close and the report
says how.

**Before pushing a tag** — the local rehearsal:

```bash
npm run audit-release-image
```

This reproduces the release path locally: it builds the production bundle from
`config/shared.env.example` into a scratch `dist-release-audit/`, builds an image from
`Dockerfile.release`, and reviews it as a published image. Your `config/` and your `dist/`
are not touched — the build is redirected with `SITREC_SHARED_ENV` and `SITREC_PROD_PATH`
(see `scripts/buildTarget.js`), which exist so one checkout can build for several
deployments.

It also short-circuits: before the slow image build it checks the generated
`shared.env.php` directly, so a build that read the wrong configuration fails in seconds.

`--skip-build` and `--skip-image` reuse what is already there when iterating.

**Against any image, at any time** — including one an operator has pulled into their own
environment. That is the point of shipping the tool rather than only the report: a review
the recipient can re-run is evidence, and one they cannot is an assertion.

## What the report covers

Findings are grouped by the control areas of [NIST SP 800-190](https://csrc.nist.gov/pubs/sp/800/190/final),
the public *Application Container Security Guide*, so the structure is one a reviewer
already knows.

| Area | SP 800-190 | Checks |
|---|---|---|
| Image contents | §4.1 | baked credentials, secret-scanner findings, fixable and unfixable advisories |
| Image configuration | §4.1.2 | default user, privileged ports, health check, build and network tooling |
| Filesystem posture | §4.1.2, §4.4 | world-writable paths, setuid binaries, source maps, stray development material |
| Provenance | §4.2 | base image pinning, OCI labels, image age |
| Application surface | §4.4.2 | server endpoints, webroot mode, baked configuration files |
| Runtime policy | §4.3, §4.4 | the restrictions this image tolerates, derived from the findings |

It deliberately does **not** assess the host operating system or kernel (§4.5), the
orchestrator's own configuration (§4.3), or the registry's authentication and transport
(§4.2.1, §4.2.3). The report says so in as many words, so a reader cannot over-read it. The
running deployment is verified separately — see the verification section of
[Installing Hardened Sitrec on AWS](Installing-Hardened-Sitrec-on-AWS.md).

### The two advisory counts

The report gives package advisories as two numbers and refuses to add them together.

A current Debian base image carries on the order of 1,500 open advisories, of which perhaps
a dozen have a fixed version. The rest are advisories the distribution has assessed and has
not patched in this release. "1,500 vulnerabilities, 14 critical" is a true sentence that
tells an operator nothing they can act on and invites them to reject a perfectly ordinary
image; **the fixable count is the one that changes when you rebuild**, so the report leads
with it and gives the total as context.

A fixable critical is a failure. An unfixable critical is not, because rebuilding cannot
close it — it is closed by moving base image, or accepted and re-reviewed when the
distribution issues an update.

### It fails closed

A check that could not be performed reports **NOT VERIFIED**, counts as a failure, and — for
`IMG-01` — is a *critical* failure that stops a release.

This matters more than it sounds. If the in-image probe does not run, every check that
reads it sees an empty evidence set, and an empty evidence set is indistinguishable from a
clean image. Treating the two alike would make the review report success at exactly the
moment it examined nothing. So:

- a probe that returns no records is a finding, not a pass;
- completeness is asserted by the probe's own final record, so a sweep killed part-way
  through is not mistaken for one that simply found less;
- an accepted-risk declaration cannot vacuously cover a check that has no evidence;
- a configuration file that **exists but could not be read** is reported as unverified at
  critical severity — otherwise a mode-`600` credential file would contribute no keys, and
  no keys reads exactly like no credentials;
- under `--fail-on`, any collector that did not complete exits non-zero on its own.

The probe reads the image as **UID 0**, whatever user the image declares. This is an
inspection of image *contents*, not a simulation of the runtime: a probe running as the
image's own non-root user cannot read a root-only file or descend into a root-only
directory, and would report the resulting silence as a clean image. What the image declares
as its user is a separate fact, reported by `CFG-01`. If an engine refuses to run anything
as root, the review falls back to the default user and marks every probe-dependent finding
**partial coverage**, so a clean result from a partial sweep is never read as a complete one.

### No secret value ever leaves the image

Three separate paths are closed:

- **Configuration files** are classified *inside* the container. The probe reports only the
  key name, the value's length, and one of `empty` / `placeholder` / `set`.
- **The image config** (`Config.Env`) is classified and then redacted before it is archived,
  so an `ENV OPENAI_API=…` baked into a Dockerfile is *reported* but its value never reaches
  `evidence/inspect.json`.
- **Layer history** has credential assignments in build commands redacted, so an inlined
  `--build-arg` cannot leak through `evidence/history.json`.
- **The secret scanner's** matched text is stripped before anything is written to disk.

So the report and its evidence directory can be circulated freely, even for a site image
whose credentials are real.

A value counts as a placeholder only on an **exact** match (`EXAMPLEKEY`, `CHANGEME`,
`<angle-bracketed>`, …), never a prefix — a real credential that happens to begin with
"example" is not excused. Keys and values are trimmed exactly as `sitrecServer/injectEnv.php`
trims them, because a padded line like `  MAPBOX_TOKEN = live-key  ` is a *live* setting in
the application and must not slip past on whitespace.

## Accepted risks

`scripts/container-audit-baseline.json` declares the risks that are deliberate. It works
like `scripts/secure-egress-allowlist.json`: an entry does not hide a finding, it explains
one. Every entry must state a `reason` and a `compensatingControl`, and the report prints
both next to the finding, marked ACCEPTED RISK.

An entry may narrow itself with `covers`, naming the exact paths it excuses. Anything not
named stays open — so a **new** world-writable directory is a finding even though the ten
expected ones are accepted. Keep `covers` as narrow as the evidence; never accept a check
wholesale to quiet it.

### CFG-01, the root default, is a default and not a limitation

The image declares no `USER`, so `CFG-01` fails. It is worth being clear that this is about
the *default*, not about what the image can do: `--user 33:33` works today with no change to
the image, and is verified to — Apache starts, the entrypoint's rewrite still succeeds, and
the files it creates are owned by that user. A hardened deployment should set it, and
section 4.3 of [Installing Hardened Sitrec on AWS](Installing-Hardened-Sitrec-on-AWS.md) says
how.

The default stays root because the entrypoint's port-80 back-compat listener is root-only,
and removing it would silently break any deployment still mapping to the container's port 80
— the container would start, report itself healthy and serve nothing. Closing `CFG-01` in the
image therefore means retracting a documented compatibility guarantee, which is a release
decision rather than a fix. Until then it is reported honestly, every run, with the
one-flag remedy attached.

### PRV-01: the base images float on purpose

`Dockerfile.release` selects `php:8.4-apache` and `composer:2` by tag, not by digest, and
the baseline declares that as an accepted risk rather than pinning them.

The reasoning is that pinning and patching pull in opposite directions. A floating tag means
a rebuild collects the distribution's current security patches without anyone acting, which
is why `IMG-03` — the advisories a rebuild can close — sits at 13 out of 1547 rather than
climbing. Pin the base and that number grows steadily between deliberate bumps.

Reproducibility is enforced one level up, where it decides what actually runs: the
deployment pins the **application** image by digest, and the hardened-install guide's
verification step compares the digest a running task reports against the digest recorded at
push time. So the bytes in production are pinned and checked even though the base floats.

The residual risk is real and is accepted knowingly: two builds of the same source can
differ in their base layers. This report records the base image's advisory load on every
run, so a base that drifts somewhere harmful becomes visible rather than silent. A **new**
floating `FROM` is not covered by the declaration and still surfaces as a finding.

Two things are known, deliberate, and still **not** accepted:

- **`/var/www/html` is world-writable and non-sticky.** The reason is sound — the entrypoint
  must delete and recreate root-owned files as an arbitrary UID, which an overlay filesystem
  only permits in a writable, non-sticky directory, and check APP-02 states that mechanism
  in full. But a world-writable directory holding the PHP that Apache executes is exactly
  the decision a reviewer must make for themselves, so the report puts it in front of them
  with the rationale attached rather than resolving it on their behalf.

  Note that the obvious answer does **not** work as things stand: `--read-only` fails at
  start-up because the entrypoint must write into the webroot, and a tmpfs over the webroot
  would hide the application entirely. The report says so and withholds the flag rather than
  printing a command that does not run. Closing this properly means removing the need for
  the start-up rewrite — baking settings in at build time — after which `--read-only` becomes
  available and the derived policy starts recommending it automatically.
- **The compiler and package managers inherited from the base image.** Real remediation
  exists, so it stays open as an improvement rather than being written off.

## What a published image can be checked against

A reviewer accepting the image usually wants to know which public standards it can be held
to, and how to verify each claim without taking anyone's word. Three hold today.

### Container security — NIST SP 800-190

Every finding in the report is grouped by a control area of
[NIST SP 800-190](https://csrc.nist.gov/pubs/sp/800/190/final), the public *Application
Container Security Guide*, and the report names the areas it does **not** cover. That is the
whole claim: the review is organised by a recognised framework and is honest about its
scope. Verify it by reading a report — the mapping is printed in it, not asserted here.

### Build provenance — signed, and verifiable by digest

Every published image carries a Sigstore-signed provenance attestation recording which
workflow, at which commit, on which runner produced that exact digest. Both architectures
get one, generated in the `package` job right after each push. Check it with no local
tooling beyond the GitHub CLI:

```bash
gh attestation verify oci://ghcr.io/mickwest/sitrec2:<tag> --repo MickWest/Sitrec2
```

That answers "did this image really come from this source, built by this pipeline" without
trusting the tag, the registry, or us. It is the evidence a supply-chain reviewer asks for
first.

BuildKit also attaches its own provenance attestation when it pushes — visible as an
`attestation-manifest` entry in `docker buildx imagetools inspect --raw` — but that one is
unsigned and unnamed, so it proves less. The signed attestation above is the one to cite.

### Contents — a bill of materials per architecture

Each `package` job publishes a CycloneDX 1.6 bill of materials for the image it built, as
part of the `container-security-review-amd64` / `-arm64` artifact. Components carry name,
version, `purl`, `cpe` and licence, and the document carries its own timestamp, subject
component and generating tool — the fields a consumer needs to match components against an
advisory feed of their own.

## Running inside an isolated network

The scanners need a vulnerability database, which is normally fetched over the network.
Both support an offline workflow: prime the database on a connected machine, carry it in,
and run with updates disabled.

On a connected machine:

```bash
trivy image --download-db-only --cache-dir ./trivy-cache
tar -czf trivy-cache.tar.gz trivy-cache
```

Carry `trivy-cache.tar.gz` in alongside the image, then inside the network:

```bash
tar -xzf trivy-cache.tar.gz
export TRIVY_CACHE_DIR=$PWD/trivy-cache
export TRIVY_SKIP_DB_UPDATE=true
export TRIVY_OFFLINE_SCAN=true
npm run audit-container -- --image=<ref> --profile=site
```

`syft` needs no database — it reads the image's own package metadata — so it works offline
unchanged.

The database ages. A report generated against a database more than a few weeks old should
say so; the report records the scanner versions it used and the time it ran, which is what
lets a reader judge that.

## Re-rendering a report from archived evidence

Evidence and judgement are separate. `dist-audit/evidence/evidence.json` holds everything
the checks read, so a report can be regenerated later — through a newer version of the
script, with a different profile, or simply to check a conclusion:

```bash
node scripts/auditContainerImage.mjs --fixture=dist-audit/evidence --out=/tmp/rerender
```

No container engine and no scanners are needed for that. It is also how
`tests/auditContainerImage.test.js` exercises every check without Docker.

## Options

| Option | Meaning |
|---|---|
| `--image=<ref>` | image to review |
| `--profile=published\|site` | how to judge baked credentials (default `published`) |
| `--out=<dir>` | output directory (default `dist-audit`) |
| `--engine=docker\|podman` | container engine (default: whichever is found) |
| `--dockerfile=<path>` | Dockerfile consulted for base-image pinning (default `Dockerfile.release`) |
| `--baseline=<path>` | accepted-risk declarations |
| `--fixture=<dir>` | read archived evidence instead of running any tool |
| `--fail-on=<sev>` | exit non-zero on an open finding at or above this severity (default `none`) |
| `--json` | also print the machine-readable report to stdout |

## Requirements

A container engine (`docker` or `podman`), [`trivy`](https://trivy.dev) and
[`syft`](https://github.com/anchore/syft). On macOS, `brew install trivy syft`. The script
names what is missing and how to get it rather than silently skipping a section, because a
review with a section quietly missing is worse than no review.

## Related

- [The Secure Build](Secure-Build.md) — the bundle-level audits, and what the secure build removes
- [Installing Hardened Sitrec on AWS](Installing-Hardened-Sitrec-on-AWS.md) — building, pinning and verifying a deployment
- [Deploying on a VPS](Deploying-on-a-VPS.md) — the ordinary container deployment
