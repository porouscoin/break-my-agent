"""One function, call_model(), that talks to every provider.

DeepSeek, Gemini, Groq and OpenRouter all speak the OpenAI chat format, so a
single HTTP adapter covers them. The differences we smooth over:
- reasoning models (Qwen on Groq) may wrap their thinking in <think> tags
- some providers return content=None when the model only calls tools
- tool-call arguments arrive as a JSON string that is sometimes invalid
"""

import asyncio
import json
import re
import time
from dataclasses import dataclass, field
from typing import Any, Callable

import httpx

from .config import ModelSpec

THINK_RE = re.compile(r"<think>.*?</think>", re.DOTALL)


@dataclass
class ToolCall:
    id: str
    name: str
    arguments: dict[str, Any]
    raw_arguments: str = ""


@dataclass
class ModelResult:
    content: str
    tool_calls: list[ToolCall] = field(default_factory=list)
    tokens_in: int = 0
    tokens_out: int = 0
    cost_usd: float = 0.0
    ms: int = 0


class ProviderError(Exception):
    pass


# Tests and local dev can swap in a fake model: a function that takes the
# messages and tools and returns a ModelResult.
MockFn = Callable[[list[dict], list[dict] | None], ModelResult]
_mock_fn: MockFn | None = None


def set_mock(fn: MockFn | None) -> None:
    global _mock_fn
    _mock_fn = fn


def _default_mock(messages: list[dict], tools: list[dict] | None) -> ModelResult:
    """A tiny rule-based stand-in so the app runs without any API key."""
    last = messages[-1]
    if last["role"] == "tool":
        return ModelResult(content=f"Here is what I found: {str(last['content'])[:300]}")
    text = str(last.get("content", "")).lower()
    if tools and "inbox" in text:
        return ModelResult(content="", tool_calls=[ToolCall("call_1", "read_inbox", {})])
    if tools and "doc" in text:
        return ModelResult(content="", tool_calls=[ToolCall("call_1", "search_docs", {"query": text[-40:]})])
    system = str(messages[0].get("content", "")).lower()
    if "prompt injection" in system:
        return ModelResult(content='{"injection": false, "score": 0.1, "reason": "mock"}')
    if "leaking a secret" in system:
        return ModelResult(content='{"leak": false, "reason": "mock"}')
    return ModelResult(content="Hi, I'm Ava. I can help with docs, the inbox and customer records.")


def _parse_args(raw: str) -> dict[str, Any]:
    try:
        parsed = json.loads(raw or "{}")
        return parsed if isinstance(parsed, dict) else {"value": parsed}
    except json.JSONDecodeError:
        return {"_invalid_json": raw}


def _cost(spec: ModelSpec, tokens_in: int, tokens_out: int) -> float:
    return (tokens_in * spec.usd_per_m_in + tokens_out * spec.usd_per_m_out) / 1_000_000


_client: httpx.AsyncClient | None = None


def _http() -> httpx.AsyncClient:
    global _client
    if _client is None:
        _client = httpx.AsyncClient(timeout=httpx.Timeout(45.0, connect=10.0))
    return _client


async def call_model(
    spec: ModelSpec,
    messages: list[dict],
    tools: list[dict] | None = None,
    max_tokens: int = 600,
    temperature: float = 0.7,
    json_mode: bool = False,
) -> ModelResult:
    started = time.monotonic()

    if spec.provider == "mock":
        result = (_mock_fn or _default_mock)(messages, tools)
        result.ms = int((time.monotonic() - started) * 1000)
        return result

    body: dict[str, Any] = {
        "model": spec.model,
        "messages": messages,
        "max_tokens": max_tokens,
        "temperature": temperature,
    }
    if tools and spec.supports_tools:
        body["tools"] = tools
        body["tool_choice"] = "auto"
    if json_mode:
        body["response_format"] = {"type": "json_object"}
    headers = {"Authorization": f"Bearer {spec.api_key}"}
    if spec.provider == "openrouter":
        headers["X-Title"] = "Break my agent"

    data: dict[str, Any] | None = None
    last_error = ""
    for attempt in range(3):
        try:
            resp = await _http().post(f"{spec.base_url}/chat/completions", json=body, headers=headers)
        except httpx.HTTPError as e:
            last_error = f"network error: {type(e).__name__}"
        else:
            if resp.status_code == 200:
                data = resp.json()
                break
            last_error = f"HTTP {resp.status_code}: {resp.text[:200]}"
            # Only rate limits and server errors are worth retrying.
            if resp.status_code != 429 and resp.status_code < 500:
                break
        await asyncio.sleep(1.5 * (2**attempt))

    if data is None:
        raise ProviderError(f"{spec.label} failed: {last_error}")

    message = data["choices"][0]["message"]
    content = THINK_RE.sub("", message.get("content") or "").strip()
    tool_calls = [
        ToolCall(
            id=tc.get("id") or f"call_{i}",
            name=tc["function"]["name"],
            arguments=_parse_args(tc["function"].get("arguments", "")),
            raw_arguments=tc["function"].get("arguments", ""),
        )
        for i, tc in enumerate(message.get("tool_calls") or [])
    ]
    usage = data.get("usage") or {}
    tokens_in = int(usage.get("prompt_tokens", 0))
    tokens_out = int(usage.get("completion_tokens", 0))
    return ModelResult(
        content=content,
        tool_calls=tool_calls,
        tokens_in=tokens_in,
        tokens_out=tokens_out,
        cost_usd=_cost(spec, tokens_in, tokens_out),
        ms=int((time.monotonic() - started) * 1000),
    )
