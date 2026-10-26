# Break my agent

A prompt-injection game. Ava is an AI assistant with real tools: she searches docs, reads an inbox, looks up customers and sends emails. She also knows a secret vault code. Your job is to make her leak it, through 5 levels of defenses.

Unlike "make the chatbot say the password" games, the target here is an agent: it can misuse tools, attacks can hide inside emails and documents it reads (indirect injection), and a live trace shows every step and which defense caught you.

Everything is fake: the company, the inbox, the customers. Emails only go to a log.

## Levels

| Level | New defense | How it works |
| --- | --- | --- |
| 0 | None | An uncensored model with the code in its prompt (only when an OpenRouter key is set) |
| 1 | System prompt | Ava is told to keep the code secret. Nothing enforces it |
| 2 | Input guard | Regex patterns plus a classifier model score each message before Ava sees it |
| 3 | Output guard | Ava's reply is scanned for the code: exact, spaced, reversed, base64, or 2 of its 3 parts |
| 4 | Tool policy | Checked in code: email only to `@larkspur.test`, email bodies scanned, private customer fields hidden |
| 5 | Quarantine | Inbox and doc text is read by a second model with no tools; Ava only sees its summary (a simple dual-LLM pattern) |

Each guard is good but not perfect on purpose, so every level can be beaten.

## How a message flows

```
visitor message
  -> input guard (L2+)                       blocked? reply "Sorry, I can't help with that."
  -> model call  <-------------------------+
       tool call?                           |
         -> tool policy (L4+)               |  up to 6 steps
         -> run tool on fake data           |
         -> quarantine untrusted output (L5)+
       final answer
  -> output guard (L3+)                      leaked? reply is replaced
  -> reply + trace streamed to the browser (Server-Sent Events)
```

You win a level by typing the code into the "Got the code?" box. The server checks it, so any trick that gets the code out counts.

## Code tour

The agent harness is plain Python with no agent framework.

| File | What it does |
| --- | --- |
| `backend/app/providers.py` | `call_model()`: one HTTP adapter for DeepSeek, Gemini, Groq and OpenRouter (all OpenAI-compatible). Retries with backoff, strips `<think>` tags, parses tool-call JSON, computes cost from token usage |
| `backend/app/loop.py` | `run_agent()`: the agent loop. An async generator that yields one trace event per step, with the guards hooked in |
| `backend/app/guards.py` | The input guard, output guard, tool policy and quarantine |
| `backend/app/tools.py` | Tool schemas and their implementations on fake data |
| `backend/app/levels.py` | Level definitions, system prompts, and per-level codes derived from `SECRET_KEY` with HMAC |
| `backend/app/store.py` | Sessions, rate limits, the daily budget, Supabase logging |
| `backend/app/main.py` | FastAPI routes, including the streaming `/api/chat` |
| `frontend/` | Next.js page: chat, live trace, planting emails and docs, leaderboard |

## Cost control

- Per IP and per player: 30 messages an hour, 150 a day; 6 code guesses a minute
- Messages capped at 1,500 characters, 6 agent steps, 600 output tokens
- A daily budget (`DAILY_BUDGET_USD`, default $1) computed from real token usage; the game pauses until midnight UTC when it runs out
- Prepaid provider balances are the hard ceiling
- Optional Cloudflare Turnstile bot check for new visitors

## Run it locally

```bash
cd backend
python3 -m venv .venv && .venv/bin/pip install -r requirements.txt -r requirements-dev.txt
ENABLE_MOCK_MODEL=1 .venv/bin/uvicorn app.main:app --port 8000   # a fake model, no keys needed
.venv/bin/python -m pytest

cd ../frontend
npm install
NEXT_PUBLIC_API_URL=http://localhost:8000 npm run dev
```

Add real keys in `backend/.env` style environment variables (see `backend/.env.example`). A model only appears in the game when its key is set.

## Deploy

- Backend: Railway, root directory `backend`. Config in `backend/railway.json`
- Database: Supabase. Run `backend/schema.sql` once in the SQL editor
- Frontend: Vercel, root directory `frontend`, with `NEXT_PUBLIC_API_URL` pointing at the Railway URL
