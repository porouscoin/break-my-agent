"""State: visitor sessions, rate limits, the daily budget, and Supabase logging.

Sessions live in memory (one Railway instance is plenty). Wins and attempts
are written to Supabase so the leaderboard and spend survive restarts.
If Supabase isn't configured, everything still works in memory.
"""

import time
import uuid
from collections import defaultdict, deque
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
    last_seen: float = field(default_factory=time.time)


_sessions: dict[str, Session] = {}


def new_player_id() -> str:
    return str(uuid.uuid4())


def get_session(player_id: str) -> Session:
    s = _sessions.get(player_id)
    if s is None:
        s = Session(player_id=player_id)
        _sessions[player_id] = s
        if len(_sessions) > 5000:  # drop the oldest idle sessions
            for pid, _ in sorted(_sessions.items(), key=lambda kv: kv[1].last_seen)[:1000]:
                _sessions.pop(pid, None)
    s.last_seen = time.time()
    return s


# ---------------------------------------------------------------- rate limits

_hits: dict[str, deque] = defaultdict(deque)


def allow(key: str, limit: int, window_s: int) -> bool:
    now = time.time()
    q = _hits[key]
    while q and q[0] <= now - window_s:
        q.popleft()
    if len(q) >= limit:
        return False
    q.append(now)
    return True


# -------------------------------------------------------------- daily budget

_spend: dict[str, float] = defaultdict(float)


def today() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%d")


def spent_today() -> float:
    return _spend[today()]


def add_spend(usd: float) -> None:
    _spend[today()] += usd


def budget_left() -> bool:
    return spent_today() < settings.daily_budget_usd


# ------------------------------------------------------------------ supabase


def _sb_enabled() -> bool:
    return bool(settings.supabase_url and settings.supabase_key)


def _sb_headers(prefer: str = "") -> dict:
    h = {
        "apikey": settings.supabase_key,
        "Authorization": f"Bearer {settings.supabase_key}",
        "Content-Type": "application/json",
    }
    if prefer:
        h["Prefer"] = prefer
    return h


async def _sb(method: str, path: str, prefer: str = "", **kwargs):
    if not _sb_enabled():
        return None
    try:
        async with httpx.AsyncClient(timeout=10) as client:
            resp = await client.request(
                method, f"{settings.supabase_url}/rest/v1/{path}", headers=_sb_headers(prefer), **kwargs
            )
        if resp.status_code >= 300:
            print(f"supabase {method} {path} -> {resp.status_code} {resp.text[:200]}")
            return None
        return resp.json() if resp.text else None
    except httpx.HTTPError as e:
        print(f"supabase error: {e}")
        return None


async def save_player(s: Session) -> None:
    await _sb(
        "POST",
        "players",
        prefer="resolution=merge-duplicates",
        json={"id": s.player_id, "nickname": s.nickname or None},
    )


async def save_attempt(row: dict) -> None:
    await _sb("POST", "attempts", json=row)


async def save_win(player_id: str, level: int, model: str, messages_used: int) -> None:
    await _sb(
        "POST",
        "wins",
        prefer="resolution=ignore-duplicates",
        json={"player_id": player_id, "level": level, "model": model, "messages_used": messages_used},
    )


async def load_solved(player_id: str) -> set[int]:
    rows = await _sb("GET", f"wins?player_id=eq.{player_id}&select=level")
    return {r["level"] for r in rows or []}


async def load_spend_today() -> None:
    rows = await _sb("GET", f"attempts?created_at=gte.{today()}T00:00:00Z&select=cost_usd")
    if rows:
        _spend[today()] = sum(float(r["cost_usd"] or 0) for r in rows)


async def leaderboard(limit: int = 20) -> list[dict]:
    rows = await _sb("GET", f"leaderboard?select=*&limit={limit}")
    if rows is not None:
        return rows
    # In-memory fallback for local dev.
    board = [
        {
            "nickname": s.nickname or "anonymous",
            "top_level": max(s.solved),
            "levels_solved": len(s.solved),
            "messages_used": sum(s.messages_per_level.values()),
        }
        for s in _sessions.values()
        if s.solved
    ]
    board.sort(key=lambda r: (-r["top_level"], r["messages_used"]))
    return board[:limit]
