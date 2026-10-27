"""State: visitor sessions, rate limits, the daily budget, and logging.

The backend is stateless so it can run on serverless hosting: every request
loads the visitor's session from Supabase and saves it back. Without Supabase
settings (local dev and tests) the same functions use process memory.
"""

import time
import uuid
from collections import defaultdict
from dataclasses import dataclass, field
from datetime import datetime, timezone

import httpx

from .config import settings
from .tools import ToolContext


@dataclass
class Session:
    player_id: str
    nickname: str = ""
    histories: dict[int, list[dict]] = field(default_factory=dict)
    tool_ctx: ToolContext = field(default_factory=ToolContext)
    solved: set[int] = field(default_factory=set)
    messages_per_level: dict[int, int] = field(default_factory=lambda: defaultdict(int))
    last_model: dict[int, str] = field(default_factory=dict)
    quests: set[str] = field(default_factory=set)

    def to_row(self) -> dict:
        return {
            "player_id": self.player_id,
            "histories": {str(k): v for k, v in self.histories.items()},
            "planted_emails": self.tool_ctx.planted_emails,
            "planted_docs": self.tool_ctx.planted_docs,
            "messages_per_level": {str(k): v for k, v in self.messages_per_level.items()},
            "last_model": {str(k): v for k, v in self.last_model.items()},
            "quests": sorted(self.quests),
            "updated_at": datetime.now(timezone.utc).isoformat(),
        }

    @classmethod
    def from_row(cls, player_id: str, row: dict | None, nickname: str, solved: set[int]) -> "Session":
        s = cls(player_id=player_id, nickname=nickname, solved=solved)
        if row:
            s.histories = {int(k): v for k, v in (row.get("histories") or {}).items()}
            s.tool_ctx = ToolContext(
                planted_emails=row.get("planted_emails") or [],
                planted_docs=row.get("planted_docs") or [],
            )
            s.messages_per_level = defaultdict(int, {int(k): v for k, v in (row.get("messages_per_level") or {}).items()})
            s.last_model = {int(k): v for k, v in (row.get("last_model") or {}).items()}
            s.quests = set(row.get("quests") or [])
        return s


def new_player_id() -> str:
    return str(uuid.uuid4())


def today() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%d")


# ------------------------------------------------------------------ supabase


def supabase_enabled() -> bool:
    return bool(settings.supabase_url and settings.supabase_key)


_client: httpx.AsyncClient | None = None


async def _sb(method: str, path: str, prefer: str = "", **kwargs):
    global _client
    if _client is None:
        _client = httpx.AsyncClient(timeout=10)
    headers = {"apikey": settings.supabase_key, "Content-Type": "application/json"}
    # A legacy service_role key is a JWT and goes in Authorization too. A new
    # sb_secret_ key is not a JWT, so it only goes in apikey.
    if settings.supabase_key.startswith("eyJ"):
        headers["Authorization"] = f"Bearer {settings.supabase_key}"
    if prefer:
        headers["Prefer"] = prefer
    try:
        resp = await _client.request(method, f"{settings.supabase_url}/rest/v1/{path}", headers=headers, **kwargs)
    except httpx.HTTPError as e:
        print(f"supabase error on {path}: {e!r}")
        return None
    if resp.status_code >= 300:
        print(f"supabase {method} {path} -> {resp.status_code} {resp.text[:200]}")
        return None
    return resp.json() if resp.text else None


# ------------------------------------------------------------ memory fallback

_mem_sessions: dict[str, Session] = {}
_mem_events: dict[str, list[float]] = defaultdict(list)
_mem_spend: dict[str, float] = defaultdict(float)
_mem_wins: dict[str, dict[int, dict]] = defaultdict(dict)


# ------------------------------------------------------------------ sessions


async def load_session(player_id: str) -> Session:
    if not supabase_enabled():
        s = _mem_sessions.get(player_id)
        if s is None:
            s = _mem_sessions[player_id] = Session(player_id=player_id)
        return s
    player = await _sb("GET", f"players?id=eq.{player_id}&select=nickname")
    row = await _sb("GET", f"sessions?player_id=eq.{player_id}&select=*")
    wins = await _sb("GET", f"wins?player_id=eq.{player_id}&select=level")
    nickname = (player[0]["nickname"] or "") if player else ""
    return Session.from_row(player_id, row[0] if row else None, nickname, {w["level"] for w in wins or []})


async def save_session(s: Session) -> None:
    if not supabase_enabled():
        _mem_sessions[s.player_id] = s
        return
    await _sb("POST", "sessions", prefer="resolution=merge-duplicates", json=s.to_row())


async def save_player(s: Session) -> None:
    if not supabase_enabled():
        _mem_sessions[s.player_id] = s
        return
    await _sb("POST", "players", prefer="resolution=merge-duplicates", json={"id": s.player_id, "nickname": s.nickname or None})


# ---------------------------------------------------------------- rate limits


async def hit(kind: str, key: str, limits: list[tuple[int, int]]) -> bool:
    """Records one event and returns False if any (limit, window_seconds) is exceeded."""
    if not supabase_enabled():
        now = time.time()
        events = _mem_events[f"{kind}:{key}"]
        events.append(now)
        longest = max(w for _, w in limits)
        _mem_events[f"{kind}:{key}"] = events = [t for t in events if t > now - longest]
        return all(sum(1 for t in events if t > now - window) <= limit for limit, window in limits)
    await _sb("POST", "events", json={"kind": kind, "key": key})
    counts = await _sb(
        "POST",
        "rpc/bma_count_events",
        json={"p_kind": kind, "p_key": key, "p_windows": [w for _, w in limits]},
    )
    if counts is None:
        return True  # don't lock everyone out if the counter is down; the budget still caps spend
    return all(c <= limit for c, (limit, _) in zip(counts, limits))


# -------------------------------------------------------------- daily budget


async def spent_today() -> float:
    if not supabase_enabled():
        return _mem_spend[today()]
    value = await _sb("POST", "rpc/bma_spent_today", json={})
    return float(value or 0)


async def budget_left() -> bool:
    return await spent_today() < settings.daily_budget_usd


# ------------------------------------------------------------------- logging


async def save_attempt(row: dict) -> None:
    if not supabase_enabled():
        _mem_spend[today()] += row["cost_usd"]
        return
    await _sb("POST", "attempts", json=row)


async def save_win(s: Session, level: int, model: str) -> None:
    messages_used = s.messages_per_level.get(level, 0)
    if not supabase_enabled():
        _mem_wins[s.player_id].setdefault(level, {"model": model, "messages_used": messages_used})
        return
    await _sb(
        "POST",
        "wins",
        prefer="resolution=ignore-duplicates",
        json={"player_id": s.player_id, "level": level, "model": model, "messages_used": messages_used},
    )


async def leaderboard(limit: int = 20) -> list[dict]:
    if supabase_enabled():
        return await _sb("GET", f"leaderboard?select=nickname,top_level,levels_solved,messages_used&limit={limit}") or []
    board = []
    for pid, wins in _mem_wins.items():
        s = _mem_sessions.get(pid)
        board.append(
            {
                "nickname": (s.nickname if s else "") or "anonymous",
                "top_level": max(wins),
                "levels_solved": len(wins),
                "messages_used": sum(w["messages_used"] for w in wins.values()),
            }
        )
    board.sort(key=lambda r: (-r["top_level"], r["messages_used"]))
    return board[:limit]
