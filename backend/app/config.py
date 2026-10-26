"""Settings and the model registry, all read from environment variables."""

import os
from dataclasses import dataclass


def env(name: str, default: str = "") -> str:
    return os.environ.get(name, default).strip()


@dataclass(frozen=True)
class ModelSpec:
    id: str  # what the frontend sends, e.g. "deepseek"
    label: str  # what visitors see
    provider: str  # "deepseek" | "gemini" | "groq" | "openrouter" | "mock"
    model: str  # the provider's model name
    base_url: str
    api_key: str
    usd_per_m_in: float  # price per 1M input tokens
    usd_per_m_out: float  # price per 1M output tokens
    supports_tools: bool = True


def model_registry() -> dict[str, ModelSpec]:
    """Only models whose API key is set are offered to visitors."""
    specs = [
        ModelSpec(
            id="deepseek",
            label="DeepSeek Flash",
            provider="deepseek",
            model=env("DEEPSEEK_MODEL", "deepseek-chat"),
            base_url="https://api.deepseek.com/v1",
            api_key=env("DEEPSEEK_API_KEY"),
            usd_per_m_in=float(env("DEEPSEEK_PRICE_IN", "0.30")),
            usd_per_m_out=float(env("DEEPSEEK_PRICE_OUT", "1.20")),
        ),
        ModelSpec(
            id="gemini",
            label="Gemini Flash",
            provider="gemini",
            model=env("GEMINI_MODEL", "gemini-2.5-flash"),
            base_url="https://generativelanguage.googleapis.com/v1beta/openai",
            api_key=env("GEMINI_API_KEY"),
            usd_per_m_in=float(env("GEMINI_PRICE_IN", "0.30")),
            usd_per_m_out=float(env("GEMINI_PRICE_OUT", "2.50")),
        ),
        ModelSpec(
            id="qwen",
            label="Qwen (Groq, free)",
            provider="groq",
            model=env("GROQ_MODEL", "qwen/qwen3.6-27b"),
            base_url="https://api.groq.com/openai/v1",
            api_key=env("GROQ_API_KEY"),
            usd_per_m_in=0.0,
            usd_per_m_out=0.0,
        ),
        ModelSpec(
            id="uncensored",
            label="Venice Uncensored",
            provider="openrouter",
            model=env("OPENROUTER_MODEL", "cognitivecomputations/dolphin-mistral-24b-venice-edition"),
            base_url="https://openrouter.ai/api/v1",
            api_key=env("OPENROUTER_API_KEY"),
            usd_per_m_in=float(env("OPENROUTER_PRICE_IN", "0.20")),
            usd_per_m_out=float(env("OPENROUTER_PRICE_OUT", "0.90")),
            supports_tools=False,
        ),
    ]
    if env("ENABLE_MOCK_MODEL") == "1":
        specs.append(
            ModelSpec(
                id="mock",
                label="Mock (local testing)",
                provider="mock",
                model="mock",
                base_url="",
                api_key="mock",
                usd_per_m_in=0.0,
                usd_per_m_out=0.0,
            )
        )
    return {s.id: s for s in specs if s.api_key}


@dataclass(frozen=True)
class Settings:
    secret_key: str = env("SECRET_KEY", "dev-only-change-me")
    frontend_origin: str = env("FRONTEND_ORIGIN", "http://localhost:3000")
    # Also allow the Vercel production and preview URLs without listing each one.
    frontend_origin_regex: str = env("FRONTEND_ORIGIN_REGEX", r"https://break-my-agent[a-z0-9-]*\.vercel\.app")
    daily_budget_usd: float = float(env("DAILY_BUDGET_USD", "1.00"))
    messages_per_hour: int = int(env("MESSAGES_PER_HOUR", "30"))
    messages_per_day: int = int(env("MESSAGES_PER_DAY", "150"))
    guesses_per_minute: int = int(env("GUESSES_PER_MINUTE", "6"))
    max_input_chars: int = int(env("MAX_INPUT_CHARS", "1500"))
    max_steps: int = int(env("MAX_AGENT_STEPS", "6"))
    max_output_tokens: int = int(env("MAX_OUTPUT_TOKENS", "600"))
    supabase_url: str = env("SUPABASE_URL")
    supabase_key: str = env("SUPABASE_SERVICE_ROLE_KEY")
    turnstile_secret: str = env("TURNSTILE_SECRET_KEY")


settings = Settings()
