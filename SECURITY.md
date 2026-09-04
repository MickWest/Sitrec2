# Security Policy

## Reporting a vulnerability

**Report privately, not in a public issue.** Use GitHub's private vulnerability reporting on
this repository — the **Security** tab, then **Report a vulnerability**. That opens a private
advisory visible only to the maintainers, and it is the preferred route because it keeps the
report and the fix in one place until there is something to disclose.

If private reporting is unavailable to you, email the maintainer address on the GitHub
profile of the repository owner rather than opening an issue.

Please include, as far as you can:

- what an attacker can do, not only what is wrong;
- the version or commit you tested, and which deployment form (the hosted site, a
  self-hosted server build, the serverless or desktop build, or a container image);
- the smallest reproduction you have.

**What to expect.** An acknowledgement within a week. An initial assessment — severity, and
whether it is confirmed — within two weeks. Fixes ship in an ordinary patch release; there is
no separate embargoed release channel. You will be credited in the changelog unless you ask
not to be.

What happens after that — how a finding is triaged, the response times by severity, what
counts as closing one, and when a root cause is required — is written down in
[Vulnerability Handling](docs/dev/VulnerabilityHandling.md). The properties those checks
exist to protect are listed in [Security Requirements](docs/dev/SecurityRequirements.md).

**Please do not** run automated scanners against the hosted site, attempt denial of service,
or access data belonging to other users. Testing against your own local build or your own
container is always fine and is the easiest way to be sure of a finding.

## Supported versions

Only the latest released version is supported. Sitrec releases frequently and small patch
versions are the normal delivery mechanism for a fix, so the remedy for a security issue is
to update rather than to backport. Container images are published per release; `latest`
tracks the newest.

## What is checked automatically

These run in CI and are described in the developer documentation. They are not a substitute
for review. The distinction in the last column is deliberate: a **blocking** check stops a
release when it fails, while a **reporting** check raises something for a human to act on and
does not by itself hold anything back.

| Check | What it looks for | Where | Effect |
|---|---|---|---|
| Bundle secret audit | A credential in a built bundle | `scripts/auditBundleSecrets.js` | Blocking — aborts the production deploy |
| Bundle egress audit | An unlisted outbound host, or a source map, in the restricted build | `scripts/auditBundleEgress.js` | Blocking — fails the build |
| Container security review | A credential in a published image, plus container posture against NIST SP 800-190 | [Container Security Review](docs/dev/Container-Security-Review.md) | Blocking on a credential; posture findings reported |
| Release smoke test | A console error on load, a missing server dependency, a broken image | `.github/workflows/docker.yml` | Blocking — no version or `latest` tag is created |
| User-data egress check | A new outbound destination or data sink arriving unreviewed | [User Data Egress Check](docs/UserDataEgressCheck.md) | Reporting — posted on the commit |
| Code scanning | Static analysis across the JavaScript, TypeScript, Python and workflow sources | GitHub code scanning | Reporting |
| Dependency alerts and updates | Known-vulnerable dependencies across the four dependency projects | GitHub Dependabot | Reporting — proposes updates |
| Dependency review | A pull request introducing a high-severity advisory | `.github/workflows/dependency-review.yml` | Blocking on that pull request only |
| Build provenance | — | Signed attestation, see below | Produces evidence rather than checking anything |

## Verifying a release

Every published container image carries a signed record of the workflow, commit and runner
that produced that exact digest. Check one before you use it:

```bash
gh attestation verify oci://ghcr.io/mickwest/sitrec2:<tag> --repo MickWest/Sitrec2
```

Each release also publishes a CycloneDX software bill of materials and a container security
review report, one of each per architecture. They are **attached to the GitHub Release** for
that version, so they remain available for as long as the release does rather than expiring
with a build artifact. See [Container Security Review](docs/dev/Container-Security-Review.md)
for what they contain and how to read them.

## Deploying Sitrec securely

If you run your own instance, two documents matter:

- [The Secure Build](docs/dev/Secure-Build.md) — a build with every outbound feature removed
  at compile time, for a deployment that must not contact anything but itself.
- [Installing Hardened Sitrec on AWS](docs/dev/Installing-Hardened-Sitrec-on-AWS.md) —
  certificate-based authentication, private object storage, image digest pinning, and a
  verification table to work through once the service is up.

Configuration is read at run time and no credential is compiled into a published artifact.
Keep your own configuration out of any image you build from your own settings: such an image
is as sensitive as the credentials it carries, and belongs only in a registry whose read
access matches.
