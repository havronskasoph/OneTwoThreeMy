# Weekly meetings report. EventBridge Scheduler (and `make report-now`) put a message on SQS; the
# report-builder Lambda (backend image, in the VPC) reads Aurora and writes reports/<week>.csv to S3
# through a gateway endpoint; the upload triggers the report-mailer Lambda (outside the VPC), which
# emails the file through SES. Was infra/reports.yaml (Lab 5); see docs/weekly-report.md.
#
# The IAM role names are the ones CloudFormation generated. They are kept as they are, because a
# new name would mean a new role rather than an imported one.

locals {
  reports_bucket = "${var.project_name}-reports-${local.account_id}"
  report_sender  = var.sender_domain != "" ? "reports@${var.sender_domain}" : var.report_recipients[0]
}

# =====================================================================
# Storage: the reports bucket and the free S3 gateway endpoint for the VPC (which has no NAT)
# =====================================================================

resource "aws_vpc_endpoint" "s3" {
  vpc_endpoint_type = "Gateway"
  vpc_id            = local.backend["VpcId"]
  service_name      = "com.amazonaws.${local.region}.s3"
  route_table_ids   = [local.backend["PrivateRouteTableId"]]
}

resource "aws_s3_bucket" "reports" {
  bucket = local.reports_bucket

  lifecycle {
    # Holds every report built so far.
    prevent_destroy = true
  }
}

resource "aws_s3_bucket_public_access_block" "reports" {
  bucket                  = aws_s3_bucket.reports.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_ownership_controls" "reports" {
  bucket = aws_s3_bucket.reports.id
  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "reports" {
  bucket = aws_s3_bucket.reports.id
  rule {
    id     = "expire-reports"
    status = "Enabled"
    filter {
      prefix = "reports/"
    }
    expiration {
      days = 90
    }
  }
}

# Event: a new report file. The builder does not know who listens; today it is the mailer.
# In CloudFormation this was part of the bucket, which needed the bucket's name spelled out to
# avoid a dependency cycle; here the bucket, the permission and the notification are three resources.
resource "aws_s3_bucket_notification" "reports" {
  bucket = aws_s3_bucket.reports.id

  lambda_function {
    lambda_function_arn = aws_lambda_function.mailer.arn
    events              = ["s3:ObjectCreated:*"]
    filter_prefix       = "reports/"
    filter_suffix       = ".csv"
  }

  depends_on = [aws_lambda_permission.mailer_s3]
}

# =====================================================================
# Queue: commands to build a report, with a dead-letter queue after 3 failed attempts
# =====================================================================

resource "aws_sqs_queue" "report_requests_dlq" {
  name                      = "${var.project_name}-report-requests-dlq"
  message_retention_seconds = 1209600 # 14 days, the maximum
  max_message_size          = 1048576 # 1 MiB, the AWS default since 2025 (the provider's is 256 KiB)
  sqs_managed_sse_enabled   = true
}

resource "aws_sqs_queue" "report_requests" {
  name = "${var.project_name}-report-requests"
  # 6 x the builder's 120 s timeout: a message must not reappear while an attempt still runs.
  visibility_timeout_seconds = 720
  max_message_size           = 1048576
  sqs_managed_sse_enabled    = true
  redrive_policy = jsonencode({
    deadLetterTargetArn = aws_sqs_queue.report_requests_dlq.arn
    maxReceiveCount     = 3
  })
}

# Someone has to find out about a failed report: any message in the DLQ emails the first recipient
# (SNS sends a subscription confirmation first).
resource "aws_sns_topic" "report_alarms" {
  name = "${var.project_name}-report-alarms"
}

resource "aws_sns_topic_subscription" "report_alarms_email" {
  topic_arn = aws_sns_topic.report_alarms.arn
  protocol  = "email"
  endpoint  = var.report_recipients[0]
}

resource "aws_cloudwatch_metric_alarm" "dlq_not_empty" {
  alarm_name          = "${var.project_name}-report-requests-dlq-not-empty"
  alarm_description   = "A report request failed 3 times and waits in the dead-letter queue."
  namespace           = "AWS/SQS"
  metric_name         = "ApproximateNumberOfMessagesVisible"
  dimensions          = { QueueName = aws_sqs_queue.report_requests_dlq.name }
  statistic           = "Maximum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 0
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.report_alarms.arn]
  ok_actions          = [aws_sns_topic.report_alarms.arn]
}

