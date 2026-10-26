"""HTTP API for Break my agent."""

import json
import re
import uuid
from contextlib import asynccontextmanager

import httpx
from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from . import store
from .config import model_registry, settings
from .levels import LEVELS, LEVELS_BY_NUMBER, secret_code
from .loop import RunTotals, run_agent


@asynccontextmanager
async def lifespan(app: FastAPI):
    # The codes are derived from SECRET_KEY, and the default is in the public repo.
    if settings.secret_key == "dev-only-change-me" and any(m.provider != "mock" for m in MODELS.values()):
        raise RuntimeError("Set SECRET_KEY before running with real model keys.")
    await store.load_spend_today()
    yield


app = FastAPI(title="Break my agent", lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=[o.strip() for o in settings.frontend_origin.split(",") if o.strip()],
    allow_origin_regex=settings.frontend_origin_regex or None,
    allow_methods=["GET", "POST"],
    allow_headers=["Content-Type"],
)

MODELS = model_registry()


def client_ip(request: Request) -> str:
    forwarded = request.headers.get("x-forwarded-for", "")
    return forwarded.split(",")[0].strip() or (request.client.host if request.client else "unknown")


def available_levels() -> list:
    return [lv for lv in LEVELS if lv.fixed_model is None or lv.fixed_model in MODELS]


def is_unlocked(level: int, solved: set[int]) -> bool:
    return level <= 1 or (level - 1) in solved


def valid_player_id(pid: str) -> bool:
    try:
        uuid.UUID(pid)
        return True
    except ValueError:
        return False


async def require_session(player_id: str) -> store.Session:
    if not valid_player_id(player_id):
        raise HTTPException(400, "Bad player id. Refresh the page.")
    return store.get_session(player_id)


# ---------------------------------------------------------------------- routes


@app.get("/api/health")
async def health():
    return {"ok": True, "models": list(MODELS)}


@app.get("/api/config")
async def config():
    return {
        "levels": [
            {"number": lv.number, "name": lv.name, "defense": lv.defense, "fixed_model": lv.fixed_model}
            for lv in available_levels()
        ],
        "models": [
            {"id": m.id, "label": m.label, "tools": m.supports_tools}
            for m in MODELS.values()
            if m.supports_tools
        ],
        "budget_left": store.budget_left(),
        "max_input_chars": settings.max_input_chars,
        "turnstile": bool(settings.turnstile_secret),
    }


class SessionIn(BaseModel):
    player_id: str | None = None
    turnstile_token: str | None = None


async def verify_turnstile(token: str | None, ip: str) -> bool:
    if not settings.turnstile_secret:
        return True
    if not token:
        return False
    async with httpx.AsyncClient(timeout=10) as client:
        resp = await client.post(
            "https://challenges.cloudflare.com/turnstile/v0/siteverify",
            data={"secret": settings.turnstile_secret, "response": token, "remoteip": ip},
        )
    return bool(resp.json().get("success"))


@app.post("/api/session")
async def session(body: SessionIn, request: Request):
    ip = client_ip(request)
    if body.player_id and valid_player_id(body.player_id):
        s = store.get_session(body.player_id)
        if not s.solved:
            s.solved = await store.load_solved(s.player_id)
    else:
        if not store.allow(f"new:{ip}", 10, 3600):
            raise HTTPException(429, "Too many new sessions from your network. Try again later.")
        if not await verify_turnstile(body.turnstile_token, ip):
            raise HTTPException(403, "Bot check failed. Refresh the page.")
        s = store.get_session(store.new_player_id())
        await store.save_player(s)
    return {"player_id": s.player_id, "nickname": s.nickname, "solved": sorted(s.solved)}


class NicknameIn(BaseModel):
    player_id: str
    nickname: str = Field(max_length=24)


@app.post("/api/nickname")
async def nickname(body: NicknameIn):
    s = await require_session(body.player_id)
    clean = re.sub(r"[^\w .-]", "", body.nickname).strip()[:24]
    if not clean:
        raise HTTPException(400, "Pick a nickname with letters or numbers.")
    s.nickname = clean
    await store.save_player(s)
    return {"nickname": clean}


class ChatIn(BaseModel):
    player_id: str
    level: int
    model: str
    message: str


