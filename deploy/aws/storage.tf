# Four buckets, all with public access blocked, versioning on and the bucket
# owner enforced as object owner:
#   data        user saves and uploads (the application's only state)
#   mirror      staged map, elevation and element-set data for internal services
#   truststore  the balancer's CA bundle and revocation list
#   logs        balancer access and connection logs, VPC flow logs, the trail
# The first three use a customer-managed KMS key. The logs bucket uses S3
# managed keys (AES256) because the load-balancer log delivery cannot write to
# a KMS-encrypted bucket.

locals {
  bucket_names = {
    data       = "${var.name}-data-${local.account_id}-${local.region}"
    mirror     = "${var.name}-mirror-${local.account_id}-${local.region}"
    truststore = "${var.name}-truststore-${local.account_id}-${local.region}"
    logs       = "${var.name}-logs-${local.account_id}-${local.region}"
  }
  kms_buckets = ["data", "mirror", "truststore"]

  trail_arn = "arn:${local.partition}:cloudtrail:${local.region}:${local.account_id}:trail/${var.name}"
}

# ---------------------------------------------------------------------------
# Customer-managed key for the data, mirror and trust store buckets
# ---------------------------------------------------------------------------

data "aws_iam_policy_document" "storage_key" {
  statement {
    sid       = "AccountAdministration"
    effect    = "Allow"
    actions   = ["kms:*"]
    resources = ["*"]

    principals {
      type        = "AWS"
      identifiers = ["arn:${local.partition}:iam::${local.account_id}:root"]
    }
  }

  # The load-balancing service reads the trust store bundle from S3.
  statement {
    sid       = "LoadBalancerReadsTrustStore"
    effect    = "Allow"
    actions   = ["kms:Decrypt"]
    resources = ["*"]

    principals {
      type        = "Service"
      identifiers = ["elasticloadbalancing.${local.dns_suffix}"]
    }

    condition {
      test     = "StringEquals"
      variable = "aws:SourceAccount"
      values   = [local.account_id]
    }

    condition {
      test     = "StringEquals"
      variable = "kms:ViaService"
      values   = ["s3.${local.region}.${local.dns_suffix}"]
    }
  }
}

resource "aws_kms_key" "storage" {
  description             = "${var.name}: data, mirror and trust store buckets"
  deletion_window_in_days = 30
  enable_key_rotation     = true
  policy                  = data.aws_iam_policy_document.storage_key.json
}

resource "aws_kms_alias" "storage" {
  name          = "alias/${var.name}-storage"
  target_key_id = aws_kms_key.storage.key_id
}

# ---------------------------------------------------------------------------
# Buckets
# ---------------------------------------------------------------------------

resource "aws_s3_bucket" "this" {
  for_each = local.bucket_names

  bucket = each.value

  # Only a rehearsal may be emptied by destroy (see var.allow_destroy).
  force_destroy = var.allow_destroy

  tags = { Name = each.value }
}

resource "aws_s3_bucket_public_access_block" "this" {
  for_each = aws_s3_bucket.this

  bucket                  = each.value.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_ownership_controls" "this" {
  for_each = aws_s3_bucket.this

  bucket = each.value.id

  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

resource "aws_s3_bucket_versioning" "this" {
  for_each = aws_s3_bucket.this

  bucket = each.value.id

  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "this" {
  for_each = aws_s3_bucket.this

  bucket = each.value.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm     = contains(local.kms_buckets, each.key) ? "aws:kms" : "AES256"
      kms_master_key_id = contains(local.kms_buckets, each.key) ? aws_kms_key.storage.arn : null
    }
    bucket_key_enabled = contains(local.kms_buckets, each.key)
  }
}

# ---------------------------------------------------------------------------
# Data bucket policy: objects are reachable only through the VPC endpoint, or
# from the administrative role if one is named. Bucket configuration and
# listing are left to IAM so the deploying identity can keep managing the
# bucket; the objects are what must not leave.
# ---------------------------------------------------------------------------

