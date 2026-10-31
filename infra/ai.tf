# Paste an agenda. The agenda-parser Lambda (backend image, outside the VPC) takes pasted text on a
# public, Cognito-authenticated function URL, asks Claude on Amazon Bedrock for a structured agenda
# and returns it as a suggestion. It never touches the database: the user saves through the normal
# API. Plus a monthly AWS Budgets alarm. Was infra/ai.yml (Lab 6); see docs/ai-agenda.md.

resource "aws_cloudwatch_log_group" "parser" {
  name              = "/aws/lambda/${var.project_name}-agenda-parser"
  retention_in_days = var.log_retention_days
}

# Logs and Bedrock inference only: no database, no S3, no VPC.
resource "aws_iam_role" "parser" {
  name               = "${var.project_name}-ai-ParserRole-Sd0FNoJhsaGH"
  assume_role_policy = local.lambda_assume_role_policy
}

resource "aws_iam_role_policy_attachment" "parser_logs" {
  role       = aws_iam_role.parser.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

resource "aws_iam_role_policy" "parser" {
  name = "call-claude"
  role = aws_iam_role.parser.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      # "*" for now: narrowing it to the one model is a discussion question (docs/ai-agenda.md).
      Effect   = "Allow"
      Action   = "bedrock-mantle:CreateInference"
      Resource = "*"
    }]
  })
}

resource "aws_lambda_function" "parser" {
  function_name = "${var.project_name}-agenda-parser"
  package_type  = "Image"
  image_uri     = local.image_uri
  image_config {
    command = ["app.ai.agenda_lambda.handler"]
  }
  architectures = [local.architecture]
  memory_size   = 512
  # A parse takes 2-8 s; one retry after invalid output can double that.
  timeout = 30
  role    = aws_iam_role.parser.arn

  logging_config {
    log_group  = aws_cloudwatch_log_group.parser.name
    log_format = "JSON"
  }

  environment {
    variables = {
      PARSER_MODEL         = var.parser_model
      PARSER_MAX_CHARS     = tostring(var.parser_max_chars)
      BEDROCK_REGION       = local.region
      COGNITO_REGION       = local.region
      COGNITO_USER_POOL_ID = aws_cognito_user_pool.main.id
      COGNITO_CLIENT_ID    = aws_cognito_user_pool_client.web.id
    }
  }
}

# Public URL; the handler itself rejects requests without a valid Cognito ID token (401).
resource "aws_lambda_function_url" "parser" {
  function_name      = aws_lambda_function.parser.function_name
  authorization_type = "NONE"

  cors {
    allow_origins = local.origins
    allow_methods = ["POST"]
    allow_headers = ["authorization", "content-type"]
    max_age       = 3600
  }
}

# A public function URL needs both permissions.
resource "aws_lambda_permission" "parser_url" {
  statement_id           = "${var.project_name}-ai-ParserFunctionUrlPermission-y5scipNv9Evr"
  function_name          = aws_lambda_function.parser.function_name
  action                 = "lambda:InvokeFunctionUrl"
  principal              = "*"
  function_url_auth_type = "NONE"
}

resource "aws_lambda_permission" "parser_invoke" {
  statement_id             = "${var.project_name}-ai-ParserFunctionInvokePermission-U72GObmfmMxh"
  function_name            = aws_lambda_function.parser.function_name
  action                   = "lambda:InvokeFunction"
  principal                = "*"
  invoked_via_function_url = true
}

# An email when the month's actual (or forecast) cost passes the limit.
resource "aws_budgets_budget" "monthly" {
  name         = "${var.project_name}-monthly"
  budget_type  = "COST"
  time_unit    = "MONTHLY"
  limit_amount = format("%.1f", var.budget_limit_usd)
  limit_unit   = "USD"

  dynamic "notification" {
    for_each = ["ACTUAL", "FORECASTED"]
    content {
      notification_type          = notification.value
      comparison_operator        = "GREATER_THAN"
      threshold                  = 100
      threshold_type             = "PERCENTAGE"
      subscriber_email_addresses = [var.budget_email]
    }
  }
}
