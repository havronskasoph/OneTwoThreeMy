# Weekly meetings report (event-driven, on AWS)

Every Monday at 07:00 (Europe/Kyiv) the system builds last week's meetings report as a CSV file,
saves it to S3 and emails it through SES. Nobody clicks anything.

```
EventBridge Scheduler ─┐  command {"week": null, "source": "schedule"}
make report-now ───────┴─> SQS report-requests ──(3 failures)──> report-requests-dlq ──> alarm email
                                │
                                ▼
                     report-builder Lambda (backend image, in the VPC)
                       reads Aurora, writes reports/<week>.csv
                                │  via the S3 gateway endpoint (free; the VPC has no NAT)
                                ▼
                     S3 bucket  ── event: ObjectCreated reports/*.csv
                                │
                                ▼
                     report-mailer Lambda (outside the VPC) ──> SES ──> your inbox
```

| Piece | Where |
|---|---|
| The report itself (no AWS) | [back/app/reports/weekly.py](../back/app/reports/weekly.py) |
| Builder handler (schedule / SQS / direct) | [back/app/reports/lambda_handler.py](../back/app/reports/lambda_handler.py) |
| Mailer handler (S3 event) | [infra/lambda/report_mailer/index.py](../infra/lambda/report_mailer/index.py) |
| Everything on AWS | [infra/reports.tf](../infra/reports.tf) (Terraform, workspace `meetings-dev` in HCP Terraform) |
| Tests | [back/tests/test_reports.py](../back/tests/test_reports.py) |