# =====================================================================
# Report builder: the backend image, in the VPC (reaches Aurora, and S3 via the endpoint)
# =====================================================================

resource "aws_cloudwatch_log_group" "builder" {
  name              = "/aws/lambda/${var.project_name}-report-builder"
  retention_in_days = var.log_retention_days
}

resource "aws_iam_role" "builder" {
  name               = "${var.project_name}-reports-BuilderRole-FpRVjqbe1dGA"
  assume_role_policy = local.lambda_assume_role_policy
}

resource "aws_iam_role_policy_attachment" "builder_vpc" {
  role       = aws_iam_role.builder.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaVPCAccessExecutionRole"
}

resource "aws_iam_role_policy" "builder" {
  name = "build-reports"
  role = aws_iam_role.builder.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect   = "Allow"
        Action   = "s3:PutObject"
        Resource = "${aws_s3_bucket.reports.arn}/reports/*"
      },
      # Used by the Lambda service, which polls the queue on the function's behalf.
      {
        Effect   = "Allow"
        Action   = ["sqs:ReceiveMessage", "sqs:DeleteMessage", "sqs:GetQueueAttributes"]
        Resource = aws_sqs_queue.report_requests.arn
      },
    ]
  })
}

resource "aws_lambda_function" "builder" {
  function_name = "${var.project_name}-report-builder"
  package_type  = "Image"
  image_uri     = local.image_uri
  image_config {
    command = ["app.reports.lambda_handler.handler"]
  }
  architectures = [local.architecture]
  memory_size   = 512
  # Aurora may need ~15 s to resume from 0 ACU.
  timeout = 120
  role    = aws_iam_role.builder.arn

  logging_config {
    log_group  = aws_cloudwatch_log_group.builder.name
    log_format = "JSON"
  }

  vpc_config {
    subnet_ids         = split(",", local.backend["PrivateSubnetIds"])
    security_group_ids = [local.backend["BackendSecurityGroupId"]]
  }

  environment {
    variables = {
      DB_HOST          = local.backend["DbEndpoint"]
      DB_PORT          = local.backend["DbPort"]
      DB_NAME          = local.backend["DbName"]
      DB_USER          = local.backend["DbUsername"]
      DB_PASSWORD      = jsondecode(data.aws_secretsmanager_secret_version.db.secret_string)["password"]
      DB_NULL_POOL     = "true"
      REPORTS_BUCKET   = aws_s3_bucket.reports.id
      REPORT_TIMEZONE  = var.schedule_timezone
      REPORT_FAIL_WEEK = var.report_fail_week
    }
  }

  depends_on = [aws_iam_role_policy_attachment.builder_vpc]
}

# One message per invocation; at most 2 builders at once, the rest wait in the queue.
resource "aws_lambda_event_source_mapping" "builder" {
  event_source_arn = aws_sqs_queue.report_requests.arn
  function_name    = aws_lambda_function.builder.arn
  batch_size       = 1
  scaling_config {
    maximum_concurrency = 2
  }

  depends_on = [aws_iam_role_policy.builder]
}

# =====================================================================
# Schedule: every Monday 07:00 Kyiv time, a "build last week's report" command on the queue
# =====================================================================

resource "aws_iam_role" "scheduler" {
  name = "${var.project_name}-reports-SchedulerRole-7X7o9Jlk3Glb"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "scheduler.amazonaws.com" }
      Action    = "sts:AssumeRole"
      Condition = { StringEquals = { "aws:SourceAccount" = local.account_id } }
    }]
  })
}

