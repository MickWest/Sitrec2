# ECS cluster, task definition and service. One task, on Fargate, in the
# private subnets, with no public address. The environment is the whole site
# configuration: the hardened defaults below, with the operator's values from
# var.task_environment merged over them.

locals {
  default_environment = {
    AUTH_MODE            = "cert"
    AUTH_CERT_SOURCE     = "header"
    AUTH_TRUSTED_PROXIES = join(",", aws_subnet.public[*].cidr_block)
    AUTH_TRUST_STORE     = "/etc/sitrec/trust/ca-bundle.pem"
    AUTH_USER_MAP        = "/etc/sitrec/trust/users.json"

    SAVE_TO_S3              = "true"
    S3_BUCKET               = aws_s3_bucket.this["data"].id
    S3_REGION               = local.region
    S3_CREDENTIAL_SOURCE    = "role"
    S3_USE_FIPS             = var.fips ? "true" : "false"
    S3_DEFAULT_VISIBILITY   = "private"
    S3_READS_VIA_SERVER     = "true"
    USE_S3_PRESIGNED_URLS   = "false"
    SETTINGS_SERVER_ENABLED = "true"

    CHATBOT_ENABLED                         = "false"
    SITREC_TRACK_STATS                      = "false"
    LOG_UI_INTERACTIONS                     = "false"
    SITREC_ENABLE_DEFAULT_MAP_SOURCES       = "false"
    SITREC_ENABLE_DEFAULT_ELEVATION_SOURCES = "false"
    SITREC_ENABLE_DEFAULT_TLE_SOURCES       = "false"
    LOCAL_DOCS                              = "true"
  }

  environment = merge(local.default_environment, var.task_environment)

  container_environment = [
    for key in sort(keys(local.environment)) : {
      name  = key
      value = local.environment[key]
    }
  ]

  container_definitions = [
    {
      name      = var.name
      image     = local.image
      essential = true
      user      = "1000"

      portMappings = [
        {
          containerPort = 8080
          protocol      = "tcp"
        }
      ]

      readonlyRootFilesystem = false

      linuxParameters = {
        initProcessEnabled = true
      }

      environment = local.container_environment

      logConfiguration = {
        logDriver = "awslogs"
        options = {
          "awslogs-group"         = aws_cloudwatch_log_group.app.name
          "awslogs-region"        = local.region
          "awslogs-stream-prefix" = var.name
        }
      }
    }
  ]
}

resource "aws_ecs_cluster" "this" {
  name = var.name
}

resource "aws_ecs_task_definition" "this" {
  family                   = var.name
  network_mode             = "awsvpc"
  requires_compatibilities = ["FARGATE"]
  cpu                      = tostring(var.task_cpu)
  memory                   = tostring(var.task_memory)
  execution_role_arn       = aws_iam_role.execution.arn
  task_role_arn            = aws_iam_role.task.arn

  runtime_platform {
    operating_system_family = "LINUX"
    cpu_architecture        = "X86_64"
  }

  container_definitions = jsonencode(local.container_definitions)
}

resource "aws_ecs_service" "this" {
  name            = var.name
  cluster         = aws_ecs_cluster.this.id
  task_definition = aws_ecs_task_definition.this.arn
  desired_count   = 1
  launch_type     = "FARGATE"

  enable_execute_command = var.enable_exec
  propagate_tags         = "SERVICE"

  deployment_controller {
    type = "ECS"
  }

  deployment_minimum_healthy_percent = 100
  deployment_maximum_percent         = 200

  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }

  health_check_grace_period_seconds = 60

  network_configuration {
    subnets          = aws_subnet.private[*].id
    security_groups  = [aws_security_group.task.id]
    assign_public_ip = false
  }

  load_balancer {
    target_group_arn = aws_lb_target_group.task.arn
    container_name   = var.name
    container_port   = 8080
  }

  depends_on = [
    aws_lb_listener.https,
    aws_iam_role_policy.task,
    aws_iam_role_policy_attachment.execution_managed,
    aws_iam_role_policy.execution_registry_key,
  ]
}
