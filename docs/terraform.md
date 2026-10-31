# Infrastructure with Terraform (Lab 7)

Cognito, the weekly report and the agenda parser are Terraform in [infra/](../infra/), with state and
runs in HCP Terraform. The decision and its trade-offs: [adr/0007-terraform.md](adr/0007-terraform.md).

| File | What | Was |
|---|---|---|
| [versions.tf](../infra/versions.tf) | `cloud` block (HCP Terraform), providers, `default_tags` | – |
| [main.tf](../infra/main.tf) | Reads the CloudFormation stacks `meetings-backend` and `meetings-frontend`, the DB secret | `make` passing stack outputs as parameters |
| [auth.tf](../infra/auth.tf) | Cognito: pool, domain, Google provider, client, managed login branding | `infra/cognito.yaml` (Lab 4) |
| [reports.tf](../infra/reports.tf) | SQS + DLQ, Scheduler, builder and mailer Lambdas, S3 bucket + notification, SES, alarm | `infra/reports.yaml` (Lab 5) |
| [ai.tf](../infra/ai.tf) | Agenda parser Lambda, function URL, IAM, $5 budget | `infra/ai.yml` (Lab 6) |
| [variables.tf](../infra/variables.tf), [terraform.tfvars](../infra/terraform.tfvars), [outputs.tf](../infra/outputs.tf) | Inputs (non-secret values in Git), outputs the Makefile reads | stack parameters / outputs |
| [bootstrap/](../infra/bootstrap/main.tf) | IAM OIDC provider for app.terraform.io + the role HCP runs assume | – |
| [lambda/report_mailer/](../infra/lambda/report_mailer/index.py) | The mailer's code, zipped by `archive_file` | inline `ZipFile` in the template |

## How a change reaches AWS

```
edit infra/*.tf ─> pull request ─> HCP Terraform: speculative plan as a check ─> review the plan
                                                                                   │ merge
                                                                                   ▼
                            HCP Terraform run ─> OIDC token ─> role hcp-terraform-<org> ─> AWS APIs
```

Nobody applies from a laptop. Locally: `make infra-init` (once, after `terraform login`),
`make infra-plan`, `make infra-outputs`, `make infra-fmt`, `make infra-validate`.

## Setting it up (once)

1. HCP Terraform: create the organization (here `ooad-havronskasoph`, named in `infra/versions.tf`);
   `terraform login` on the laptop.
2. Bootstrap the AWS trust with your own credentials (local state, gitignored):
   ```bash
   terraform -chdir=infra/bootstrap init
   terraform -chdir=infra/bootstrap apply -var tfc_organization=<org>
   ```
3. Workspace `meetings-dev`, **Remote** execution, working directory `infra`. Variables:

   | Key | Category | Value |
   |---|---|---|
   | `TFC_AWS_PROVIDER_AUTH` | env | `true` |
   | `TFC_AWS_RUN_ROLE_ARN` | env | the bootstrap `role_arn` output |
   | `google_client_secret` | terraform, **sensitive** | from Google Cloud |
   | `report_recipients` | terraform, HCL | `["you@example.com"]` |
   | `budget_email` | terraform | `you@example.com` |

4. Settings → Version Control: the GitHub repository, working directory `infra`, auto-apply on
   merges to `main`, speculative plans on pull requests.

## The migration (Part 2, Step 3)

1. `DeletionPolicy: Retain` and `UpdateReplacePolicy: Retain` on all 30 resources of the three
   templates; the stacks deployed once more and checked (`get-template`: 30 of 30 retained).
2. The stacks deleted. Checked afterwards: the user pool still had its 5 users, the bucket its 5
   reports, both Lambdas were active.
3. `imports.tf` with **41** `import` blocks: the 30 CloudFormation resources, plus 11 that are
   properties in CloudFormation but resources in Terraform (bucket public access block, ownership
   controls, lifecycle, notification; the SNS e-mail subscription; 3 managed policy attachments and
   4 inline role policies). `terraform plan -generate-config-out` wrote a first draft to compare with.
