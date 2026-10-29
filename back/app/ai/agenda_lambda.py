"""Agenda parser Lambda: POST {"text", "today", "tz"} to its function URL, get a suggested agenda back.

Runs from the backend image with a different command (infra/ai.yml), outside the VPC: it needs
Bedrock and Cognito's JWKS, never the database. Every call costs money, so it accepts only a valid
Cognito ID token (401 otherwise) and rejects long text (413) before the model is called. CORS is
answered by the function URL itself, so no CORS headers are added here.

Errors: 400 bad request body, 401 no or invalid token, 413 text too long, 422 no agenda in the text,
429 Bedrock throttling, 503 Bedrock unavailable. Each successful parse logs one JSON line
"agenda_parsed" with the model, prompt version, tokens, latency and cost.
"""

import base64
import json
import logging
import time
from datetime import date
from typing import Any
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

import anthropic
from fastapi import HTTPException

from app.ai.agenda import PROMPT_VERSION, AgendaParseError, cost_usd, parse_agenda
from app.auth import LOCAL_IDENTITY, Identity, verify_id_token
from app.config import settings

log = logging.getLogger("agenda-parser")
log.setLevel(logging.INFO)


def response(status: int, body: dict[str, Any]) -> dict[str, Any]:
    return {"statusCode": status, "headers": {"content-type": "application/json"}, "body": json.dumps(body)}


def error(status: int, code: str, message: str) -> dict[str, Any]:
    return response(status, {"error": code, "detail": message})


def verify_cognito_token(authorization: str) -> Identity:
    """The caller's identity from `Authorization: Bearer <Cognito ID token>`; raises HTTPException (401)."""
    if not settings.auth_enabled:
        return LOCAL_IDENTITY
    scheme, _, token = authorization.partition(" ")
    if scheme.lower() != "bearer" or not token:
        raise HTTPException(401, "Sign in required")
    return verify_id_token(token)


def read_body(event: dict[str, Any]) -> tuple[str, date, str]:
    raw = event.get("body") or ""
    if event.get("isBase64Encoded"):
        raw = base64.b64decode(raw).decode()
    body = json.loads(raw)
    text, tz = body["text"], body["tz"]
    if not isinstance(text, str) or not text.strip():
        raise ValueError("text must be a non-empty string")
    ZoneInfo(tz)
    return text, date.fromisoformat(body["today"]), tz


def handler(event: dict[str, Any], context: Any) -> dict[str, Any]:
    headers = {k.lower(): v for k, v in (event.get("headers") or {}).items()}
    try:
        user = verify_cognito_token(headers.get("authorization", ""))
    except HTTPException as e:
        return error(401, "unauthorized", str(e.detail))

    try:
        text, today, tz = read_body(event)
    except (ValueError, KeyError, TypeError, ZoneInfoNotFoundError) as e:
        return error(400, "bad_request", f"Expected JSON with text, today (YYYY-MM-DD) and tz: {e}")
    if len(text) > settings.parser_max_chars:
        return error(
            413, "too_long", f"The text is {len(text)} characters; the limit is {settings.parser_max_chars}"
        )

    started = time.monotonic()
    try:
        agenda, usage = parse_agenda(text, today, tz)
    except AgendaParseError as e:
        return error(422, "no_agenda", str(e))
    except anthropic.RateLimitError:
        log.warning(json.dumps({"event": "agenda_throttled", "user": user.sub}))
        return error(429, "busy", "The AI service is busy, try again in a minute")
    except (anthropic.APIStatusError, anthropic.APIConnectionError) as e:
        log.exception(json.dumps({"event": "agenda_failed", "user": user.sub}))
        return error(503, "unavailable", f"The AI service is unavailable: {type(e).__name__}")

    log.info(
        json.dumps(
            {
                "event": "agenda_parsed",
                "user": user.sub,
                "model": settings.parser_model,
                "prompt_version": PROMPT_VERSION,
                **usage,
                "latency_ms": int((time.monotonic() - started) * 1000),
                "cost_usd": cost_usd(settings.parser_model, usage),
                "text_chars": len(text),
                "items": len(agenda.items),
            }
        )
    )
    return response(
        200,
        {
            "agenda": agenda.model_dump(mode="json"),
            "model": settings.parser_model,
            "prompt_version": PROMPT_VERSION,
        },
    )
