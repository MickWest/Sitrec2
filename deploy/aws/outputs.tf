output "balancer_dns_name" {
  description = "DNS name of the balancer. Point hostname at it (an alias record is created when route53_zone_id is set)."
  value       = aws_lb.this.dns_name
}

output "balancer_subnet_cidrs" {
  description = "Address blocks of the balancer's subnets; the task's AUTH_TRUSTED_PROXIES."
  value       = aws_subnet.public[*].cidr_block
}

output "data_bucket" {
  description = "Bucket holding user saves and uploads."
  value       = aws_s3_bucket.this["data"].id
}

output "mirror_bucket" {
  description = "Bucket for staged map, elevation and element-set data."
  value       = aws_s3_bucket.this["mirror"].id
}

output "truststore_bucket" {
  description = "Bucket holding the balancer's CA bundle and revocation list."
  value       = aws_s3_bucket.this["truststore"].id
}

output "logs_bucket" {
  description = "Bucket receiving balancer logs, flow logs and the trail."
  value       = aws_s3_bucket.this["logs"].id
}

output "ecr_repository_url" {
  description = "Repository to push the derived image to."
  value       = aws_ecr_repository.sitrec.repository_url
}

output "task_definition_arn" {
  description = "ARN of the registered task definition (with revision)."
  value       = aws_ecs_task_definition.this.arn
}

output "cluster_name" {
  description = "ECS cluster name."
  value       = aws_ecs_cluster.this.name
}

output "service_name" {
  description = "ECS service name."
  value       = aws_ecs_service.this.name
}

output "vpc_id" {
  description = "The VPC."
  value       = aws_vpc.this.id
}

output "s3_endpoint_id" {
  description = "Gateway endpoint the data bucket policy admits."
  value       = aws_vpc_endpoint.s3.id
}

output "storage_key_arn" {
  description = "Customer-managed key for the data, mirror and trust store buckets."
  value       = aws_kms_key.storage.arn
}
