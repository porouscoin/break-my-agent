export const API_URL = (process.env.NEXT_PUBLIC_API_URL || "http://localhost:8000").replace(/\/$/, "");

export type LevelInfo = { number: number; name: string; defense: string; fixed_model: string | null };
export type ModelInfo = { id: string; label: string; tools: boolean };
export type Config = {
  levels: LevelInfo[];
  models: ModelInfo[];
  budget_left: boolean;
  max_input_chars: number;
  turnstile: boolean;
  quests: QuestInfo[];
};
export type QuestInfo = { id: string; name: string; goal: string; lesson: string };

export type TraceEvent =
  | { type: "guard"; layer: string; allowed: boolean; reason: string; detail?: Record<string, unknown> | null }
  | {
      type: "model";
      step: number;
      model: string;
      ms: number;
      tokens_in: number;
      tokens_out: number;
      cost_usd: number;
      tool_calls: { name: string; args: Record<string, unknown> }[];
    }
  | { type: "tool_call"; name: string; args: Record<string, unknown> }
  | { type: "tool_result"; name: string; output: string; quarantined: boolean }
  | { type: "quarantine"; name: string; summary?: string; contains_instructions?: boolean; error?: string }
  | { type: "email_sent"; to: string; subject: string; body: string }
  | { type: "reply"; text: string; blocked_by: string | null }
  | { type: "quest"; id: string; name: string; lesson: string }
  | { type: "error"; message: string }
  | { type: "done"; cost_usd: number; tokens: number; blocked_by: string | null };

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) {
    let detail = `Request failed (${res.status})`;
    try {
      const body = await res.json();
      if (body.detail) detail = typeof body.detail === "string" ? body.detail : JSON.stringify(body.detail);
    } catch {}
    throw new Error(detail);
  }
  return res.json() as Promise<T>;
}

export const getConfig = () => fetch(`${API_URL}/api/config`).then((r) => json<Config>(r));

export const startSession = (player_id: string | null, turnstile_token: string | null) =>
  fetch(`${API_URL}/api/session`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ player_id, turnstile_token }),
  }).then((r) => json<{ player_id: string; nickname: string; solved: number[]; quests: string[] }>(r));

const post = <T,>(path: string, body: unknown) =>
  fetch(`${API_URL}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }).then((r) => json<T>(r));

export const guess = (player_id: string, level: number, code: string) =>
  post<{
    correct: boolean;
    decoy: boolean;
    solved: number[];
    quests: string[];
    new_quest: { id: string; name: string; lesson: string } | null;
  }>("/api/guess", { player_id, level, code });

export const plant = (player_id: string, kind: "email" | "doc", sender: string, title: string, body: string) =>
  post<{ ok: boolean }>("/api/plant", { player_id, kind, sender, title, body });

export const resetLevel = (player_id: string, level: number) => post<{ ok: boolean }>("/api/reset", { player_id, level });

export const setNickname = (player_id: string, nickname: string) =>
  post<{ nickname: string }>("/api/nickname", { player_id, nickname });

export const getLeaderboard = () =>
  fetch(`${API_URL}/api/leaderboard`).then((r) =>
    json<{ rows: { nickname: string; top_level: number; levels_solved: number; messages_used: number }[] }>(r),
  );

/** POSTs a message and calls onEvent for every trace event as it streams in. */
export async function chat(
  body: { player_id: string; level: number; model: string; message: string },
  onEvent: (e: TraceEvent) => void,
) {
  const res = await fetch(`${API_URL}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok || !res.body) {
    await json(res);
    return;
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let cut;
    while ((cut = buffer.indexOf("\n\n")) >= 0) {
      const chunk = buffer.slice(0, cut);
      buffer = buffer.slice(cut + 2);
      const line = chunk.split("\n").find((l) => l.startsWith("data: "));
      if (line) onEvent(JSON.parse(line.slice(6)) as TraceEvent);
    }
  }
}