4. Planned until nothing was left but imports and harmless updates. What the plans found and how the
   HCL was fixed (never the resource):

   | Plan said | Cause | Fix |
   |---|---|---|
   | `aws_cognito_user_pool_client.web` **must be replaced** (`generate_secret` forces replacement), and with it the managed login branding | The imported client has no `generate_secret` in state; setting it, even to `false`, means "a new client" | Removed the argument; a client without it has no secret anyway |
   | Both SQS queues `max_message_size 1048576 -> 262144` | AWS's default is now 1 MiB, the provider's is 256 KiB | Set `1048576` explicitly |
   | SES identity, SNS endpoint, budget, mailer env updated | The emails were declared `sensitive`, and a change of sensitivity shows as an update | Emails are personal, not secret: plain workspace variables, kept out of Git |

5. The final import plan: `41 to import, 0 to add, 4 to change, 0 to destroy`. The 4 updates in place
   were checked to be harmless before applying:
   - `aws_cognito_identity_provider.google` and `aws_lambda_function.builder`: only the sensitivity
     of `client_secret` and `DB_PASSWORD`; the values were compared with the live ones and are equal;
   - `aws_lambda_function.mailer`: the code is now a zip built by Terraform; the deployed `index.py`
     was downloaded and is byte-for-byte the same file;
   - `aws_sns_topic_subscription.report_alarms_email`: provider defaults written to state.
6. Applied once (`Apply complete! Resources: 41 imported, 0 added, 4 changed, 0 destroyed.`), then
   `terraform plan` → **No changes**. `imports.tf` and the three templates were deleted.

