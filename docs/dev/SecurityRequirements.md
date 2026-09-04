# Security Requirements

What this project holds itself to, how each requirement is implemented, and how it is
verified. One row per requirement, and every "verified by" names something that actually
runs — a check, a test, or a documented step someone performs — rather than an intention.

The point of writing them down is that an implementation without a stated requirement cannot
be reviewed: a reader can see *what* a control does, but not whether it does what was
intended, nor what would count as a regression. These are the sentences the controls exist to
make true.

Requirements are numbered so other documents can cite them. The numbering is stable; a
requirement that is withdrawn keeps its number and is marked so, rather than being reused.

## Artifacts

**SR-1 — No credential reaches a published artifact.**
A build that anyone can download must contain only the shipped configuration placeholders.
*Implemented:* configuration is read at run time, never compiled in; the container entrypoint
regenerates it from the environment at every start.
*Verified:* `scripts/auditBundleSecrets.js` on every production build (blocking); the
container review's `IMG-01` and `IMG-02` on every published image (blocking, per
architecture).
*Deliberately excluded:* an image an operator builds with their own configuration compiled
in. That is a **site image**, expected to carry credentials, and the review reports it as a
handling requirement — see [Container Security Review](Container-Security-Review.md).

**SR-2 — A published artifact can be traced to the source and pipeline that produced it.**
*Implemented:* per-architecture Sigstore-signed build provenance, pushed beside the image.
*Verified:* `gh attestation verify oci://ghcr.io/mickwest/sitrec2:<tag> --repo MickWest/Sitrec2`,
by anyone, without an account.

**SR-3 — What a published artifact contains is knowable without running it.**
*Implemented:* a CycloneDX bill of materials per architecture, and a container review report.
*Verified:* both attached to the GitHub Release for the version.

**SR-4 — A release's security evidence outlives the build that produced it.**
An operator asked to justify the image they are running may be asked long after the pipeline
that built it has forgotten. Build artifacts expire after 90 days; that is adequate for
debugging and inadequate for a release record.
*Implemented:* the publishing job creates a GitHub Release for the tag and attaches the review
and the bill of materials to it. This is the reason the project publishes Releases at all —
it tags for the pipeline, and releases for the evidence.
*Verified:* the step runs last, after the images are pushed, so a Release can never exist for
an image that was not published.

**SR-5 — A published artifact does not republish its own source.**
*Implemented:* production builds are minified with no source maps emitted.
*Verified:* `scripts/auditBundleEgress.js` fails on any `.map` file or `sourceMappingURL`
in the restricted build; the container review's `FS-04` checks the served webroot.

## Data leaving the application

**SR-6 — Every destination the application can contact is written down before it is used.**
*Implemented:* `scripts/egress-allowlist.json` names each host, its purpose, the trigger,
and the most it may receive from a fixed vocabulary.
*Verified:* `scripts/security-scan-egress.mjs` on every push reports any destination or
server endpoint with no entry; the review layer judges what a regex cannot see.

**SR-7 — A position is only sent where the contract says a position may go.**
*Implemented:* the allow-list's `mayReceive` carries two position classes, `coarse-area` and
`precise-position`.
*Verified:* the egress scan fails outright when a position reaches a destination whose
contract declares neither.

**SR-8 — A deployment on an isolated network can contact nothing but itself.**
*Implemented:* the restricted build **removes** outbound features at compile time rather than
disabling them, so no setting, override or saved file can re-enable one.
*Verified:* `scripts/auditBundleEgress.js` fails on any host literal not in the restricted
allow-list; see [The Secure Build](Secure-Build.md).

## Configuration and defaults

**SR-9 — A security setting can be tightened at run time, never loosened.**
*Implemented:* the restricted build's ratchet in `src/envUtils.js` — a security flag the build
set to `false` accepts `false` and ignores anything else; a blanked credential can never be
supplied at run time.
*Verified:* `tests/envUtilsSecureRatchet.test.js`.

**SR-10 — The credential rule the builds use and the rule the audits use cannot drift apart.**
*Implemented:* both derive from the same name rule; the container review deliberately keeps a
superset rather than importing a build concern.
*Verified:* `tests/auditContainerImage.test.js` proves the superset property against the real
list, so a build narrowing its rule cannot silently narrow a security check.

**SR-11 — A deployment can run the published image without privilege it does not need.**
*Implemented:* the image listens on an unprivileged port and its writable paths work under any
assigned UID.
*Verified:* the container review derives the runtime restrictions the image accepts, and
`--user 33:33` is a documented, tested invocation — section 4.3 of
[Installing Hardened Sitrec on AWS](Installing-Hardened-Sitrec-on-AWS.md).

## The release itself

**SR-12 — A release that fails a gate is not published.**
*Implemented:* the gate matrix in [Vulnerability Handling](VulnerabilityHandling.md).
*Verified:* the publishing job depends on the checking jobs, so a failure means no version tag
and no `latest`.

**SR-13 — A release cannot be published without its security evidence having been produced.**
*Implemented:* the review runs in the job that builds each image, before anything is tagged.
*Verified:* a review that produces no evidence reports `NOT VERIFIED` and fails, rather than
passing on an empty result.

**SR-14 — Published history cannot be rewritten.**
*Implemented:* a branch ruleset on the default branch enforcing no deletion and no
non-fast-forward, with no bypass actors.
*Verified:* the ruleset is active; a force-push is refused for everyone, including the owner.

## What is deliberately not a requirement

Stating these prevents a reader mistaking a decision for an oversight.

- **The published image is not free of known advisories.** Its base distribution carries a
  large, mostly unfixable advisory load. The requirement is that the *fixable* subset is
  known and acted on, not that the total is zero.
- **The image does not run as a non-root user by default.** It supports it, and a hardened
  deployment should set it; the default remains root only because the entrypoint's
  compatibility listener for the old privileged port is root-only, and changing that silently
  breaks deployments still mapping to it.
- **Object storage is public by design.** The object key is the capability; that decision is
  recorded rather than treated as a finding.
- **The project makes no availability guarantee.** Nothing here is about uptime.

## Reviewing this document

A requirement is worth changing when the code stops matching it — in either direction. If a
control is removed, the requirement it served must be withdrawn deliberately, in writing, or
it becomes a claim the project no longer meets. If a new control is added, it either serves an
existing requirement or reveals one that was never stated.

Related: [Vulnerability Handling](VulnerabilityHandling.md) covers what happens when one of
these is found not to hold.