data "aws_iam_policy_document" "data_bucket" {
  statement {
    sid    = "ObjectsOnlyThroughTheEndpoint"
    effect = "Deny"
    actions = [
      "s3:GetObject",
      "s3:GetObjectVersion",
      "s3:GetObjectAttributes",
      "s3:GetObjectVersionAttributes",
      "s3:PutObject",
      "s3:DeleteObject",
      "s3:DeleteObjectVersion",
    ]
    resources = ["${aws_s3_bucket.this["data"].arn}/*"]

    principals {
      type        = "*"
      identifiers = ["*"]
    }

    condition {
      test     = "StringNotEquals"
      variable = "aws:SourceVpce"
      values   = [aws_vpc_endpoint.s3.id]
    }

    dynamic "condition" {
      for_each = var.admin_role_arn != "" ? [var.admin_role_arn] : []
      content {
        test     = "ArnNotLike"
        variable = "aws:PrincipalArn"
        values   = [condition.value]
      }
    }
  }
}

resource "aws_s3_bucket_policy" "data" {
  bucket = aws_s3_bucket.this["data"].id
  policy = data.aws_iam_policy_document.data_bucket.json

  depends_on = [aws_s3_bucket_public_access_block.this]
}

# ---------------------------------------------------------------------------
# Trust store bucket policy: the load-balancing service may read the bundle
# and the revocation list.
# ---------------------------------------------------------------------------

data "aws_iam_policy_document" "truststore_bucket" {
  statement {
    sid       = "LoadBalancerReadsBundle"
    effect    = "Allow"
    actions   = ["s3:GetObject", "s3:GetObjectVersion"]
    resources = ["${aws_s3_bucket.this["truststore"].arn}/*"]

    principals {
      type        = "Service"
      identifiers = ["elasticloadbalancing.${local.dns_suffix}"]
    }

    condition {
      test     = "StringEquals"
      variable = "aws:SourceAccount"
      values   = [local.account_id]
    }
  }
}

resource "aws_s3_bucket_policy" "truststore" {
  bucket = aws_s3_bucket.this["truststore"].id
  policy = data.aws_iam_policy_document.truststore_bucket.json

  depends_on = [aws_s3_bucket_public_access_block.this]
}

# ---------------------------------------------------------------------------
# Logs bucket policy: the three delivery services, each scoped to its own
# prefix under this account's path.
# ---------------------------------------------------------------------------

data "aws_elb_service_account" "current" {}