**After the switch to GitHub-driven runs.** The first run from a merge (PR #1) planned
`1 to change`: `aws_lambda_function.mailer`. `archive_file` stores file permissions in the zip, and
`index.py` is 0664 on the laptop but 0644 in HCP Terraform's checkout, so the hash differed. Applying
it uploaded the same code again; `output_file_mode = "0644"` now makes the zip identical everywhere.
PR #2 (the `ManagedBy = terraform` tag, `0 to add, 20 to change, 0 to destroy`) was the first change
applied only by HCP Terraform after a merge.

**Re-created:** none. Everything was imported, including the Lambda permissions and the bucket
notification (their CloudFormation-generated statement IDs are kept in the code).

## Step 5: drift

How to run it: change the parser's timeout in the Lambda console (30 → 45 s), then *New run → Plan
only* in the workspace. Expected: the plan shows `~ timeout = 45 -> 30` on
`aws_lambda_function.parser`; an apply puts it back. (Result of the run: _to fill in_.)

If that had been a real 23:00 fix, the next apply would silently undo it. The fix must become code:
the same person opens a pull request with `timeout = 45` (or, in an emergency, makes the change with
Terraform itself, from a branch, and merges it in the morning). The fix then lives in Git with a
reason, in every environment, and the next plan says *No changes*.

## Step 7: think it through

**Imported vs re-created.** 41 imported, 0 re-created. Re-creating the child resources
(`aws_lambda_permission`, `aws_s3_bucket_notification`) would also have been safe: they hold no data, and
a few seconds without the S3 → mailer trigger would at worst delay one report email.

**What forces replacement.** On the user pool: `username_attributes`, `alias_attributes` or a change
to an existing `schema` block force a new pool. A new pool has a
new ID and **no users**: every account is gone, everyone has to sign up again, and tokens issued by
the old pool stop verifying. On the bucket: `bucket` (its name). A new bucket starts empty, and the old
one cannot be deleted while it holds reports, so the apply fails (or, with `force_destroy`, the reports
are deleted). Both resources have `lifecycle { prevent_destroy = true }`, so such a plan fails
instead of being applied.

**Where the Google client secret is now.** (1) The workspace variable in HCP Terraform (write-only in
the UI); (2) the Terraform state in HCP, in plain text, in every state version; (3) Cognito itself,
which returns it to anyone allowed `cognito-idp:DescribeIdentityProvider`; (4) `.env` on the laptop;
(5) Google Cloud. Plans show `(sensitive value)`. Leak paths: anyone with state read access in the
organization, any IAM principal with Cognito describe rights, and anyone with the laptop. It is never
in Git or in the frontend.

**Two applies at once with remote state.** HCP Terraform runs one run at a time per workspace and
locks the state, so the second one queues (or, from the CLI, waits for the lock). With a local
`terraform.tfstate` in Git, both apply against their own copy: both create or change resources, the
second push conflicts or overwrites the first state, and resources end up untracked or duplicated.

**A narrower bootstrap role.** Trust only one workspace:
`"app.terraform.io:sub" = "organization:<org>:project:meetings:workspace:meetings-dev:run_phase:*"` (this
is what `infra/bootstrap/` uses, with `project:*`), and separate roles for `run_phase:plan` (read-only)
and `run_phase:apply`. Permissions the workspace actually needs, instead of `AdministratorAccess`:
`AmazonCognitoPowerUser`, `AWSLambda_FullAccess`, `AmazonSQSFullAccess`, plus scoped IAM actions
(`iam:CreateRole`, `iam:PutRolePolicy`, `iam:AttachRolePolicy`, `iam:PassRole` on `meetings-*` roles),
S3 on `meetings-reports-*`, `scheduler:*`, `ses:*Identity*`, `budgets:*`, `cloudwatch:*Alarm*`, `logs:*`,
`ec2:*VpcEndpoint*`, and read-only `cloudformation:DescribeStacks` and `secretsmanager:GetSecretValue`
on the DB secret.

**Claude Code and "add a staging environment".** It should produce a pull request: the root module
turned into a module (or a second workspace `meetings-stage` with its own variables), names that
include the environment, a `stage.tfvars`, a matching bootstrap trust for the new workspace, and the
plan in the description. It must not, on its own: run `terraform apply`, create the workspace or its
secrets, widen IAM roles, run `state rm`/`import`, or touch the dev workspace's state.

## Discussion questions

**Artur's hand-made Lambda.** (1) Import it: write the HCL and an `import` block, so it is reviewed,
tagged and in every environment; (2) delete it, after checking logs and metrics that nothing calls it;
(3) leave it and document it as unmanaged. Choose (1) if it is used, (2) if not; (3) only temporarily.

**The 23:00 security group fix.** The next apply reverts it, reopening the hole. The process: the
console change is followed by a pull request with the same change that same night (or the fix is
made through Terraform in the first place); drift is checked by scheduled plan-only runs, so it is
noticed the next morning.

**State: kept for you vs kept by you.** CloudFormation: nothing to lose or protect, and automatic
rollback. Terraform: one state can cover several providers and accounts, every plan detects drift,
and you can move, import and refactor resources freely.

**State file deleted.** Lost: the mapping from addresses in the code to real IDs, so Terraform would
try to create everything again (failing on names, or duplicating). Not lost: the resources themselves,
the code, and in HCP the earlier state versions. Recovery: restore the previous state version in HCP
Terraform; without one, import every resource again (as in this migration).

**Why not state in Git.** It contains secrets in plain text (here the Google secret and the DB
password) that would be in the history forever, even in a private repository; and Git has no
locking, so two people apply against two copies, and merging two state files by hand is guesswork.

**Harmless diff, dangerous plan.** Renaming `resource "aws_s3_bucket" "reports"` to `"report"` in a
refactor, or changing the user pool's `schema` "only" to add a description: the HCL diff is one line,
but the plan shows `-/+` on the bucket or the pool. Another: changing `project_name` in tfvars renames
every resource, and the plan replaces almost everything.

**Emergency tools.** `-target`: a broken resource blocks the whole plan during an incident (say, an
expired provider API for one service), and you must apply only the security fix to another resource
now. `terraform state rm`: a resource must be handed over to another workspace or deliberately
abandoned (keep the user pool but stop managing it) without destroying it.

**Agent writes, human reviews, HCP applies.** Automate more: the agent can also run the plan, attach it,
fix `fmt`/`validate` failures, and policy checks (OPA/Sentinel) can block forbidden changes. Never
automate: the human approval of a plan that destroys or replaces stateful resources, and changes to
IAM/trust and to the pipeline itself.

**White-label prod · rozetka.** Same: the module (`auth`, `reports`, `ai` as one module), the review and
apply workflow. New: a workspace `meetings-prod-rozetka` with its own state, its own AWS account (a
bootstrap role there), and a `rozetka.tfvars` with `brand`, domain, logo bucket, emails. Names get a
prefix per tenant; the CloudFormation parts would need to move into the module as well.

**A run fails halfway.** The world: some of the ten resources exist. The state: records exactly those
that were created (Terraform saves state as it goes). The code: unchanged, still describing all ten.
Next: read the error, fix the code or the cause (a quota, a permission), and run again; Terraform
creates only the missing ones. Do not delete the half-created ones by hand.