The report has: number of meetings and total hours for the week, the same for the week before and
the change, the five longest meetings (title, start, duration, participants), and totals per organiser
(the meeting's owner).

Two rules: the **week is a parameter** (`2026-W40`; the handler picks the previous week only when
none is given), and **one week = one file** (`reports/2026-W40.csv`), so building it twice
overwrites the same object.

## Run it

```bash
# 0. Local check against the compose database
make start
make report-local WEEK=2026-W40

# 1. The inbox to send to: the report_recipients variable of the HCP Terraform workspace
#    (SES emails it a verification link; click it)

# 2. Deploy: the backend first (new image with app/reports, route table, outputs), then a run of
#    infra/ in HCP Terraform (push or merge a change to infra/, or start a run in the workspace)
make aws-backend-deploy
#    -> click "verify" in the SES email and "Confirm subscription" in the SNS alarm email

# 3. On demand (trigger: SQS, then S3)
make report-now WEEK=2026-W41
make report-ls            # aws s3 ls s3://meetings-reports-<account>/reports/ --recursive
make report-logs

# 4. The schedule (trigger: schedule): set the workspace variable schedule_expression to
#    rate(5 minutes) and start a run; wait for one report, then delete the variable and run again
make report-triggers      # the three "triggered" lines: schedule, sqs, s3

# 5. Break it: the builder raises for one week -> 3 attempts -> DLQ (and the alarm emails you)
#    workspace variable report_fail_week = 2026-W30, then a run in HCP Terraform
make report-now WEEK=2026-W30
make report-queues        # after a few minutes (visibility timeout is 12 min per attempt): DLQ waiting=1
#    "fix the code": delete report_fail_week, run again
make report-redrive       # or SQS console > report-requests-dlq > Start DLQ redrive
```

Each attempt waits for the 720 s visibility timeout, so the message reaches the DLQ about 25–40 minutes
after the first failure.

## Answers (Part 3, Step 7)

**Same week sent twice: how many emails?** Two. The builder is idempotent: it writes the same key,
so there is still one file. But every `PutObject` is a new `ObjectCreated` event, even when the
content is the same, so the mailer runs twice and sends twice. Writing a file is idempotent; sending
an email is not.

**1. Where to store "this report was already sent", and with which key?**
In a small DynamoDB table (free at this volume; the mailer is outside the VPC, so not in Aurora).
Before sending, the mailer does a conditional `PutItem` with
`ConditionExpression: attribute_not_exists(pk)`. If the item already exists, it skips the email.
The key is `pk = "<bucket>/<object key>#<ETag>"`, for example `reports/2026-W40.csv#9b2cf5…`. The
ETag is the content hash. The same report delivered twice has the same key and is sent once. A
report rebuilt with different data (a meeting was edited) has a new ETag and is sent again, which
is what we want. Set a TTL of about 90 days, the same as the files. A free alternative: a conditional
write (`If-None-Match: *`) of a marker object `sent/2026-W40-<etag>` in S3. It must **not** go under
`reports/`, or it would trigger the mailer.

**2. The builder can't reach SES: three fixes and their cost (us-east-1)**

| Option | Monthly cost | Notes |
|---|---|---|
| NAT gateway | ~$33 per AZ ($0.045/h) + $0.045/GB; ~$66 for 2 AZs | Gives the whole VPC internet access; the most expensive |
| SES interface VPC endpoint | ~$7.30 per AZ ($0.01/h) + $0.01/GB; ~$15 for 2 AZs | Private path to SES only (the SES endpoint is SMTP, so the builder would also need SMTP credentials) |
| The split we built (mailer outside the VPC, S3 event) | ~$0 (Lambda, S3 events, gateway endpoint all free at this volume) | Two functions instead of one, connected by an event |

With ten more emails a week: the split. It costs nothing, and NAT or an endpoint would cost more
per month than years of SES. With a million emails a week: still the split. SES itself is now the
bill (~$100 per million, ~$430/month), and the network option adds little to that. At that scale I
would let the builder put one SQS message per recipient batch and let many mailers send in parallel
within the SES rate limit. A NAT only makes sense if the VPC needs the internet for other things too.

**3. A link that works for a week**
A presigned URL is only valid while the credentials that signed it are valid. The Lambda role's
credentials expire after a few hours. Options:
- **Best: link to our own app**, e.g. `https://<site>/reports/2026-W40`. When someone clicks, the API
  checks the Cognito login and redirects to a fresh presigned URL that lives 5 minutes. The link in
  the email never expires, it can be revoked, and only logged-in people can open the report.
- CloudFront in front of the bucket (Origin Access Control) with **CloudFront signed URLs**. They are
  signed with a key pair that we own, so the expiry can be 7 days or any other value, and it does
  not depend on IAM sessions.
- Sign with long-term IAM user keys (SigV4 allows up to 7 days). This works, but means storing a
  long-lived access key, which is the option to avoid.

## Answers for the class discussion (short)

- **Command vs. event:** in the cake shop the order slip is a command ("bake Napoleon, 8 portions")
  and "your order is ready" is an event. In the lab, `{"week": …, "source": "schedule"}` on SQS is
  the command (one addressee: the builder). `ObjectCreated reports/2026-W40.csv` is the event (the
  builder doesn't know the mailer exists).
- **202 + job id:** while the job runs, the user sees "Preparing your report…" with a status from
  `GET /jobs/<id>` (queued → running → done). On failure they should see a clear "the report could
  not be built, we've been notified, try again", not an endless spinner.
- **Idempotent steps:** building and writing `reports/<week>.csv` is idempotent (same key,
  overwritten). Sending the email is not. Neither is a "count of reports sent" or anything appended.
- **07:01 edit:** the report is correct for the data at 07:00: it is a snapshot. Eventual consistency
  means the report catches up only when it is rebuilt (`make report-now WEEK=…`). For "recomputed
  within 5 minutes of a calendar change", a weekly schedule is not enough: the change itself should
  be an event (meeting updated → message → recompute that week).
- **Slack notification:** change nothing in the builder. Add a second subscriber to the
  `ObjectCreated` event, e.g. S3 → EventBridge (or SNS fan-out) → a Slack Lambda. The builder only
  writes a file and doesn't know who listens.
- **Payments: Redis or RabbitMQ?** RabbitMQ (or SQS). It has acks and redelivery, durable queues on
  disk and dead-letter exchanges. With Redis, a popped message that the worker dies on is lost unless
  the library recovers it, and persistence is optional.
- **Renaming an RQ task:** queued jobs hold a pickled reference `recipes.bake`. After a rename,
  the workers can't import it and the jobs fail. Messages between services should be a stable,
  language-neutral format (JSON with an explicit type/version), not a pointer into your code.
- **Two Celery beats:** every schedule fires twice, so two reports and two emails. Beat must be a
  singleton. The AWS equivalent is EventBridge Scheduler, a managed service that fires each schedule
  once. There is no process of ours to accidentally run twice.
- **Why SQS instead of a direct invoke:** retries with a DLQ, backpressure under the concurrency
  limit, one entry point for schedule, Makefile and API. A direct invoke is better when the caller
  needs the answer right away (synchronous), e.g. the API's own request/response or `make
  aws-backend-migrate`.
- **Visibility timeout < function timeout:** the message becomes visible again while attempt 1 is
  still running. A second builder picks it up, so two runs do the same work, and the receive count
  grows. A slow but successful job can even be moved to the DLQ, and attempt 1's delete fails
  because its receipt handle is stale.
- **DLQ on Sunday night:** the CloudWatch alarm `meetings-report-requests-dlq-not-empty`
  (`ApproximateNumberOfMessagesVisible > 0` on the DLQ, 5 min) emails through SNS. It is in the
  template. Monday morning someone reads the builder logs, fixes the cause and redrives.
- **Aurora wake-up cost:** each run resumes Aurora to 0.5 ACU for about 5–6 minutes (until the 300 s
  auto-pause) ≈ 0.05 ACU-h × $0.12 ≈ $0.006, i.e. about $0.03/month for a weekly report. Every five
  minutes, the database never reaches 300 s idle, so it never pauses: 0.5 ACU × 730 h × $0.12 ≈
  **$44/month**.
- **When does it cost money?** Scheduler (14M invocations free), SQS (1M requests free), Lambda (1M
  requests + 400k GB-s free) and S3 events are free here. The first real costs are Aurora waking up
  (cents) and then SES at $0.10 per 1000 emails. SES is the first part to grow with users: a million
  emails a month is about $100.