resource "aws_iam_role_policy" "scheduler" {
  name = "send-report-requests"
  role = aws_iam_role.scheduler.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = "sqs:SendMessage"
      Resource = aws_sqs_queue.report_requests.arn
    }]
  })
}

resource "aws_scheduler_schedule" "weekly" {
  name                = "${var.project_name}-weekly-report"
  description         = "Build last week's meetings report"
  schedule_expression = var.schedule_expression
  # Without it the cron runs in UTC, an hour off whenever daylight saving time changes.
  schedule_expression_timezone = var.schedule_timezone
  state                        = "ENABLED"

  flexible_time_window {
    mode = "OFF"
  }

  target {
    arn      = aws_sqs_queue.report_requests.arn
    role_arn = aws_iam_role.scheduler.arn
    input    = "{\"week\": null, \"source\": \"schedule\"}"
  }
}

# =====================================================================
# Report mailer: outside the VPC (internet access for SES), never touches the database
# =====================================================================

resource "aws_cloudwatch_log_group" "mailer" {
  name              = "/aws/lambda/${var.project_name}-report-mailer"
  retention_in_days = var.log_retention_days
}

# Read-only on reports/: a function triggered by uploads there must never upload there.
resource "aws_iam_role" "mailer" {
  name               = "${var.project_name}-reports-MailerRole-42e7Z9lX8djI"
  assume_role_policy = local.lambda_assume_role_policy
}

resource "aws_iam_role_policy_attachment" "mailer_logs" {
  role       = aws_iam_role.mailer.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

resource "aws_iam_role_policy" "mailer" {
  name = "mail-reports"
  role = aws_iam_role.mailer.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect   = "Allow"
        Action   = "s3:GetObject"
        Resource = "${aws_s3_bucket.reports.arn}/reports/*"
      },
      {
        Effect   = "Allow"
        Action   = ["ses:SendEmail", "ses:SendRawEmail"]
        Resource = "arn:aws:ses:${local.region}:${local.account_id}:identity/*"
      },
    ]
  })
}

# The code was inline in the CloudFormation template; now it is a file next to the templates.
data "archive_file" "mailer" {
  type        = "zip"
  source_file = "${path.module}/lambda/report_mailer/index.py"
  output_path = "${path.module}/.build/report_mailer.zip"
  # The zip records file permissions: 0664 on a laptop, 0644 in HCP Terraform's checkout. Fixing
  # them keeps the hash, and the plan, the same wherever it runs.
  output_file_mode = "0644"
}

resource "aws_lambda_function" "mailer" {
  function_name    = "${var.project_name}-report-mailer"
  runtime          = "python3.13"
  architectures    = ["arm64"]
  handler          = "index.handler"
  filename         = data.archive_file.mailer.output_path
  source_code_hash = data.archive_file.mailer.output_base64sha256
  memory_size      = 256
  timeout          = 30
  role             = aws_iam_role.mailer.arn

  logging_config {
    log_group  = aws_cloudwatch_log_group.mailer.name
    log_format = "JSON"
  }

  environment {
    variables = {
      REPORT_SENDER     = local.report_sender
      REPORT_RECIPIENTS = join(",", var.report_recipients)
    }
  }
}

resource "aws_lambda_permission" "mailer_s3" {
  statement_id   = "${var.project_name}-reports-MailerInvokePermission-7dQcekH4vHQ2"
  function_name  = aws_lambda_function.mailer.function_name
  action         = "lambda:InvokeFunction"
  principal      = "s3.amazonaws.com"
  source_arn     = aws_s3_bucket.reports.arn
  source_account = local.account_id
}

# =====================================================================
# SES: the inbox the report goes to (sandbox: recipients must be verified) and, optionally,
# the sender domain with Easy DKIM
# =====================================================================

resource "aws_sesv2_email_identity" "recipient" {
  email_identity = var.report_recipients[0]
}

resource "aws_sesv2_email_identity" "domain" {
  count          = var.sender_domain != "" ? 1 : 0
  email_identity = var.sender_domain
}
