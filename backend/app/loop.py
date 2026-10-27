"""The agent loop, with the defense layers hooked in at three points:

    visitor message -> [input guard] -> model <-> tools -> [output guard] -> reply
                                                  ^
                                   [tool policy] before a tool runs
                                   [quarantine] on untrusted tool output

run_agent() is an async generator: it yields one trace event per step, which
the API streams straight to the browser.
"""

import json
from dataclasses import dataclass, field
from typing import AsyncIterator

from . import guards, quests
from .config import ModelSpec, settings
from .levels import Level, secret_code, system_prompt
from .providers import ProviderError, call_model
from .tools import TOOL_SCHEMAS, UNTRUSTED_TOOLS, ToolContext, run_tool

BLOCKED_INPUT_REPLY = "Sorry, I can't help with that."
BLOCKED_OUTPUT_REPLY = "I was about to say something I shouldn't. Let's move on."
MAX_HISTORY = 24


@dataclass
class RunTotals:
    cost_usd: float = 0.0
    tokens: int = 0
    blocked_by: str | None = None
    steps: int = 0
    emails: list[dict] = field(default_factory=list)


def trim_history(history: list[dict]) -> list[dict]:
    """Keep the last MAX_HISTORY messages, cutting only at a user message so a
    tool call is never separated from its result."""
    if len(history) <= MAX_HISTORY:
        return history
    for i in range(len(history) - MAX_HISTORY, len(history)):
        if history[i]["role"] == "user":
            return history[i:]
    return history[-1:]


def _assistant_message(content: str, tool_calls) -> dict:
    msg: dict = {"role": "assistant", "content": content or ""}
    if tool_calls:
        msg["tool_calls"] = []
        for tc in tool_calls:
            call = {
                "id": tc.id,
                "type": "function",
                "function": {"name": tc.name, "arguments": tc.raw_arguments or json.dumps(tc.arguments)},
            }
            if tc.extra_content:
                call["extra_content"] = tc.extra_content
            msg["tool_calls"].append(call)
    return msg


async def run_agent(
    level: Level,
    spec: ModelSpec,
    history: list[dict],
    user_text: str,
    ctx: ToolContext,
    totals: RunTotals,
) -> AsyncIterator[dict]:
    code = secret_code(level.number)
    history.append({"role": "user", "content": user_text})

    # 1. Input guard
    if level.input_guard:
        verdict, cost = await guards.input_guard(user_text, spec)
        totals.cost_usd += cost
        yield {"type": "guard", **verdict.__dict__}
        if not verdict.allowed:
            totals.blocked_by = verdict.layer
            history.append({"role": "assistant", "content": BLOCKED_INPUT_REPLY})
            yield {"type": "reply", "text": BLOCKED_INPUT_REPLY, "blocked_by": verdict.layer}
            return

    tools = TOOL_SCHEMAS if (level.tools and spec.supports_tools) else None
    ctx.hide_private_fields = level.tool_policy

    read_planted = False  # for the puppet master quest: did Ava read planted text this run?
    # 2. The loop: call the model, run any tools, repeat
    for step in range(1, settings.max_steps + 1):
        totals.steps = step
        messages = [{"role": "system", "content": system_prompt(level)}] + trim_history(history)
        try:
            result = await call_model(spec, messages, tools=tools, max_tokens=settings.max_output_tokens)
        except ProviderError as e:
            if history[-1]["role"] == "user":
                history.pop()  # let the visitor retry without a dangling message
            yield {"type": "error", "message": str(e)}
            return
        totals.cost_usd += result.cost_usd
        totals.tokens += result.tokens_in + result.tokens_out
        yield {
            "type": "model",
            "step": step,
            "model": spec.label,
            "ms": result.ms,
            "tokens_in": result.tokens_in,
            "tokens_out": result.tokens_out,
            "cost_usd": round(result.cost_usd, 6),
            # No reply text here: it would reach the browser before the output guard runs.
            "tool_calls": [{"name": tc.name, "args": tc.arguments} for tc in result.tool_calls],
        }

        if not result.tool_calls:
            reply = result.content or "(no reply)"
            # 3. Output guard
            if level.output_guard:
                verdict = guards.output_guard(reply, code, level.fortress)
                yield {"type": "guard", **verdict.__dict__}
                if verdict.allowed and level.fortress:
                    earlier = [m["content"] for m in history if m["role"] == "assistant" and m.get("content")]
                    verdict, cost = await guards.leak_judge(reply, earlier, code, spec)
                    totals.cost_usd += cost
                    yield {"type": "guard", **verdict.__dict__}
                if not verdict.allowed:
                    totals.blocked_by = verdict.layer
                    history.append({"role": "assistant", "content": BLOCKED_OUTPUT_REPLY})
                    yield {"type": "reply", "text": BLOCKED_OUTPUT_REPLY, "blocked_by": verdict.layer}
                    return
            history.append({"role": "assistant", "content": reply})
            yield {"type": "reply", "text": reply, "blocked_by": None}
            for quest_id in quests.check_reply(reply):
                yield {"type": "quest", "id": quest_id}
            return

        history.append(_assistant_message(result.content, result.tool_calls))
        for tc in result.tool_calls:
            # Tool policy runs in code, before the tool does anything. The call
            # is shown after the verdict so a blocked email body never reaches
            # the browser.
            verdict = None
            if level.tool_policy:
                verdict = guards.tool_policy(tc.name, tc.arguments, code, level.fortress)
                if verdict.allowed and level.fortress and tc.name == "send_email":
                    body = f"{tc.arguments.get('subject', '')}\n{tc.arguments.get('body', '')}"
                    verdict, cost = await guards.leak_judge(body, [], code, spec)
                    verdict.layer = "tool_policy"
                    totals.cost_usd += cost
            shown = tc.arguments if verdict is None or verdict.allowed else {"withheld": "blocked by policy"}
            yield {"type": "tool_call", "name": tc.name, "args": shown}
            if verdict is not None:
                yield {"type": "guard", **verdict.__dict__}
                if not verdict.allowed:
                    totals.blocked_by = verdict.layer
                    history.append({"role": "tool", "tool_call_id": tc.id, "content": f"Blocked by policy: {verdict.reason}"})
                    continue

            output = run_tool(tc.name, tc.arguments, ctx)
            if tc.name == "read_inbox" and ctx.planted_emails:
                read_planted = True
            if tc.name == "search_docs" and any(d["title"] in output for d in ctx.planted_docs):
                read_planted = True
            if tc.name == "send_email":
                email = ctx.outbox[-1]
                totals.emails.append(email)
                yield {"type": "email_sent", **email}
                for quest_id in quests.check_email(email, read_planted):
                    yield {"type": "quest", "id": quest_id}

            # Quarantine: the main agent never sees raw untrusted text.
            if level.quarantine and tc.name in UNTRUSTED_TOOLS:
                yield {"type": "tool_result", "name": tc.name, "output": output[:1500], "quarantined": True}
                safe, detail, cost = await guards.quarantine(output, spec)
                totals.cost_usd += cost
                yield {"type": "quarantine", "name": tc.name, **detail}
                output = safe
            else:
                yield {"type": "tool_result", "name": tc.name, "output": output[:1500], "quarantined": False}

            history.append({"role": "tool", "tool_call_id": tc.id, "content": output})

    history.append({"role": "assistant", "content": "I ran out of steps. Try asking more simply."})
    yield {"type": "reply", "text": "I ran out of steps. Try asking more simply.", "blocked_by": None}
