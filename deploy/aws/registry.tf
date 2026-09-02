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

  image_scanning_configuration {
    scan_on_push = true
  }

  encryption_configuration {
    encryption_type = "KMS"
    kms_key         = aws_kms_key.registry.arn
  }
}

locals {
  # A bare digest is resolved against the repository created here; a full
  # reference is used as given.
  image = startswith(var.image, "sha256:") ? "${aws_ecr_repository.sitrec.repository_url}@${var.image}" : var.image
}
