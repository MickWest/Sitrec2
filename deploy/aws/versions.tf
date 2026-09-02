# Sitrec hardened deployment on AWS: ECS on Fargate behind an Application Load
# Balancer with client certificate authentication, in a VPC with no route to
# the internet from the tasks.
#
# The module is partition-neutral by construction. Every ARN, service principal
# and endpoint name is built from the aws_partition, aws_caller_identity and
# aws_region data sources, so the same files apply unchanged in any AWS
# partition. No region or partition name appears in the .tf files.

terraform {
  required_version = ">= 1.9"

  required_providers {
    aws = {
      source = "hashicorp/aws"
      # 6.x carries everything this module uses: listener mutual TLS with CA
      # name advertisement, listener response-header attributes, balancer
      # connection logs, trust stores and revocations, and the partition data
      # source's reverse_dns_prefix.
      version = "~> 6.0"
    }
  }
}
