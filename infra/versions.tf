# Meetings App infrastructure managed by Terraform: Cognito (auth.tf), the weekly report (reports.tf)
# and the agenda parser (ai.tf). The network, database, API and site stay in CloudFormation
# (backend.yaml, frontend.yaml); Terraform reads their outputs in main.tf.
#
# State and runs live in HCP Terraform. Plans and applies run there with short-lived AWS credentials
# (dynamic provider credentials, see bootstrap/); nobody applies from a laptop. See docs/adr/0007-terraform.md.

terraform {
  required_version = ">= 1.10"

  cloud {
    organization = "ooad-havronskasoph"
    workspaces {
      name = "meetings-dev"
    }
  }

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.0"
    }
    archive = {
      source  = "hashicorp/archive"
      version = "~> 2.7"
    }
  }
}

provider "aws" {
  region = var.region

  # Every resource that accepts tags gets PROJECT_NAME, without repeating it.
  default_tags {
    tags = {
      PROJECT_NAME = var.project_name
      ManagedBy    = "terraform"
    }
  }
}
