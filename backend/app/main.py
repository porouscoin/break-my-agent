"""HTTP API for Break my agent."""

import asyncio
import hashlib
import hmac
import json
import re
import uuid

import httpx
from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from . import store
from .config import ModelSpec, env, model_registry, settings
from .levels import LEVELS, LEVELS_BY_NUMBER, secret_code
from .loop import RunTotals, run_agent
from .providers import ProviderError, call_model
from .tools import TOOL_SCHEMAS

MODELS = model_registry()

# The codes are derived from SECRET_KEY, and the default is in the public repo.
if settings.secret_key == "dev-only-change-me" and any(m.provider != "mock" for m in MODELS.values()):
    raise RuntimeError("Set SECRET_KEY before running with real model keys.")

app = FastAPI(title="Break my agent")
app.add_middleware(
    CORSMiddleware,
    allow_origins=[o.strip() for o in settings.frontend_origin.split(",") if o.strip()],
    allow_origin_regex=settings.frontend_origin_regex or None,
    allow_methods=["GET", "POST"],
    allow_headers=["Content-Type"],
)

HOUR, DAY = 3600, 86400


def ip_key(request: Request) -> str:
    """A salted hash of the visitor's IP, so raw IPs are never stored."""
    forwarded = request.headers.get("x-forwarded-for", "")
    ip = forwarded.split(",")[0].strip() or (request.client.host if request.client else "unknown")
    return hashlib.sha256(f"{settings.secret_key}:{ip}".encode()).hexdigest()[:16]


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
    return await store.load_session(player_id)


# ---------------------------------------------------------------------- routes


@app.get("/api/health")
async def health():
    return {"ok": True, "models": list(MODELS), "database": store.supabase_enabled()}


@app.get("/api/config")
async def config():
    return {
        "levels": [
            {"number": lv.number, "name": lv.name, "defense": lv.defense, "fixed_model": lv.fixed_model}
            for lv in available_levels()
        ],
        "models": [{"id": m.id, "label": m.label, "tools": m.supports_tools} for m in MODELS.values() if m.supports_tools],
        "budget_left": await store.budget_left(),
        "max_input_chars": settings.max_input_chars,
        "turnstile": bool(settings.turnstile_secret),
    }


class SessionIn(BaseModel):
    player_id: str | None = None
    turnstile_token: str | None = None


async def verify_turnstile(token: str | None, request: Request) -> bool:
    if not settings.turnstile_secret:
        return True
    if not token:
        return False
    async with httpx.AsyncClient(timeout=10) as client:
        resp = await client.post(
            "https://challenges.cloudflare.com/turnstile/v0/siteverify",
            data={"secret": settings.turnstile_secret, "response": token},
        )
    return bool(resp.json().get("success"))


@app.post("/api/session")
async def session(body: SessionIn, request: Request):
    if body.player_id and valid_player_id(body.player_id):
        s = await store.load_session(body.player_id)
    else:
        if not await store.hit("new_session", ip_key(request), [(10, HOUR)]):
            raise HTTPException(429, "Too many new sessions from your network. Try again later.")
        if not await verify_turnstile(body.turnstile_token, request):
            raise HTTPException(403, "Bot check failed. Refresh the page.")
        s = store.Session(player_id=store.new_player_id())
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
    if not await store.budget_left():
        raise HTTPException(503, "Today's budget is used up. Come back tomorrow.")
    limits = [(settings.messages_per_hour, HOUR), (settings.messages_per_day, DAY)]
    if not await store.hit("message", f"ip:{ip_key(request)}", limits) or not await store.hit("message", f"player:{s.player_id}", limits):
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
        await store.save_session(s)
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
        done = {"type": "done", "cost_usd": round(totals.cost_usd, 6), "tokens": totals.tokens, "blocked_by": totals.blocked_by}
        yield f"data: {json.dumps(done)}\n\n"

    return StreamingResponse(
        stream(), media_type="text/event-stream", headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"}
    )


class PlantIn(BaseModel):
    player_id: str
    kind: str  # "email" | "doc"
    sender: str = Field(default="", max_length=80)
    title: str = Field(max_length=120)
    body: str = Field(max_length=1500)


@app.post("/api/plant")
async def plant(body: PlantIn):
    s = await require_session(body.player_id)
    if not await store.hit("plant", s.player_id, [(20, HOUR)]):
        raise HTTPException(429, "Slow down with the planting.")
    ctx = s.tool_ctx
    if body.kind == "email":
        sender = body.sender.strip() or "someone@outside.test"
        ctx.planted_emails = (ctx.planted_emails + [{"from": sender, "subject": body.title, "body": body.body}])[-3:]
    elif body.kind == "doc":
        doc = {"id": f"planted-{len(ctx.planted_docs)}", "title": body.title, "body": body.body}
        ctx.planted_docs = (ctx.planted_docs + [doc])[-3:]
    else:
        raise HTTPException(400, "kind must be email or doc")
    # Ava may have read the inbox earlier in the chat. Without this note she
    # answers from that old read and never sees what was just planted.
    where = "the shared inbox" if body.kind == "email" else "the company docs"
    for history in s.histories.values():
        if history:
            history.append({"role": "system", "content": f"Something new was just added to {where}. Read it again before answering about it."})
    await store.save_session(s)
    return {"ok": True, "emails": len(ctx.planted_emails), "docs": len(ctx.planted_docs)}


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
    if not await store.hit("guess", s.player_id, [(settings.guesses_per_minute, 60)]):
        raise HTTPException(429, "Too many guesses. Wait a minute.")
    correct = _norm(body.code) == _norm(secret_code(body.level))
    if correct and body.level not in s.solved:
        s.solved.add(body.level)
        level = LEVELS_BY_NUMBER[body.level]
        await store.save_win(s, body.level, s.last_model.get(body.level, level.fixed_model or "unknown"))
    return {"correct": correct, "solved": sorted(s.solved)}


class ResetIn(BaseModel):
    player_id: str
    level: int


@app.post("/api/reset")
async def reset(body: ResetIn):
    s = await require_session(body.player_id)
    s.histories.pop(body.level, None)
    await store.save_session(s)
    return {"ok": True}


@app.get("/api/leaderboard")
async def get_leaderboard():
    return {"rows": await store.leaderboard()}


# ---------------------------------------------------------------------- admin


@app.get("/api/admin/groq-models")
async def groq_models_probe(request: Request):
    """Lists the models Groq offers this key and checks which can call tools.
    Needs the X-Admin-Key header set to SECRET_KEY."""
    given = request.headers.get("x-admin-key", "")
    if not given or not hmac.compare_digest(given, settings.secret_key):
        raise HTTPException(404)
    key = env("GROQ_API_KEY")
    async with httpx.AsyncClient(timeout=20) as client:
        resp = await client.get("https://api.groq.com/openai/v1/models", headers={"Authorization": f"Bearer {key}"})
    ids = sorted(m["id"] for m in resp.json().get("data", []))
    skip = ("whisper", "tts", "orpheus", "playai", "distil")

    async def probe(model: str) -> str:
        if any(word in model for word in skip):
            return "not a chat model"
        spec = ModelSpec(model, model, "groq", model, "https://api.groq.com/openai/v1", key, 0.0, 0.0)
        try:
            r = await call_model(spec, [{"role": "user", "content": "Check the shared inbox."}], tools=TOOL_SCHEMAS, max_tokens=200)
        except ProviderError as e:
            return f"error: {str(e)[:120]}"
        return "tools ok" if r.tool_calls else "replied without a tool call"

    outcomes = await asyncio.gather(*(probe(m) for m in ids))
    return dict(zip(ids, outcomes))
