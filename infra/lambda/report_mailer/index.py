"""Emails a new report: triggered by s3:ObjectCreated on reports/*.csv."""
import logging
import os
import urllib.parse
from email.message import EmailMessage

import boto3

log = logging.getLogger("report-mailer")
log.setLevel(logging.INFO)
s3 = boto3.client("s3")
ses = boto3.client("sesv2")


def handler(event, context):
    sender = os.environ["REPORT_SENDER"]
    recipients = [a.strip() for a in os.environ["REPORT_RECIPIENTS"].split(",") if a.strip()]
    for record in event["Records"]:
        bucket = record["s3"]["bucket"]["name"]
        key = urllib.parse.unquote_plus(record["s3"]["object"]["key"])
        log.info("report-mailer triggered by s3 %s for %s", record["eventName"], key,
                 extra={"trigger": "s3", "event": record["eventName"], "bucket": bucket, "key": key})
        data = s3.get_object(Bucket=bucket, Key=key)["Body"].read()
        filename = key.rsplit("/", 1)[-1]
        week = filename.removesuffix(".csv")

        msg = EmailMessage()
        msg["Subject"] = f"Weekly meetings report {week}"
        msg["From"] = sender
        msg["To"] = ", ".join(recipients)
        msg.set_content(f"Hi,\n\nThe meetings report for {week} is attached.\n")
        msg.add_attachment(data, maintype="text", subtype="csv", filename=filename)
        response = ses.send_email(
            FromEmailAddress=sender,
            Destination={"ToAddresses": recipients},
            Content={"Raw": {"Data": msg.as_bytes()}},
        )
        log.info("report %s emailed to %d recipient(s)", key, len(recipients),
                 extra={"key": key, "message_id": response["MessageId"]})
