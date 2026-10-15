import json
from collections.abc import Iterator
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

import pytest
from sqlalchemy import text
from sqlalchemy.orm import Session

from app.models import Meeting, Participant, User
from app.reports.lambda_handler import detect_trigger, payloads
from app.reports.weekly import Week, build_weekly_report, previous_week, report_key
from tests.conftest import TestingSession, engine

KYIV = ZoneInfo("Europe/Kyiv")


@pytest.fixture
def db() -> Iterator[Session]:
    with TestingSession() as session:
        yield session
    with engine.begin() as conn:
        conn.execute(text("TRUNCATE meeting_participants, meetings, participants, users"))


def add_meeting(db: Session, owner: User, title: str, start: datetime, hours: float, people=()) -> None:
    db.add(
        Meeting(
            title=title,
            owner_id=owner.id,
            starts_at=start,
            ends_at=start + timedelta(hours=hours),
            participants=list(people),
        )
    )


def sections(csv_bytes: bytes) -> list[list[str]]:
    return [line.split(",") for line in csv_bytes.decode().splitlines()]


def test_week_parsing_and_keys():
    assert str(Week.parse("2026-W40")) == "2026-W40"
    assert Week.parse("2026-W01").previous == Week(2025, 52)
    assert report_key("2026-W40") == "reports/2026-W40.csv"
    for bad in ("2026-40", "last week", "2026-W54", "2025-W53"):
        with pytest.raises(ValueError):
            Week.parse(bad)


def test_previous_week_uses_report_time_zone():
    # Monday 2026-10-05 00:30 in Kyiv is still Sunday in UTC; the previous week is W40 either way.
    assert previous_week(datetime(2026, 10, 5, 0, 30, tzinfo=KYIV)) == "2026-W40"
    assert previous_week(datetime(2026, 10, 4, 23, 30, tzinfo=KYIV)) == "2026-W39"


def test_report_totals_top_meetings_and_organisers(db: Session):
    anna = User(cognito_sub="a", email="anna@example.com")
    oleh = User(cognito_sub="o", email="oleh@example.com")
    p1, p2 = Participant(name="P1", email="p1@example.com"), Participant(name="P2", email="p2@example.com")
    db.add_all([anna, oleh, p1, p2])
    db.flush()
    # 2026-W40 is Mon 2026-09-28 .. Sun 2026-10-04.
    add_meeting(db, anna, "Planning", datetime(2026, 9, 28, 10, tzinfo=KYIV), 2, [p1, p2])
    add_meeting(db, anna, "Standup", datetime(2026, 9, 29, 9, tzinfo=KYIV), 0.25)
    add_meeting(db, oleh, "Review", datetime(2026, 10, 4, 23, tzinfo=KYIV), 1, [p1])
    add_meeting(db, oleh, "Next week", datetime(2026, 10, 5, 0, tzinfo=KYIV), 3)  # W41: excluded
    add_meeting(db, anna, "Old", datetime(2026, 9, 21, 12, tzinfo=KYIV), 1.5)  # W39
    db.commit()

    report = build_weekly_report("2026-W40", db)
    rows = sections(report)

    assert ["meetings", "3", "1", "+2"] in rows
    assert ["hours", "3.25", "1.50", "+1.75"] in rows
    top = rows[rows.index(["title", "start", "duration_hours", "participants"]) + 1 :][:3]
    assert top == [
        ["Planning", "2026-09-28T10:00+03:00", "2.00", "2"],
        ["Review", "2026-10-04T23:00+03:00", "1.00", "1"],
        ["Standup", "2026-09-29T09:00+03:00", "0.25", "0"],
    ]
    assert ["anna@example.com", "2", "2.25", "1", "1.50"] in rows
    assert ["oleh@example.com", "1", "1.00", "0", "0.00"] in rows
    # Same week, same data -> same bytes (the builder is safe to run twice).
    assert build_weekly_report("2026-W40", db) == report


def test_empty_week(db: Session):
    rows = sections(build_weekly_report("2026-W40", db))
    assert ["meetings", "0", "0", "+0"] in rows
    assert ["hours", "0.00", "0.00", "+0.00"] in rows


def test_handler_reads_both_event_shapes():
    direct = {"source": "schedule"}
    assert payloads(direct) == [direct]
    assert detect_trigger(direct, direct) == "schedule"

    body = {"week": "2026-W39", "source": "make"}
    sqs = {"Records": [{"eventSource": "aws:sqs", "body": json.dumps(body)}]}
    assert payloads(sqs) == [body]
    assert detect_trigger(sqs, body) == "sqs"

    scheduled = {"week": None, "source": "schedule"}
    sqs = {"Records": [{"eventSource": "aws:sqs", "body": json.dumps(scheduled)}]}
    assert detect_trigger(sqs, scheduled) == "schedule"
