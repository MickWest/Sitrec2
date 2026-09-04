# ---------------------------------------------------------------------------
# Identity and placement
# ---------------------------------------------------------------------------

variable "name" {
  description = "Base name for every resource this module creates (cluster, service, buckets, roles, log group). Lower-case letters, digits and hyphens."
  type        = string
  default     = "sitrec"

  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{1,30}$", var.name))
    error_message = "name must be 2-31 characters of lower-case letters, digits and hyphens, starting with a letter (it is also used in S3 bucket names and a trust store name)."
  }
}

variable "region" {
  description = "AWS region to deploy into. The partition is derived from the region by the provider; no partition-specific value is needed anywhere else."
  type        = string
}

variable "fips" {
  description = "Use FIPS endpoints: the provider resolves FIPS endpoints for its own API calls, the balancer uses a FIPS TLS security policy, and the task is given S3_USE_FIPS=true. Turn off only in a partition that has no FIPS endpoints."
  type        = bool
  default     = true
}

variable "tags" {
  description = "Extra tags applied to every resource through the provider's default tags."
  type        = map(string)
  default     = {}
}

# ---------------------------------------------------------------------------
# Image
# ---------------------------------------------------------------------------

variable "image" {
  description = <<-EOT
    The image to run, pinned by digest. Either a bare digest (sha256:<64 hex>),
    which is resolved against the ECR repository this module creates, or a full
    <registry>/<repository>@sha256:<digest> reference to an image in this
    account's registry. Tags are refused: a tag can move, a digest cannot.
    This must be the derived image that carries the trust store bundle and the
    user map under /etc/sitrec/trust/; the module does not build or push images.
  EOT
  type        = string

  validation {
    condition     = can(regex("^(sha256:[0-9a-f]{64}|[^@[:space:]]+@sha256:[0-9a-f]{64})$", var.image))
    error_message = "image must be a digest (sha256:<64 hex digits>) or a full reference ending in @sha256:<64 hex digits>."
  }
}

# ---------------------------------------------------------------------------
# Edge: hostname, server certificate, who may connect
# ---------------------------------------------------------------------------

variable "hostname" {
  description = "Fully qualified host name users type, e.g. sitrec.example.org. It names the server certificate and, when route53_zone_id is set, the alias record."
  type        = string

  validation {
    condition     = can(regex("^([a-z0-9-]+\\.)+[a-z0-9-]+$", var.hostname))
    error_message = "hostname must be a lower-case fully qualified domain name without a trailing dot."
  }
}

variable "route53_zone_id" {
  description = "Route 53 hosted zone that contains hostname. When set, the module requests an ACM certificate validated by DNS and creates the alias record. Leave empty if DNS lives elsewhere and pass certificate_arn instead."
  type        = string
  default     = ""
}

variable "certificate_arn" {
  description = "ARN of an existing server certificate in ACM (issued or imported) for hostname. Used when route53_zone_id is empty."
  type        = string
  default     = ""
}

variable "client_cidrs" {
  description = "Address ranges allowed to reach the balancer on 443. Everything else is dropped before the TLS handshake."
  type        = list(string)

  validation {
    condition     = length(var.client_cidrs) > 0 && alltrue([for cidr in var.client_cidrs : can(cidrhost(cidr, 0))])
    error_message = "client_cidrs must contain at least one valid IPv4 CIDR block."
  }
}

variable "ssl_policy" {
  description = "Balancer TLS security policy. Empty selects a TLS 1.3-only policy: the FIPS one when fips is true, the standard one otherwise."
  type        = string
  default     = ""
}

variable "csp" {
  description = "Content-Security-Policy response header the balancer inserts on every response. The default is the tightest policy the application runs under: scripts only from the site (the entrypoint writes runtime settings to a file, never inline) plus WebAssembly for the video and tracking code; styles from the site plus inline, because the UI library injects its stylesheet as a style element; workers, media and images from the site or blob URLs."
  type        = string
  default     = "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob:; font-src 'self' data:; worker-src 'self' blob:; connect-src 'self' blob:; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'"
}

# ---------------------------------------------------------------------------
# Client certificate trust
# ---------------------------------------------------------------------------

variable "trust_store_bundle_path" {
  description = "Local path to the certificate-authority bundle (PEM: root and intermediates, no blank lines) the balancer verifies client certificates against. Uploaded to the trust store bucket by Terraform."
  type        = string
}

variable "allow_destroy" {
  description = "Let `terraform destroy` empty the buckets and the image repository first. Off, a bucket holding objects or a repository holding images refuses deletion and the destroy stops there, which is the right behaviour for a real deployment. On, for a rehearsal that is torn down after every session."
  type        = bool
  default     = false
}

variable "crl_path" {
  description = "Local path to a PEM file of certificate revocation lists (one per issuing authority, concatenated as a proxy would want them). Each CRL in it is attached to the trust store separately. Empty for none."
  type        = string
  default     = ""
}

# ---------------------------------------------------------------------------
# Task
# ---------------------------------------------------------------------------

variable "task_cpu" {
  description = "Fargate task CPU units (256, 512, 1024, 2048, 4096)."
  type        = number
  default     = 512
}

variable "task_memory" {
  description = "Fargate task memory in MiB; must be valid for task_cpu."
  type        = number
  default     = 1024
}

variable "task_environment" {
  description = <<-EOT
    Environment for the container, merged over the module's hardened defaults
    (a key given here replaces the default of the same name). Use it for the
    values that are yours: AUTH_POLICY_OIDS, AUTH_ID_SOURCE, AUTH_ID_PATTERN,
    the SITREC_CUSTOM_MAP_INTERNAL_* and SITREC_CUSTOM_ELEVATION_INTERNAL_*
    settings, DEFAULT_MAP_TYPE, DEFAULT_ELEVATION_TYPE. Never put a secret here:
    it lands in the task definition and in state.
  EOT
  type        = map(string)
  default     = {}
}

variable "enable_exec" {
  description = "Allow an operator shell inside the running task (ECS Exec). Adds the ssmmessages permissions to the task role. Turn off once verified if policy forbids interactive access."
  type        = bool
  default     = false
}

variable "enable_bedrock_endpoint" {
  description = "Create the bedrock-runtime interface endpoint and let the task role invoke models. Off unless a model service is part of the deployment."
  type        = bool
  default     = false
}

# ---------------------------------------------------------------------------
# Storage and access
# ---------------------------------------------------------------------------

variable "admin_role_arn" {
  description = "ARN of a role that may read and write data bucket objects from outside the VPC endpoint (backups, migrations). Empty means objects are reachable only through the endpoint."
  type        = string
  default     = ""
}

variable "log_retention_days" {
  description = "Retention of the application log group in days."
  type        = number
  default     = 90
}

# ---------------------------------------------------------------------------
# Network
# ---------------------------------------------------------------------------

variable "vpc_cidr" {
  description = "Address block of the VPC. Four /24 subnets are carved from it: two private (tasks) and two public (balancer only)."
  type        = string
  default     = "10.40.0.0/16"

  validation {
    condition     = can(cidrsubnet(var.vpc_cidr, 8, 129))
    error_message = "vpc_cidr must be an IPv4 block of /24 or larger (at least 130 /24 subnets are addressed from it)."
  }
}
