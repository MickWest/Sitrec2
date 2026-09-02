# VPC with two private subnets (tasks) and two public subnets (balancer only),
# no NAT gateway, an internet gateway routed from the public subnets only, a
# gateway endpoint for S3 and interface endpoints for the services the task and
# the ECS agent need. The tasks have no route to the internet.

locals {
  private_subnet_cidrs = [for i in range(2) : cidrsubnet(var.vpc_cidr, 8, i)]
  public_subnet_cidrs  = [for i in range(2) : cidrsubnet(var.vpc_cidr, 8, 128 + i)]

  # Interface endpoints. Service names follow the partition's reverse DNS
  # prefix, so they resolve correctly in every partition.
  interface_endpoint_services = merge(
    {
      "ecr.api"        = "ECR API (image manifests)"
      "ecr.dkr"        = "ECR registry (image layers)"
      "logs"           = "CloudWatch Logs (awslogs driver)"
      "secretsmanager" = "Secrets Manager (task secrets, if any)"
      "ssmmessages"    = "Session channel for ECS Exec"
    },
    var.enable_bedrock_endpoint ? { "bedrock-runtime" = "Model invocation" } : {},
  )
}

resource "aws_vpc" "this" {
  cidr_block           = var.vpc_cidr
  enable_dns_support   = true
  enable_dns_hostnames = true

  tags = { Name = var.name }
}

resource "aws_subnet" "private" {
  count = 2

  vpc_id            = aws_vpc.this.id
  cidr_block        = local.private_subnet_cidrs[count.index]
  availability_zone = local.availability_zones[count.index]

  tags = { Name = "${var.name}-private-${count.index}" }
}

resource "aws_subnet" "public" {
  count = 2

  vpc_id                  = aws_vpc.this.id
  cidr_block              = local.public_subnet_cidrs[count.index]
  availability_zone       = local.availability_zones[count.index]
  map_public_ip_on_launch = false

  tags = { Name = "${var.name}-public-${count.index}" }
}

resource "aws_internet_gateway" "this" {
  vpc_id = aws_vpc.this.id

  tags = { Name = var.name }
}

# Public route table: default route to the internet gateway. Only the balancer
# subnets are associated with it.
resource "aws_route_table" "public" {
  vpc_id = aws_vpc.this.id

  tags = { Name = "${var.name}-public" }
}

resource "aws_route" "public_default" {
  route_table_id         = aws_route_table.public.id
  destination_cidr_block = "0.0.0.0/0"
  gateway_id             = aws_internet_gateway.this.id
}

resource "aws_route_table_association" "public" {
  count = 2

  subnet_id      = aws_subnet.public[count.index].id
  route_table_id = aws_route_table.public.id
}

# Private route table: no default route. The S3 gateway endpoint adds the only
# route that leaves the VPC.
resource "aws_route_table" "private" {
  vpc_id = aws_vpc.this.id

  tags = { Name = "${var.name}-private" }
}

resource "aws_route_table_association" "private" {
  count = 2

  subnet_id      = aws_subnet.private[count.index].id
  route_table_id = aws_route_table.private.id
}

# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------

resource "aws_vpc_endpoint" "s3" {
  vpc_id            = aws_vpc.this.id
  service_name      = "${local.reverse_dns_prefix}.${local.region}.s3"
  vpc_endpoint_type = "Gateway"
  route_table_ids   = [aws_route_table.private.id]

  tags = { Name = "${var.name}-s3" }
}

resource "aws_vpc_endpoint" "interface" {
  for_each = local.interface_endpoint_services

  vpc_id              = aws_vpc.this.id
  service_name        = "${local.reverse_dns_prefix}.${local.region}.${each.key}"
  vpc_endpoint_type   = "Interface"
  subnet_ids          = aws_subnet.private[*].id
  security_group_ids  = [aws_security_group.endpoints.id]
  private_dns_enabled = true

  tags = { Name = "${var.name}-${each.key}" }
}

# ---------------------------------------------------------------------------
# Security groups
# ---------------------------------------------------------------------------

# Balancer: 443 in from the client ranges; out only to the task port.
resource "aws_security_group" "balancer" {
  name        = "${var.name}-balancer"
  description = "Application load balancer for ${var.name}"
  vpc_id      = aws_vpc.this.id

  tags = { Name = "${var.name}-balancer" }
}

resource "aws_vpc_security_group_ingress_rule" "balancer_https" {
  for_each = toset(var.client_cidrs)

  security_group_id = aws_security_group.balancer.id
  description       = "HTTPS from clients"
  ip_protocol       = "tcp"
  from_port         = 443
  to_port           = 443
  cidr_ipv4         = each.value
}

resource "aws_vpc_security_group_egress_rule" "balancer_to_task" {
  security_group_id            = aws_security_group.balancer.id
  description                  = "Forward to the task"
  ip_protocol                  = "tcp"
  from_port                    = 8080
  to_port                      = 8080
  referenced_security_group_id = aws_security_group.task.id
}

# Task: 8080 in from the balancer only; out only to the interface endpoints and
# to S3 through the gateway endpoint.
resource "aws_security_group" "task" {
  name        = "${var.name}-task"
  description = "Fargate task for ${var.name}"
  vpc_id      = aws_vpc.this.id

  tags = { Name = "${var.name}-task" }
}

resource "aws_vpc_security_group_ingress_rule" "task_from_balancer" {
  security_group_id            = aws_security_group.task.id
  description                  = "HTTP from the balancer"
  ip_protocol                  = "tcp"
  from_port                    = 8080
  to_port                      = 8080
  referenced_security_group_id = aws_security_group.balancer.id
}

resource "aws_vpc_security_group_egress_rule" "task_to_endpoints" {
  security_group_id            = aws_security_group.task.id
  description                  = "HTTPS to the interface endpoints"
  ip_protocol                  = "tcp"
  from_port                    = 443
  to_port                      = 443
  referenced_security_group_id = aws_security_group.endpoints.id
}

resource "aws_vpc_security_group_egress_rule" "task_to_s3" {
  security_group_id = aws_security_group.task.id
  description       = "HTTPS to S3 through the gateway endpoint"
  ip_protocol       = "tcp"
  from_port         = 443
  to_port           = 443
  prefix_list_id    = aws_vpc_endpoint.s3.prefix_list_id
}

# Interface endpoints: 443 in from the task only.
resource "aws_security_group" "endpoints" {
  name        = "${var.name}-endpoints"
  description = "Interface endpoints for ${var.name}"
  vpc_id      = aws_vpc.this.id

  tags = { Name = "${var.name}-endpoints" }
}

resource "aws_vpc_security_group_ingress_rule" "endpoints_from_task" {
  security_group_id            = aws_security_group.endpoints.id
  description                  = "HTTPS from the task"
  ip_protocol                  = "tcp"
  from_port                    = 443
  to_port                      = 443
  referenced_security_group_id = aws_security_group.task.id
}
