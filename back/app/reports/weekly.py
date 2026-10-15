"""The weekly meetings report: one ISO week of meetings as a CSV file.

No AWS in here: the Lambda handler decides the week and stores the bytes. Run it locally against
the compose database with `python -m app.reports.weekly 2026-W40` (prints the CSV).
"""

import csv
import io
import re
import sys
from dataclasses import dataclass
from datetime import date, datetime, time, timedelta
from zoneinfo import ZoneInfo

from sqlalchemy import select
from sqlalchemy.orm import Session, selectinload

from app.config import settings
from app.db import SessionLocal
from app.models import Meeting, User

WEEK_PATTERN = re.compile(r"^(\d{4})-W(\d{2})$")
TOP_MEETINGS = 5


@dataclass(frozen=True)
class Week:
    year: int
    number: int

    @classmethod
    def parse(cls, week: str) -> "Week":
        """Parse "2026-W40" into Week(2026, 40); raises ValueError for anything else."""
        match = WEEK_PATTERN.match(week)
        if not match:
            raise ValueError(f"Not an ISO week like 2026-W40: {week!r}")
        year, number = int(match[1]), int(match[2])
        date.fromisocalendar(year, number, 1)  # rejects W00, W54 and W53 in 52-week years
        return cls(year, number)

    @classmethod
    def containing(cls, day: date) -> "Week":
        iso = day.isocalendar()
        return cls(iso.year, iso.week)

    def __str__(self) -> str:
        return f"{self.year}-W{self.number:02d}"

    @property
    def monday(self) -> date:
        return date.fromisocalendar(self.year, self.number, 1)

    @property
    def previous(self) -> "Week":
        return Week.containing(self.monday - timedelta(days=7))

    def bounds(self, tz: ZoneInfo) -> tuple[datetime, datetime]:
        """[Monday 00:00, next Monday 00:00) in the report's time zone."""
        start = datetime.combine(self.monday, time.min, tzinfo=tz)
        return start, datetime.combine(self.monday + timedelta(days=7), time.min, tzinfo=tz)


def previous_week(now: datetime | None = None) -> str:
    """The last complete ISO week in the report's time zone: what the Monday schedule reports on."""
    tz = ZoneInfo(settings.report_timezone)
    today = (now or datetime.now(tz)).astimezone(tz).date()
    return str(Week.containing(today).previous)


def report_key(week: str) -> str:
    """One file per week, so building a week twice overwrites the same object."""
    return f"reports/{Week.parse(week)}.csv"


def _hours(meeting: Meeting) -> float:
    return (meeting.ends_at - meeting.starts_at).total_seconds() / 3600


def _meetings_in(db: Session, week: Week, tz: ZoneInfo) -> list[Meeting]:
    start, end = week.bounds(tz)
    query = (
        select(Meeting)
        .options(selectinload(Meeting.participants))
        .where(Meeting.starts_at >= start, Meeting.starts_at < end)
        .order_by(Meeting.starts_at, Meeting.id)
    )
    return list(db.scalars(query))


def _fmt(value: float) -> str:
    return f"{value:.2f}"


def build_weekly_report(week: str, db: Session | None = None) -> bytes:
    """Query the meetings of one ISO week (e.g. "2026-W40") and return the CSV."""
    if db is None:
        with SessionLocal() as session:
            return build_weekly_report(week, session)

    tz = ZoneInfo(settings.report_timezone)
    this_week = Week.parse(week)
    last_week = this_week.previous
    current = _meetings_in(db, this_week, tz)
    previous = _meetings_in(db, last_week, tz)
    owners = {user.id: user for user in db.scalars(select(User))}

    out = io.StringIO()
    rows = csv.writer(out, lineterminator="\n")
    start, end = this_week.bounds(tz)
    rows.writerow(["Weekly meetings report", str(this_week)])
    rows.writerow(["Period", start.date().isoformat(), (end - timedelta(days=1)).date().isoformat()])
    rows.writerow(["Time zone", settings.report_timezone])
    rows.writerow([])

    rows.writerow(["Summary"])
    rows.writerow(["metric", str(this_week), str(last_week), "change"])
    count_now, count_before = len(current), len(previous)
    hours_now, hours_before = sum(map(_hours, current), 0.0), sum(map(_hours, previous), 0.0)
    rows.writerow(["meetings", count_now, count_before, f"{count_now - count_before:+d}"])
    rows.writerow(["hours", _fmt(hours_now), _fmt(hours_before), f"{hours_now - hours_before:+.2f}"])
    rows.writerow([])

    rows.writerow([f"Top {TOP_MEETINGS} longest meetings"])
    rows.writerow(["title", "start", "duration_hours", "participants"])
    longest = sorted(current, key=lambda m: (-_hours(m), m.starts_at, str(m.id)))[:TOP_MEETINGS]
    for meeting in longest:
        rows.writerow(
            [
                meeting.title,
                meeting.starts_at.astimezone(tz).isoformat(timespec="minutes"),
                _fmt(_hours(meeting)),
                len(meeting.participants),
            ]
        )
    rows.writerow([])

    # Per organiser: the meeting's owner (the account that created it).
    rows.writerow(["Per organiser"])
    rows.writerow(["organiser", "meetings", "hours", "meetings_prev", "hours_prev"])
    per_owner: dict[str, list[float]] = {}
    for index, meetings in enumerate((current, previous)):
        for meeting in meetings:
            owner = owners.get(meeting.owner_id) if meeting.owner_id else None
            name = owner.email if owner else "(no owner)"
            totals = per_owner.setdefault(name, [0, 0.0, 0, 0.0])
            totals[index * 2] += 1
            totals[index * 2 + 1] += _hours(meeting)
    for name, (count, hours, count_prev, hours_prev) in sorted(per_owner.items()):
        rows.writerow([name, count, _fmt(hours), count_prev, _fmt(hours_prev)])

    return out.getvalue().encode()


if __name__ == "__main__":
    week = sys.argv[1] if len(sys.argv) > 1 else previous_week()
    sys.stdout.write(build_weekly_report(week).decode())
