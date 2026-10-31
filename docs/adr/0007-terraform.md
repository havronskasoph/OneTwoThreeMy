# ADR 0007: Manage Cognito, the weekly report and the agenda parser with Terraform in HCP Terraform

- Status: accepted
- Date: 2026-10-31

## Context

Labs 4–6 added three CloudFormation stacks: `meetings-cognito` (user pool, Google provider, client,
domain), `meetings-reports` (SQS, Scheduler, two Lambdas, S3, SES, alarm) and `meetings-ai` (agenda
parser, function URL, budget). They worked, but:

- They were deployed **from a laptop** with `make aws-*-stack` and long-lived keys in `.env`. Nothing
  recorded who applied what, and nothing stopped two people applying at once.
- Parameters such as callback URLs, CORS origins, the image URI and emails were assembled in the
  Makefile, so the template alone did not say what was deployed.
- The project already depends on things outside AWS (the Google OAuth client, the GitHub
  repository) that CloudFormation cannot describe, and it will need a second environment.

The resources hold data that must not be lost: the user pool has the accounts that signed up, and
the reports bucket has every report built so far. The repository is public.

## Decision

- **Terraform** describes these three parts in `infra/*.tf` (one root module: `auth.tf`,
  `reports.tf`, `ai.tf`, plus `main.tf`, `variables.tf`, `outputs.tf`). The network, Aurora, the API
  and the site stay CloudFormation (`backend.yaml`, `frontend.yaml`, `backend-ecr.yaml`); Terraform
  reads their outputs through `data "aws_cloudformation_stack"`.
- **The existing resources were adopted, not re-created**: `DeletionPolicy: Retain` on every
  resource, the stacks deleted, then 41 `import` blocks. The import plan had 0 to add and 0 to
  destroy; it was applied once and `imports.tf` was deleted. Details: [../terraform.md](../terraform.md).
- **State and runs live in HCP Terraform**, workspace `meetings-dev`, in remote execution mode,
  connected to the GitHub repository with `infra` as the working directory. A pull request gets a
  plan as a check; a merge to `main` applies it.
- **No AWS keys in HCP Terraform.** Runs use dynamic provider credentials: HCP signs an OIDC token per
  run, AWS exchanges it for a short-lived session of the role `hcp-terraform-<org>`, whose trust allows
  only runs of the `meetings-dev` workspace. The OIDC provider and the role are in `infra/bootstrap/`,
  applied once from a laptop with a local state.
- **Who can change the infrastructure:** anyone who can get a pull request merged into `main`. People
  and agents (Claude Code) propose changes as pull requests; a person reviews the plan; HCP Terraform
  applies. The Makefile has `infra-plan` but no `apply`. A laptop apply is for emergencies only.
- **Secrets:** `google_client_secret` is a sensitive Terraform variable in the workspace. Personal
  values (`report_recipients`, `budget_email`) are workspace variables too, to keep them out of the
  public repository. `terraform.tfvars` holds only non-secret values.

## Alternatives considered

| Alternative | Why it lost |
| --- | --- |
| Keep CloudFormation | AWS keeps the state and rolls back failed changes, which is a real advantage. But it stops at the AWS account: the Google OAuth client, the GitHub repository and branch protection, or DNS at another provider cannot be in the same plan. Its parameters were assembled in the Makefile, and every deploy came from a laptop. |
| AWS CDK | Generates CloudFormation, so it has the same one-cloud limit, plus a build step and a language runtime for the infrastructure. It suits teams that want loops and classes in TypeScript; HCL's `for_each` and modules are enough here. |
| OpenTofu | The open-source fork accepts the same files and commands, and its MPL licence avoids the BSL question. It lost only on the course's tooling: HCP Terraform runs Terraform, and the lab and its dynamic credentials are written for it. Switching later is a binary swap and a state backend move, not a rewrite. |
| Re-create instead of import | Deleting the stacks without `Retain` and applying fresh would have deleted every account in the user pool and every report. |

## Consequences

- One `terraform plan` shows the difference between the files and the real resources (drift),
  every time. A change made in the console is reported and reverted on the next apply unless it is
  written back into the code first.
- **We now keep the state.** It is in HCP Terraform, locked during runs and versioned. It contains every
  attribute of every resource, including secrets: the Google client secret, the database password in
  the report builder's environment, and the emails. Anyone with read access to the workspace state can
  see them, so workspace access is limited to the team, and the state is never downloaded into the repository.
- **Failed applies do not roll back.** A run that fails halfway leaves the resources it managed to
  change; the state records them. The fix is a new commit and a new run, not an undo.
- **Two roads to AWS.** The Makefile (and later GitHub Actions) deploys the application image and the
  CloudFormation stacks; HCP Terraform deploys `infra/*.tf`. The parser and the report builder run the
  image named in the backend stack's output, so a new image reaches them on the next Terraform run
  after `make aws-backend-deploy`. When a change needs both (a new environment variable that new code
  reads), the infrastructure goes first and must be backward compatible: old code ignores the new
  variable, then the code that uses it is deployed.
- **If HCP Terraform is down,** nothing that runs stops: Cognito, the API, the reports and the parser
  do not depend on it. Only infrastructure changes wait. In an emergency, a team member can switch
  the workspace to local execution and apply from a laptop with their own AWS credentials, against
  the same remote state once it is back, or from a downloaded copy of the latest state version.
- The IAM role names generated by CloudFormation (`meetings-reports-BuilderRole-FpRVjqbe1dGA`, …) are
  kept, because renaming a role replaces it. They can be renamed later in a planned change.
