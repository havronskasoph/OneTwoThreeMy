variable "project_name" {
  type        = string
  description = "Name prefix of every resource, and the PROJECT_NAME tag."
  default     = "meetings"
}

variable "region" {
  type        = string
  description = "Everything is in us-east-1: CloudFront takes custom-domain certificates only from there."
  default     = "us-east-1"
}

variable "log_retention_days" {
  type    = number
  default = 7
}

# --- Cognito (auth.tf) ---

variable "google_client_id" {
  type        = string
  description = "OAuth client ID (Web application) from Google Cloud. Not a secret: browsers see it."
}

variable "google_client_secret" {
  type        = string
  description = "OAuth client secret from Google Cloud. Set in the HCP Terraform workspace, never in a file."
  sensitive   = true
}

variable "local_origins" {
  type        = list(string)
  description = "Browser origins for local development, allowed besides the site's (sign-in redirects, CORS)."
  default     = ["http://localhost:3000", "http://localhost:5173"]
}

# --- Weekly report (reports.tf) ---

variable "report_recipients" {
  type = list(string)
  # Not a secret, but personal: kept out of the public repository, set as a workspace variable.
  description = "Inboxes the report is emailed to; the first one becomes a verified SES identity. Set in the workspace."

  validation {
    condition     = length(var.report_recipients) > 0
    error_message = "At least one report recipient is needed."
  }
}

variable "sender_domain" {
  type        = string
  description = "Domain to send the report from as reports@<domain> (DKIM records needed). Empty = the first recipient."
  default     = ""
}

variable "schedule_expression" {
  type        = string
  description = "When the report is built. Use rate(5 minutes) briefly to test, then set it back."
  default     = "cron(0 7 ? * MON *)"
}

variable "schedule_timezone" {
  type        = string
  description = "Time zone of the schedule and of the report's weeks (Monday to Sunday)."
  default     = "Europe/Kyiv"
}

variable "report_fail_week" {
  type        = string
  description = "Lab exercise: the builder raises for this ISO week, so its message ends in the DLQ."
  default     = ""
}

# --- Agenda parser (ai.tf) ---

variable "parser_model" {
  type        = string
  description = "Bedrock model ID of the agenda parser."
  default     = "anthropic.claude-opus-5-5"

  validation {
    condition = contains([
      "anthropic.claude-opus-5-5",
      "anthropic.claude-sonnet-5-5",
      "anthropic.claude-haiku-5-5",
    ], var.parser_model)
    error_message = "parser_model must be one of the Claude models listed in Lab 6."
  }
}

variable "parser_max_chars" {
  type        = number
  description = "Longer pasted text is rejected with 413 before the model is called."
  default     = 10000
}

variable "budget_email" {
  type        = string
  description = "Where the monthly budget alarm is emailed. Set in the workspace (personal, not secret)."
}

variable "budget_limit_usd" {
  type        = number
  description = "Monthly cost of the whole account that triggers the budget alarm."
  default     = 5
}
