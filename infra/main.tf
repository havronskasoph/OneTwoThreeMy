# What Terraform reads but does not manage: the account, and the outputs of the stacks that are
# still CloudFormation (network, Aurora and the API in backend.yaml; S3 + CloudFront in frontend.yaml).

data "aws_caller_identity" "current" {}

data "aws_region" "current" {}

data "aws_cloudformation_stack" "backend" {
  name = "${var.project_name}-backend"
}

data "aws_cloudformation_stack" "frontend" {
  name = "${var.project_name}-frontend"
}

# The database password, for the report builder's environment. It ends up in the Lambda
# configuration and in the Terraform state, both readable only with AWS or workspace access.
data "aws_secretsmanager_secret_version" "db" {
  secret_id = local.backend["DbSecretArn"]
}

locals {
  account_id = data.aws_caller_identity.current.account_id
  region     = data.aws_region.current.region
  backend    = data.aws_cloudformation_stack.backend.outputs

  # The backend image and its architecture; the report builder and the parser run it with
  # another command. A new image reaches them on the next run after `make aws-backend-deploy`.
  image_uri    = local.backend["ImageUri"]
  architecture = local.backend["Architecture"]

  # Every browser origin of the app: local development plus the site's (CloudFront, custom domain).
  site_origins = split(",", data.aws_cloudformation_stack.frontend.outputs["SiteOrigins"])
  origins      = concat(var.local_origins, local.site_origins)

  lambda_assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "lambda.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })
}
