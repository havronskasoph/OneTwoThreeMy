"""Report builder Lambda: builds one week's CSV and stores it at s3://$REPORTS_BUCKET/reports/<week>.csv.

Runs from the backend image with a different command (infra/reports.tf). It accepts two event shapes:
- an SQS event from the report-requests queue (the schedule and `make report-now` send there),
  each record's body being {"week": "2026-W40" | null, "source": "schedule" | "make" | ...};
- a direct invocation with that same payload as the event (`aws lambda invoke`, or a schedule
  that targets the function itself).
A missing or null week means the previous ISO week. Raising makes SQS redeliver the message; after
three receives it moves to the dead-letter queue.
"""

import json
import logging
from typing import Any

from app.config import settings
from app.reports.weekly import build_weekly_report, previous_week, report_key

log = logging.getLogger("report-builder")
log.setLevel(logging.INFO)


def detect_trigger(event: dict[str, Any], payload: dict[str, Any]) -> str:
    """What started this run: "schedule", "sqs" (any other queue message) or "direct"."""
    if payload.get("source") == "schedule":
        return "schedule"
    records = event.get("Records") or [{}]
    if records[0].get("eventSource") == "aws:sqs":
        return "sqs"
    return "direct"


def payloads(event: dict[str, Any]) -> list[dict[str, Any]]:
    if "Records" in event:
        return [json.loads(record["body"] or "{}") for record in event["Records"]]
    return [event]


def build_and_store(week: str) -> str:
    import boto3  # in the Lambda runtime; not needed to build reports locally

    if week == settings.report_fail_week:
        raise RuntimeError(f"Simulated failure for {week} (REPORT_FAIL_WEEK)")
    key = report_key(week)
    body = build_weekly_report(week)
    boto3.client("s3").put_object(
        Bucket=settings.reports_bucket, Key=key, Body=body, ContentType="text/csv; charset=utf-8"
    )
    return key


def handler(event: dict[str, Any], context: Any) -> dict[str, Any]:
    keys = []
    for payload in payloads(event):
        week = payload.get("week") or previous_week()
        trigger = detect_trigger(event, payload)
        log.info(
            "report-builder triggered by %s for %s",
            trigger,
            week,
            extra={"trigger": trigger, "week": week, "source": payload.get("source")},
        )
        key = build_and_store(week)
        log.info("report stored at s3://%s/%s", settings.reports_bucket, key, extra={"key": key})
        keys.append(key)
    return {"keys": keys}
