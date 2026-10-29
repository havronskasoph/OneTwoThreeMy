from fastapi.testclient import TestClient

from tests.test_api import meeting_payload

AGENDA = {
    "items": [
        {"topic": "Нові тарифи Pro", "owner": "Олена", "minutes": 15},
        {"topic": "Фідбек від клієнтів", "owner": "Taras", "minutes": None},
    ],
    "action_items": [{"task": "Порівняння з конкурентами", "owner": "Taras", "due": "2026-10-30"}],
}


def create_meeting(client: TestClient) -> dict:
    response = client.post("/api/meetings", json=meeting_payload())
    assert response.status_code == 201, response.text
    return response.json()


def test_new_meeting_has_no_agenda(client: TestClient):
    assert create_meeting(client)["agenda"] is None


def test_save_agenda_with_ai_suggestion(client: TestClient):
    meeting = create_meeting(client)
    suggestion = {
        "agenda": {**AGENDA, "language": "uk"},
        "model": "anthropic.claude-opus-5-5",
        "prompt_version": "agenda-v1",
    }

    response = client.put(
        f"/api/meetings/{meeting['id']}/agenda", json={"agenda": AGENDA, "ai_suggestion": suggestion}
    )
    assert response.status_code == 200, response.text
    assert response.json()["agenda"] == AGENDA
    assert client.get(f"/api/meetings/{meeting['id']}").json()["agenda"] == AGENDA


def test_typed_agenda_needs_no_suggestion(client: TestClient):
    meeting = create_meeting(client)
    agenda = {"items": [{"topic": "  Retro  ", "owner": ""}]}

    response = client.put(f"/api/meetings/{meeting['id']}/agenda", json={"agenda": agenda})
    assert response.status_code == 200, response.text
    assert response.json()["agenda"] == {
        "items": [{"topic": "Retro", "owner": None, "minutes": None}],
        "action_items": [],
    }


def test_agenda_is_validated(client: TestClient):
    meeting = create_meeting(client)
    url = f"/api/meetings/{meeting['id']}/agenda"
    assert client.put(url, json={"agenda": {"items": []}}).status_code == 422
    assert client.put(url, json={"agenda": {"items": [{"topic": ""}]}}).status_code == 422
    assert client.put(url, json={"agenda": {"items": [{"topic": "A", "minutes": 0}]}}).status_code == 422


def test_agenda_of_unknown_meeting_returns_404(client: TestClient):
    url = "/api/meetings/00000000-0000-0000-0000-000000000000/agenda"
    assert client.put(url, json={"agenda": AGENDA}).status_code == 404
