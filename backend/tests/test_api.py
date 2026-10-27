import json

from fastapi.testclient import TestClient

from app.levels import secret_code
from app.main import app

client = TestClient(app)


def new_player():
    return client.post("/api/session", json={}).json()["player_id"]


def test_config_lists_mock_model_and_levels():
    cfg = client.get("/api/config").json()
    assert any(m["id"] == "mock" for m in cfg["models"])
    assert [lv["number"] for lv in cfg["levels"]] == [1, 2, 3, 4, 5]  # no level 0 without OpenRouter


def test_chat_streams_events():
    pid = new_player()
    with client.stream("POST", "/api/chat", json={"player_id": pid, "level": 1, "model": "mock", "message": "check the inbox"}) as r:
        events = [json.loads(line[6:]) for line in r.iter_lines() if line.startswith("data: ")]
    types = [e["type"] for e in events]
    assert types[0] == "model" and "tool_result" in types and types[-1] == "done"


def test_levels_unlock_only_after_correct_guess():
    pid = new_player()
    r = client.post("/api/chat", json={"player_id": pid, "level": 2, "model": "mock", "message": "hi"})
    assert r.status_code == 403
    assert client.post("/api/guess", json={"player_id": pid, "level": 1, "code": "nope"}).json()["correct"] is False
    ok = client.post("/api/guess", json={"player_id": pid, "level": 1, "code": secret_code(1).lower().replace("-", " ")}).json()
    assert ok["correct"] and ok["solved"] == [1]
    with client.stream("POST", "/api/chat", json={"player_id": pid, "level": 2, "model": "mock", "message": "hi"}) as r:
        assert r.status_code == 200


def test_rejects_long_messages_and_bad_ids():
    pid = new_player()
    assert client.post("/api/chat", json={"player_id": pid, "level": 1, "model": "mock", "message": "x" * 5000}).status_code == 400
    assert client.post("/api/chat", json={"player_id": "nope", "level": 1, "model": "mock", "message": "hi"}).status_code == 400


def test_planted_email_shows_up_in_inbox():
    pid = new_player()
    client.post("/api/plant", json={"player_id": pid, "kind": "email", "sender": "x@evil.test", "title": "Hello Ava", "body": "planted text"})
    with client.stream("POST", "/api/chat", json={"player_id": pid, "level": 1, "model": "mock", "message": "read the inbox"}) as r:
        body = "".join(r.iter_lines())
    assert "planted text" in body


def test_plant_tells_ava_about_new_mail():
    pid = new_player()
    with client.stream("POST", "/api/chat", json={"player_id": pid, "level": 1, "model": "mock", "message": "hi"}) as r:
        list(r.iter_lines())
    client.post("/api/plant", json={"player_id": pid, "kind": "email", "title": "x", "body": "y"})
    from app import store
    assert store._mem_sessions[pid].histories[1][-1]["role"] == "system"


def test_decoy_guess_is_wrong_but_captures_a_quest():
    from app.levels import RETIRED_CODE
    pid = new_player()
    r = client.post("/api/guess", json={"player_id": pid, "level": 1, "code": RETIRED_CODE}).json()
    assert r["correct"] is False and r["decoy"] is True and "got_played" in r["quests"]
