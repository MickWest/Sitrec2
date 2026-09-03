# The container registry the task pulls from. The module creates the
# repository; building and pushing the image is the operator's step (see the
# README). Images are pinned by digest, and tags are immutable.

data "aws_iam_policy_document" "registry_key" {
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
}

resource "aws_kms_key" "registry" {
  description             = "${var.name}: container registry"
  deletion_window_in_days = 30
  enable_key_rotation     = true
  policy                  = data.aws_iam_policy_document.registry_key.json
}

resource "aws_kms_alias" "registry" {
  name          = "alias/${var.name}-registry"
  target_key_id = aws_kms_key.registry.key_id
}

resource "aws_ecr_repository" "sitrec" {
  name                 = var.name
  image_tag_mutability = "IMMUTABLE"
  # Only a rehearsal may lose its images to destroy (see var.allow_destroy).
  force_delete = var.allow_destroy

  image_scanning_configuration {
    scan_on_push = true
  }

  encryption_configuration {
    encryption_type = "KMS"
    kms_key         = aws_kms_key.registry.arn
  }
}

locals {
  # The registry hostname the task pulls from. Not repository_url: with FIPS
  # endpoints on, the provider reports the repository under the registry's
  # FIPS hostname, and the registry interface endpoint in network.tf resolves
  # only the standard hostname (the FIPS one is a separate endpoint service,
  # and not every partition offers it). The task has no route out, so a pull
  # from any hostname the endpoint does not serve fails. The push from outside
  # can use either; ecr_repository_url is what the provider reports.
  registry_host = "${aws_ecr_repository.sitrec.registry_id}.dkr.ecr.${local.region}.${data.aws_partition.current.dns_suffix}"

  # A bare digest is resolved against the repository created here; a full
  # reference is used as given.
  image = startswith(var.image, "sha256:") ? "${local.registry_host}/${aws_ecr_repository.sitrec.name}@${var.image}" : var.image
}
