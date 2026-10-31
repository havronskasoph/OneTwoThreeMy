# Everything the Makefile and the frontend build read (`terraform -chdir=infra output -raw <name>`).
# The names match the old CloudFormation outputs, in snake_case.

# --- Cognito ---

output "user_pool_id" {
  value = aws_cognito_user_pool.main.id
}

output "user_pool_client_id" {
  value = aws_cognito_user_pool_client.web.id
}

output "issuer" {
  description = "Issuer (iss) of the pool's tokens; its JWKS is at <issuer>/.well-known/jwks.json."
  value       = "https://cognito-idp.${local.region}.amazonaws.com/${aws_cognito_user_pool.main.id}"
}

output "hosted_ui_domain" {
  description = "Domain of the managed login pages and OAuth endpoints."
  value       = "${aws_cognito_user_pool_domain.main.domain}.auth.${local.region}.amazoncognito.com"
}

output "google_redirect_uri" {
  description = "Authorised redirect URI for the Google OAuth client."
  value       = "https://${aws_cognito_user_pool_domain.main.domain}.auth.${local.region}.amazoncognito.com/oauth2/idpresponse"
}

# --- Weekly report ---

output "reports_bucket" {
  value = aws_s3_bucket.reports.id
}

output "report_queue_url" {
  value = aws_sqs_queue.report_requests.url
}

output "report_queue_arn" {
  value = aws_sqs_queue.report_requests.arn
}

output "report_dlq_url" {
  value = aws_sqs_queue.report_requests_dlq.url
}

output "report_dlq_arn" {
  value = aws_sqs_queue.report_requests_dlq.arn
}

output "report_builder_function" {
  value = aws_lambda_function.builder.function_name
}

output "report_mailer_function" {
  value = aws_lambda_function.mailer.function_name
}

output "report_schedule" {
  value = aws_scheduler_schedule.weekly.name
}

output "report_dkim_records" {
  description = "CNAME records to add at the DNS provider of sender_domain (only when it is set)."
  value = [
    for token in try(aws_sesv2_email_identity.domain[0].dkim_signing_attributes[0].tokens, []) :
    "${token}._domainkey.${var.sender_domain} CNAME ${token}.dkim.amazonses.com"
  ]
}

# --- Agenda parser ---

output "parser_url" {
  description = "Function URL the frontend posts pasted text to (VITE_PARSER_URL)."
  value       = aws_lambda_function_url.parser.function_url
}

output "parser_function" {
  value = aws_lambda_function.parser.function_name
}

output "parser_log_group" {
  value = aws_cloudwatch_log_group.parser.name
}

output "parser_model" {
  value = var.parser_model
}