data "aws_iam_policy_document" "logs_bucket" {
  # Balancer access and connection logs: the regional load-balancer account
  # (regions that predate the service principal) ...
  statement {
    sid     = "BalancerLogsFromTheRegionalAccount"
    effect  = "Allow"
    actions = ["s3:PutObject"]
    resources = [
      "${aws_s3_bucket.this["logs"].arn}/alb/access/AWSLogs/${local.account_id}/*",
      "${aws_s3_bucket.this["logs"].arn}/alb/connection/AWSLogs/${local.account_id}/*",
    ]

    principals {
      type        = "AWS"
      identifiers = [data.aws_elb_service_account.current.arn]
    }
  }

  # ... and the log delivery service principal (regions that use it).
  statement {
    sid     = "BalancerLogsFromTheDeliveryService"
    effect  = "Allow"
    actions = ["s3:PutObject"]
    resources = [
      "${aws_s3_bucket.this["logs"].arn}/alb/access/AWSLogs/${local.account_id}/*",
      "${aws_s3_bucket.this["logs"].arn}/alb/connection/AWSLogs/${local.account_id}/*",
    ]

    principals {
      type        = "Service"
      identifiers = ["logdelivery.elasticloadbalancing.${local.dns_suffix}"]
    }

    condition {
      test     = "ArnLike"
      variable = "aws:SourceArn"
      values   = ["arn:${local.partition}:elasticloadbalancing:${local.region}:${local.account_id}:loadbalancer/*"]
    }
  }

  # VPC flow logs.
  statement {
    sid       = "FlowLogsAclCheck"
    effect    = "Allow"
    actions   = ["s3:GetBucketAcl", "s3:ListBucket"]
    resources = [aws_s3_bucket.this["logs"].arn]

    principals {
      type        = "Service"
      identifiers = ["delivery.logs.${local.dns_suffix}"]
    }

    condition {
      test     = "StringEquals"
      variable = "aws:SourceAccount"
      values   = [local.account_id]
    }

    condition {
      test     = "ArnLike"
      variable = "aws:SourceArn"
      values   = ["arn:${local.partition}:logs:${local.region}:${local.account_id}:*"]
    }
  }

  statement {
    sid       = "FlowLogsWrite"
    effect    = "Allow"
    actions   = ["s3:PutObject"]
    resources = ["${aws_s3_bucket.this["logs"].arn}/flow/AWSLogs/${local.account_id}/*"]

    principals {
      type        = "Service"
      identifiers = ["delivery.logs.${local.dns_suffix}"]
    }

    condition {
      test     = "StringEquals"
      variable = "s3:x-amz-acl"
      values   = ["bucket-owner-full-control"]
    }

    condition {
      test     = "StringEquals"
      variable = "aws:SourceAccount"
      values   = [local.account_id]
    }

    condition {
      test     = "ArnLike"
      variable = "aws:SourceArn"
      values   = ["arn:${local.partition}:logs:${local.region}:${local.account_id}:*"]
    }
  }

  # The trail.
  statement {
    sid       = "TrailAclCheck"
    effect    = "Allow"
    actions   = ["s3:GetBucketAcl"]
    resources = [aws_s3_bucket.this["logs"].arn]

    principals {
      type        = "Service"
      identifiers = ["cloudtrail.${local.dns_suffix}"]
    }

    condition {
      test     = "StringEquals"
      variable = "aws:SourceArn"
      values   = [local.trail_arn]
    }
  }

  statement {
    sid       = "TrailWrite"
    effect    = "Allow"
    actions   = ["s3:PutObject"]
    resources = ["${aws_s3_bucket.this["logs"].arn}/trail/AWSLogs/${local.account_id}/*"]

    principals {
      type        = "Service"
      identifiers = ["cloudtrail.${local.dns_suffix}"]
    }

    condition {
      test     = "StringEquals"
      variable = "s3:x-amz-acl"
      values   = ["bucket-owner-full-control"]
    }

    condition {
      test     = "StringEquals"
      variable = "aws:SourceArn"
      values   = [local.trail_arn]
    }
  }
}

resource "aws_s3_bucket_policy" "logs" {
  bucket = aws_s3_bucket.this["logs"].id
  policy = data.aws_iam_policy_document.logs_bucket.json

  depends_on = [aws_s3_bucket_public_access_block.this]
}

# ---------------------------------------------------------------------------
# Trust store material, uploaded from the operator's machine
# ---------------------------------------------------------------------------

resource "aws_s3_object" "ca_bundle" {
  bucket                 = aws_s3_bucket.this["truststore"].id
  key                    = "ca-bundle.pem"
  source                 = var.trust_store_bundle_path
  source_hash            = filemd5(var.trust_store_bundle_path)
  content_type           = "application/x-pem-file"
  server_side_encryption = "aws:kms"
  kms_key_id             = aws_kms_key.storage.arn

  # Versioning must be on before the first upload so the object has a version
  # id for the trust store to pin.
  depends_on = [aws_s3_bucket_versioning.this]
}

# The balancer accepts exactly one CRL per revocation file ("More than one CRL
# objects in the revocation file" otherwise), while a proxy such as nginx wants
# one concatenated bundle with a CRL per issuing authority. The operator supplies
# the bundle; each CRL in it becomes its own object and its own revocation entry.
locals {
  crls = var.crl_path != "" ? regexall("-----BEGIN X509 CRL-----[\\s\\S]*?-----END X509 CRL-----", file(var.crl_path)) : []
}

resource "aws_s3_object" "crl" {
  count = length(local.crls)

  bucket                 = aws_s3_bucket.this["truststore"].id
  key                    = "crl-${count.index}.pem"
  content                = "${local.crls[count.index]}\n"
  source_hash            = md5(local.crls[count.index])
  content_type           = "application/x-pem-file"
  server_side_encryption = "aws:kms"
  kms_key_id             = aws_kms_key.storage.arn

  depends_on = [aws_s3_bucket_versioning.this]
}
