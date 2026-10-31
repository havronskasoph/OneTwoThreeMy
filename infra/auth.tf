# Cognito user pool (Essentials tier) with managed login: sign-up and sign-in with email and password
# (self sign-up, email verification) and with Google, a public app client for the SPA (authorization
# code + PKCE), and a prefix domain for the managed login pages. Was infra/cognito.yaml (Lab 4).

resource "aws_cognito_user_pool" "main" {
  name = "${var.project_name}-users"
  # Managed login needs Essentials; the first 10,000 monthly active users are free.
  user_pool_tier = "ESSENTIALS"

  # Users sign in with their email; Cognito sends a code to verify it on sign-up.
  username_attributes      = ["email"]
  auto_verified_attributes = ["email"]
  username_configuration {
    case_sensitive = false
  }

  admin_create_user_config {
    allow_admin_create_user_only = false
  }

  account_recovery_setting {
    recovery_mechanism {
      name     = "verified_email"
      priority = 1
    }
  }

  password_policy {
    minimum_length                   = 8
    require_lowercase                = true
    require_numbers                  = true
    require_uppercase                = false
    require_symbols                  = false
    temporary_password_validity_days = 7
  }

  # Cognito's own sender (about 50 emails a day), enough until SES is set up.
  email_configuration {
    email_sending_account = "COGNITO_DEFAULT"
  }

  # Changing the schema forces a new user pool, i.e. every account is lost. `name` is a standard
  # attribute and needs no block of its own.
  schema {
    name                = "email"
    attribute_data_type = "String"
    required            = true
    mutable             = true
    string_attribute_constraints {
      min_length = "0"
      max_length = "2048"
    }
  }

  lifecycle {
    # The pool holds every account that has signed up. Destroying it needs a deliberate code change.
    prevent_destroy = true
  }
}

# Managed login pages and OAuth endpoints at https://<prefix>.auth.<region>.amazoncognito.com.
# The prefix must be unique across AWS, hence the account ID.
resource "aws_cognito_user_pool_domain" "main" {
  domain                = "${var.project_name}-${local.account_id}"
  user_pool_id          = aws_cognito_user_pool.main.id
  managed_login_version = 2
}

resource "aws_cognito_identity_provider" "google" {
  user_pool_id  = aws_cognito_user_pool.main.id
  provider_name = "Google"
  provider_type = "Google"

  # Besides the three set here, Cognito fills in Google's endpoints; they are listed so that the
  # plan does not try to remove them.
  provider_details = {
    client_id                     = var.google_client_id
    client_secret                 = var.google_client_secret
    authorize_scopes              = "openid email profile"
    attributes_url                = "https://people.googleapis.com/v1/people/me?personFields="
    attributes_url_add_attributes = "true"
    authorize_url                 = "https://accounts.google.com/o/oauth2/v2/auth"
    oidc_issuer                   = "https://accounts.google.com"
    token_request_method          = "POST"
    token_url                     = "https://www.googleapis.com/oauth2/v4/token"
  }

  attribute_mapping = {
    email          = "email"
    email_verified = "email_verified"
    name           = "name"
    username       = "sub"
  }
}

# Public client (no secret): a browser cannot keep one, so the code flow is protected with PKCE.
# The backend only verifies the ID tokens it receives.
resource "aws_cognito_user_pool_client" "web" {
  name         = "${var.project_name}-web"
  user_pool_id = aws_cognito_user_pool.main.id
  # No generate_secret: it can only be set when a client is created (changing it replaces the
  # client), and a client without it has no secret.

  explicit_auth_flows           = ["ALLOW_USER_SRP_AUTH", "ALLOW_REFRESH_TOKEN_AUTH"]
  prevent_user_existence_errors = "ENABLED"
  enable_token_revocation       = true

  id_token_validity      = 60
  access_token_validity  = 60
  refresh_token_validity = 30
  token_validity_units {
    id_token      = "minutes"
    access_token  = "minutes"
    refresh_token = "days"
  }

  # The reference to the provider also orders the work: a client naming a provider that does not
  # exist yet fails to create.
  supported_identity_providers         = ["COGNITO", aws_cognito_identity_provider.google.provider_name]
  allowed_oauth_flows_user_pool_client = true
  allowed_oauth_flows                  = ["code"]
  allowed_oauth_scopes                 = ["openid", "email", "profile"]

  # Managed login may send users back to every origin of the app. These must match the
  # frontend's redirect_uri (front/src/lib/auth.ts) exactly.
  callback_urls = [for origin in local.origins : "${origin}/auth/callback"]
  logout_urls   = [for origin in local.origins : "${origin}/"]
}

# Without a style, a version 2 domain has no sign-in page to show; use Cognito's default look.
resource "aws_cognito_managed_login_branding" "web" {
  user_pool_id                = aws_cognito_user_pool.main.id
  client_id                   = aws_cognito_user_pool_client.web.id
  use_cognito_provided_values = true
}