@app.post("/api/chat")
async def chat(body: ChatIn, request: Request):
    s = await require_session(body.player_id)
    level = LEVELS_BY_NUMBER.get(body.level)
    if level is None or level not in available_levels():
        raise HTTPException(400, "Unknown level.")
    if not is_unlocked(level.number, s.solved):
        raise HTTPException(403, f"Beat level {level.number - 1} first.")
    model_id = level.fixed_model or body.model
    spec = MODELS.get(model_id)
    if spec is None or (level.tools and not spec.supports_tools):
        raise HTTPException(400, "That model isn't available.")
    text = body.message.strip()
    if not text:
        raise HTTPException(400, "Say something.")
    if len(text) > settings.max_input_chars:
        raise HTTPException(400, f"Keep it under {settings.max_input_chars} characters.")
    if not store.budget_left():
        raise HTTPException(503, "Today's budget is used up. Come back tomorrow.")
    ip = client_ip(request)
    for key in (f"ip:{ip}", f"player:{s.player_id}"):
        if not store.allow(f"{key}:h", settings.messages_per_hour, 3600) or not store.allow(
            f"{key}:d", settings.messages_per_day, 86400
        ):
            raise HTTPException(429, "You're sending messages too fast. Take a breather and try again later.")

    history = s.histories.setdefault(level.number, [])
    s.messages_per_level[level.number] += 1
    s.last_model[level.number] = model_id
    totals = RunTotals()

    async def stream():
        trace: list[dict] = []
        try:
            async for event in run_agent(level, spec, history, text, s.tool_ctx, totals):
                trace.append(event)
                yield f"data: {json.dumps(event)}\n\n"
        except Exception as e:  # never leave the browser hanging
            print(f"agent error: {e!r}")
            event = {"type": "error", "message": "Something broke on our side. Try again."}
            trace.append(event)
            yield f"data: {json.dumps(event)}\n\n"
        store.add_spend(totals.cost_usd)
        done = {"type": "done", "cost_usd": round(totals.cost_usd, 6), "tokens": totals.tokens, "blocked_by": totals.blocked_by}
        yield f"data: {json.dumps(done)}\n\n"
        await store.save_attempt(
            {
                "player_id": s.player_id,
                "level": level.number,
                "model": model_id,
                "message": text,
                "blocked_by": totals.blocked_by,
                "cost_usd": totals.cost_usd,
                "tokens": totals.tokens,
                "trace": trace,
            }
        )

    return StreamingResponse(stream(), media_type="text/event-stream", headers={"Cache-Control": "no-cache"})


class PlantIn(BaseModel):
    player_id: str
    kind: str  # "email" | "doc"
    sender: str = Field(default="", max_length=80)
    title: str = Field(max_length=120)
    body: str = Field(max_length=1500)


@app.post("/api/plant")
async def plant(body: PlantIn):
    s = await require_session(body.player_id)
    if not store.allow(f"plant:{s.player_id}", 20, 3600):
        raise HTTPException(429, "Slow down with the planting.")
    if body.kind == "email":
        sender = body.sender.strip() or "someone@outside.test"
        s.tool_ctx.planted_emails = (s.tool_ctx.planted_emails + [{"from": sender, "subject": body.title, "body": body.body}])[-3:]
    elif body.kind == "doc":
        doc = {"id": f"planted-{len(s.tool_ctx.planted_docs)}", "title": body.title, "body": body.body}
        s.tool_ctx.planted_docs = (s.tool_ctx.planted_docs + [doc])[-3:]
    else:
        raise HTTPException(400, "kind must be email or doc")
    return {"ok": True, "emails": len(s.tool_ctx.planted_emails), "docs": len(s.tool_ctx.planted_docs)}


class GuessIn(BaseModel):
    player_id: str
    level: int
    code: str = Field(max_length=80)


def _norm(code: str) -> str:
    return re.sub(r"[^A-Z0-9]", "", code.upper())


@app.post("/api/guess")
async def guess(body: GuessIn):
    s = await require_session(body.player_id)
    if body.level not in LEVELS_BY_NUMBER:
        raise HTTPException(400, "Unknown level.")
    if not store.allow(f"guess:{s.player_id}", settings.guesses_per_minute, 60):
        raise HTTPException(429, "Too many guesses. Wait a minute.")
    correct = _norm(body.code) == _norm(secret_code(body.level))
    if correct and body.level not in s.solved:
        s.solved.add(body.level)
        level = LEVELS_BY_NUMBER[body.level]
        await store.save_win(s.player_id, body.level, s.last_model.get(body.level, level.fixed_model or "unknown"), s.messages_per_level[body.level])
    return {"correct": correct, "solved": sorted(s.solved)}


class ResetIn(BaseModel):
    player_id: str
    level: int


@app.post("/api/reset")
async def reset(body: ResetIn):
    s = await require_session(body.player_id)
    s.histories.pop(body.level, None)
    return {"ok": True}


@app.get("/api/leaderboard")
async def get_leaderboard():
    return {"rows": await store.leaderboard()}
