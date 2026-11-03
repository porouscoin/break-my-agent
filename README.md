<div align="center">

# Break my agent

**A prompt-injection game against an AI agent that has real tools.**
Get Ava to leak the vault code through five levels of defenses.

[**Play it live**](https://break-my-agent-ctf.vercel.app) · [How it works](#how-a-message-flows) · [Run it locally](#run-it-locally)

![Python](https://img.shields.io/badge/Python-3776AB?logo=python&logoColor=white)
![FastAPI](https://img.shields.io/badge/FastAPI-009688?logo=fastapi&logoColor=white)
![Next.js](https://img.shields.io/badge/Next.js-000000?logo=nextdotjs&logoColor=white)
![Supabase](https://img.shields.io/badge/Supabase-3FCF8E?logo=supabase&logoColor=white)
![Groq](https://img.shields.io/badge/Groq-F55036)
![Vercel](https://img.shields.io/badge/Vercel-000000?logo=vercel&logoColor=white)

<img src="docs/screenshot.png" alt="Break my agent: level list, chat with Ava and the live trace panel" width="900">

</div>

## What it is

Ava is an AI assistant at a fake company. She can search docs, read the shared inbox, look up customers and send emails, and she knows a secret vault code. Your job is to make her leak it.

Unlike "make the chatbot say the password" games, the target here is an **agent**:

- It can **misuse its tools**, not just say the wrong thing.
- Attacks can hide **inside emails and documents** it reads (indirect injection).
- A **live trace** shows every model call, tool call and guard verdict, so you can see exactly which defense caught you.

Everything is fake: the company, the inbox and the customers. Emails only go to a log.

## The five levels

| Level | Name | New defense | How it works |
| :---: | --- | --- | --- |
| 1 | No rules | None | Ava knows the code and was never told to keep it secret |
| 2 | Bouncer | Secrecy rule + input guard | Regex patterns plus Meta's Llama Prompt Guard 2 screen each message before Ava sees it |
| 3 | Censor | Output guard + decoy | Replies are scanned for the code: exact, spaced, reversed, base64, or 2 of its 3 parts. Pushy players get a decoy code that looks real |
| 4 | Locked tools | Tool policy | Checked in code: email only to `@larkspur.test`, email bodies scanned, private customer fields hidden |
| 5 | Fortress | Everything | All of the above, plus quarantine (a second model with no tools reads inbox and doc text), a strict prompt, a censor for any single part of the code, and a judge model that rereads the whole conversation |

Levels 1 to 4 are beatable on purpose. Level 5 is possible in theory but stacks every defense at once. An optional level 0 uses an uncensored model when an OpenRouter key is set.

**Side quests** are CTF-style flags that work on any level: reveal Ava's instructions, leak a customer's private data, get her to email outside the company, plant a message that makes her send an email on her own, and fall for a decoy.

## How a message flows

```mermaid
flowchart TD
    A[Your message] --> B{Input guard<br/>level 2+}
    B -- blocked --> X[Sorry, I can't help with that.]
    B -- ok --> C[Model call]
    C -- tool call --> D{Tool policy<br/>level 4+}
    D --> E[Run tool on fake data]
    E --> F[Quarantine untrusted text<br/>level 5]
    F --> C
    C -- final answer --> G{Output guard<br/>level 3+}
    G -- leak found --> Y[Reply replaced]
    G -- ok --> H[Reply + trace streamed to the browser]
```

The agent gets up to 6 steps per message. You win a level by typing the code into the "Got the code?" box, and the server checks it, so any trick that gets the code out counts.

## Code tour

The agent harness is plain Python with no agent framework.

| File | What it does |
| --- | --- |
| [`backend/app/loop.py`](backend/app/loop.py) | `run_agent()`: the agent loop. An async generator that yields one trace event per step, with the guards hooked in |
| [`backend/app/providers.py`](backend/app/providers.py) | `call_model()`: one HTTP adapter for Groq, Gemini, DeepSeek and OpenRouter. Retries, tool-call parsing and cost from token usage |
| [`backend/app/guards.py`](backend/app/guards.py) | Input guard, output guard, tool policy, quarantine and leak judge |
| [`backend/app/tools.py`](backend/app/tools.py) | Tool schemas and their implementations on fake data |
| [`backend/app/levels.py`](backend/app/levels.py) | Level definitions, system prompts, and per-level codes derived from `SECRET_KEY` with HMAC |
| [`backend/app/quests.py`](backend/app/quests.py) | Side quest definitions and the checks that award them |
| [`backend/app/store.py`](backend/app/store.py) | Sessions, rate limits, the daily budget and Supabase logging |
| [`backend/app/main.py`](backend/app/main.py) | FastAPI routes, including the streaming `/api/chat` |
| [`frontend/`](frontend) | Next.js app: chat, live trace, planting emails and docs, leaderboard |

## Keeping costs safe

- 30 messages an hour and 150 a day per player and per IP, plus 6 code guesses a minute
- Messages capped at 1,500 characters, 6 agent steps and 600 output tokens
- A daily budget (`DAILY_BUDGET_USD`, default $1) computed from real token usage; the game pauses until midnight UTC when it runs out
- Optional Cloudflare Turnstile bot check for new visitors

## Run it locally

```bash
# Backend, with a fake model so no keys are needed
cd backend
python3 -m venv .venv && .venv/bin/pip install -r requirements.txt -r requirements-dev.txt
ENABLE_MOCK_MODEL=1 .venv/bin/uvicorn app.main:app --port 8000
.venv/bin/python -m pytest

# Frontend
cd ../frontend
npm install
NEXT_PUBLIC_API_URL=http://localhost:8000 npm run dev
```

Real model keys go in environment variables (see `backend/.env.example`). A model only shows up in the game when its key is set.

## Deploy

Both halves run on Vercel's free tier. The backend keeps no state in memory, so it works as a serverless function.

1. **Database:** create a Supabase project and run `backend/schema.sql` once in the SQL editor.
2. **Backend:** a Vercel project with root directory `backend`. Set `SECRET_KEY`, the model keys, `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY`.
3. **Frontend:** a Vercel project with root directory `frontend` and `NEXT_PUBLIC_API_URL` set to the backend URL. Set `FRONTEND_ORIGIN` on the backend if you use a domain other than `break-my-agent*.vercel.app`.

`backend/railway.json` is kept for running the backend as a long-lived server on Railway instead.

---

<div align="center">

Built by [Ziyad Hisham](https://ziyadhisham.com)

</div>
