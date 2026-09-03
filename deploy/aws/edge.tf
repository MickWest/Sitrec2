# The edge: server certificate, trust store, balancer, target group and the
# HTTPS listener with mutual TLS in verify mode.

locals {
  managed_certificate = var.route53_zone_id != ""

  ssl_policy = var.ssl_policy != "" ? var.ssl_policy : (
    var.fips ? "ELBSecurityPolicy-TLS13-1-3-FIPS-2023-04" : "ELBSecurityPolicy-TLS13-1-3-2021-06"
  )

  certificate_arn = local.managed_certificate ? aws_acm_certificate_validation.managed[0].certificate_arn : var.certificate_arn
}

# ---------------------------------------------------------------------------
# Server certificate: ACM with DNS validation when a Route 53 zone is given
# ---------------------------------------------------------------------------

resource "aws_acm_certificate" "managed" {
  count = local.managed_certificate ? 1 : 0

  domain_name       = var.hostname
  validation_method = "DNS"

  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_route53_record" "validation" {
  for_each = local.managed_certificate ? {
    for dvo in aws_acm_certificate.managed[0].domain_validation_options : dvo.domain_name => {
      name   = dvo.resource_record_name
      type   = dvo.resource_record_type
      record = dvo.resource_record_value
    }
  } : {}

  zone_id         = var.route53_zone_id
  name            = each.value.name
  type            = each.value.type
  records         = [each.value.record]
  ttl             = 60
  allow_overwrite = true
}

resource "aws_acm_certificate_validation" "managed" {
  count = local.managed_certificate ? 1 : 0

  certificate_arn         = aws_acm_certificate.managed[0].arn
  validation_record_fqdns = [for record in aws_route53_record.validation : record.fqdn]
}

resource "aws_route53_record" "app" {
  count = local.managed_certificate ? 1 : 0

  zone_id = var.route53_zone_id
  name    = var.hostname
  type    = "A"

  alias {
    name                   = aws_lb.this.dns_name
    zone_id                = aws_lb.this.zone_id
    evaluate_target_health = false
  }
}

# ---------------------------------------------------------------------------
# Trust store: the CA bundle and, optionally, a revocation list
# ---------------------------------------------------------------------------

resource "aws_lb_trust_store" "clients" {
  name                                     = "${var.name}-clients"
  ca_certificates_bundle_s3_bucket         = aws_s3_object.ca_bundle.bucket
  ca_certificates_bundle_s3_key            = aws_s3_object.ca_bundle.key
  ca_certificates_bundle_s3_object_version = aws_s3_object.ca_bundle.version_id

  depends_on = [aws_s3_bucket_policy.truststore]
}

# One entry per CRL in the bundle (see the crl objects in storage.tf).
resource "aws_lb_trust_store_revocation" "crl" {
  count = length(local.crls)

  trust_store_arn               = aws_lb_trust_store.clients.arn
  revocations_s3_bucket         = aws_s3_object.crl[count.index].bucket
  revocations_s3_key            = aws_s3_object.crl[count.index].key
  revocations_s3_object_version = aws_s3_object.crl[count.index].version_id
}

# ---------------------------------------------------------------------------
# Balancer
# ---------------------------------------------------------------------------

resource "aws_lb" "this" {
  name               = var.name
  load_balancer_type = "application"
  internal           = false
  security_groups    = [aws_security_group.balancer.id]
  subnets            = aws_subnet.public[*].id

  drop_invalid_header_fields = true
  xff_header_processing_mode = "remove"

  access_logs {
    bucket  = aws_s3_bucket.this["logs"].id
    prefix  = "alb/access"
    enabled = true
  }

  connection_logs {
    bucket  = aws_s3_bucket.this["logs"].id
    prefix  = "alb/connection"
    enabled = true
  }

  # Enabling the logs is validated against the bucket policy at creation.
  depends_on = [aws_s3_bucket_policy.logs]
}

resource "aws_lb_target_group" "task" {
  name             = var.name
  vpc_id           = aws_vpc.this.id
  target_type      = "ip"
  protocol         = "HTTP"
  protocol_version = "HTTP1"
  port             = 8080

  deregistration_delay = 30

  health_check {
    enabled             = true
    protocol            = "HTTP"
    path                = "/"
    matcher             = "200"
    interval            = 30
    timeout             = 5
    healthy_threshold   = 2
    unhealthy_threshold = 3
  }
}

resource "aws_lb_listener" "https" {
  load_balancer_arn = aws_lb.this.arn
  port              = 443
  protocol          = "HTTPS"
  ssl_policy        = local.ssl_policy
  certificate_arn   = local.certificate_arn

  mutual_authentication {
    mode                             = "verify"
    trust_store_arn                  = aws_lb_trust_store.clients.arn
    advertise_trust_store_ca_names   = "on"
    ignore_client_certificate_expiry = false
  }

  # Response headers the application does not set itself.
  routing_http_response_strict_transport_security_header_value = "max-age=31536000; includeSubDomains"
  routing_http_response_x_frame_options_header_value           = "DENY"
  routing_http_response_x_content_type_options_header_value    = "nosniff"
  routing_http_response_content_security_policy_header_value   = var.csp

  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.task.arn
  }

  lifecycle {
    precondition {
      condition     = var.route53_zone_id != "" || var.certificate_arn != ""
      error_message = "Set route53_zone_id (ACM certificate validated by DNS) or certificate_arn (an existing certificate)."
    }
  }
}
