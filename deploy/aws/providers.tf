provider "aws" {
  region            = var.region
  use_fips_endpoint = var.fips

  default_tags {
    tags = merge(
      {
        Project   = var.name
        ManagedBy = "terraform"
      },
      var.tags,
    )
  }
}

data "aws_partition" "current" {}

data "aws_caller_identity" "current" {}

data "aws_region" "current" {}

data "aws_availability_zones" "available" {
  state = "available"

  filter {
    name   = "opt-in-status"
    values = ["opt-in-not-required"]
  }
}

locals {
  partition          = data.aws_partition.current.partition
  dns_suffix         = data.aws_partition.current.dns_suffix
  reverse_dns_prefix = data.aws_partition.current.reverse_dns_prefix
  account_id         = data.aws_caller_identity.current.account_id
  region             = data.aws_region.current.region

  # Two availability zones: one subnet pair each.
  availability_zones = slice(data.aws_availability_zones.available.names, 0, 2)
}
