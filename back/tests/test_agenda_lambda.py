import json
from datetime import date

import anthropic
import httpx2
import pytest

from app.ai import agenda_lambda
from app.ai.agenda import AgendaItem, AgendaParseError, ParsedAgenda, cost_usd
from tests.test_auth import bearer, cognito, token  # noqa: F401  (cognito: autouse fixture)

PARSED = ParsedAgenda(
    title="Синк по прайсингу",
    duration_minutes=45,
    items=[AgendaItem(topic="Нові тарифи Pro", owner="Олена", minutes=15)],
    language="uk",
)


def event(body: dict | str, headers: dict | None = None) -> dict:
    return {
        "headers": {"content-type": "application/json", **(headers or {})},
        "body": body if isinstance(body, str) else json.dumps(body),
        "isBase64Encoded": False,
    }


def request(**overrides) -> dict:
    return {"text": "Пн 10:00, синк по прайсингу", "today": "2026-10-29", "tz": "Europe/Kyiv", **overrides}


def auth_headers() -> dict:
    return {k.lower(): v for k, v in bearer(token()).items()}


@pytest.fixture
def parsed(monkeypatch: pytest.MonkeyPatch) -> list:
    calls = []

    def fake_parse(text: str, today: date, tz: str):
        calls.append((text, today, tz))
        return PARSED, {"input_tokens": 1500, "output_tokens": 300}

    monkeypatch.setattr(agenda_lambda, "parse_agenda", fake_parse)
    return calls


def test_requires_a_token(parsed):
    assert agenda_lambda.handler(event(request()), None)["statusCode"] == 401
    junk = {"authorization": "Bearer junk"}
    assert agenda_lambda.handler(event(request(), junk), None)["statusCode"] == 401
    assert parsed == []


def test_parses_and_logs_cost(parsed, caplog: pytest.LogCaptureFixture):
    caplog.set_level("INFO", logger="agenda-parser")
    response = agenda_lambda.handler(event(request(), auth_headers()), None)

    assert response["statusCode"] == 200, response
    body = json.loads(response["body"])
    assert body["agenda"]["items"][0]["owner"] == "Олена"
    assert body["prompt_version"] == "agenda-v1"
    assert parsed == [("Пн 10:00, синк по прайсингу", date(2026, 10, 29), "Europe/Kyiv")]

    line = json.loads(next(r.getMessage() for r in caplog.records if "agenda_parsed" in r.getMessage()))
    assert line["user"] == "sub-anna"
    assert line["input_tokens"] == 1500 and line["output_tokens"] == 300
    assert line["cost_usd"] == cost_usd(line["model"], {"input_tokens": 1500, "output_tokens": 300})
    assert "latency_ms" in line


def test_rejects_long_text_before_calling_the_model(parsed):
    response = agenda_lambda.handler(event(request(text="x" * 10_001), auth_headers()), None)
    assert response["statusCode"] == 413
    assert parsed == []


def test_rejects_bad_body(parsed):
    for body in ("not json", request(today="yesterday"), request(tz="Mars/Base"), {"text": "x"}):
        assert agenda_lambda.handler(event(body, auth_headers()), None)["statusCode"] == 400, body


def test_no_agenda_is_422(monkeypatch: pytest.MonkeyPatch):
    def no_agenda(*_):
        raise AgendaParseError("no agenda found in the text")

    monkeypatch.setattr(agenda_lambda, "parse_agenda", no_agenda)
    response = agenda_lambda.handler(event(request(), auth_headers()), None)
    assert response["statusCode"] == 422
    assert json.loads(response["body"])["error"] == "no_agenda"


def test_throttling_is_429(monkeypatch: pytest.MonkeyPatch):
    def throttled(*_):
        req = httpx2.Request("POST", "https://bedrock-mantle.us-east-1.api.aws/v1/messages")
        raise anthropic.RateLimitError("throttled", response=httpx2.Response(429, request=req), body=None)

    monkeypatch.setattr(agenda_lambda, "parse_agenda", throttled)
    assert agenda_lambda.handler(event(request(), auth_headers()), None)["statusCode"] == 429


def test_cost():
    usage = {"input_tokens": 5500, "output_tokens": 300}
    assert cost_usd("anthropic.claude-opus-5-5", usage) == pytest.approx(0.028)
    assert cost_usd("anthropic.claude-haiku-5-5", usage) == pytest.approx(0.0007)
    assert cost_usd("unknown", usage) is None
