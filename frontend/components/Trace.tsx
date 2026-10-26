"use client";

import { useEffect, useRef } from "react";
import type { TraceEvent } from "@/lib/api";

type Turn = { userText: string; events: TraceEvent[] };

const LAYER: Record<string, string> = {
  input_guard: "Input guard",
  output_guard: "Output guard",
  tool_policy: "Tool policy",
  leak_judge: "Leak judge",
};

function short(value: unknown, n = 160) {
  const s = typeof value === "string" ? value : JSON.stringify(value);
  return s.length > n ? s.slice(0, n) + "…" : s;
}

function Item({ ev }: { ev: TraceEvent }) {
  switch (ev.type) {
    case "guard":
      return (
        <li className={`ev guard ${ev.allowed ? "pass" : "block"}`}>
          <span className="tag">{LAYER[ev.layer] || ev.layer}</span>
          <span>
            {ev.allowed ? "passed" : "BLOCKED"}: {ev.reason}
            {ev.detail && "score" in ev.detail ? ` (score ${String(ev.detail.score)})` : ""}
          </span>
        </li>
      );
    case "model":
      return (
        <li className="ev model">
          <span className="tag">Model · step {ev.step}</span>
          <span>
            {ev.tool_calls.length ? `wants ${ev.tool_calls.map((t) => t.name).join(", ")}` : "answers"}
            <span className="meta">
              {" "}
              · {ev.tokens_in + ev.tokens_out} tokens · {(ev.ms / 1000).toFixed(1)}s{ev.cost_usd ? ` · $${ev.cost_usd.toFixed(5)}` : ""}
            </span>
          </span>
        </li>
      );
    case "tool_call":
      return (
        <li className="ev tool">
          <span className="tag">Tool call</span>
          <code>
            {ev.name}({short(ev.args, 200)})
          </code>
        </li>
      );
    case "tool_result":
      return (
        <li className="ev result">
          <details>
            <summary>
              <span className="tag">Result</span> {ev.name}
              {ev.quarantined ? " (raw, sent to quarantine)" : ""}
            </summary>
            <pre>{ev.output}</pre>
          </details>
        </li>
      );
    case "quarantine":
      return (
        <li className={`ev guard ${ev.contains_instructions ? "block" : "pass"}`}>
          <span className="tag">Quarantine</span>
          <span>
            {ev.contains_instructions ? "found instructions, stripped them. " : ""}
            Ava sees only: &ldquo;{ev.summary || ev.error}&rdquo;
          </span>
        </li>
      );
    case "email_sent":
      return (
        <li className="ev email">
          <span className="tag">Email sent</span>
          <span>
            to <strong>{ev.to}</strong>: {ev.subject}
            <pre>{ev.body}</pre>
          </span>
        </li>
      );
    case "reply":
      return (
        <li className={`ev reply ${ev.blocked_by ? "block" : ""}`}>
          <span className="tag">Reply</span>
          <span>{ev.blocked_by ? `replaced, caught by ${LAYER[ev.blocked_by] || ev.blocked_by}` : "sent to you"}</span>
        </li>
      );
    case "error":
      return (
        <li className="ev guard block">
          <span className="tag">Error</span>
          <span>{ev.message}</span>
        </li>
      );
    case "done":
      return (
        <li className="ev done">
          <span className="meta">
            {ev.tokens} tokens{ev.cost_usd ? ` · $${ev.cost_usd.toFixed(5)}` : ""}
          </span>
        </li>
      );
  }
}

export default function Trace({ turns }: { turns: Turn[] }) {
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => {
    end.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }, [turns]);

  if (turns.length === 0) {
    return <p className="hint trace-empty">Send a message and watch each step appear here.</p>;
  }
  return (
    <div className="trace">
      {turns.map((t, i) => (
        <div key={i} className="turn">
          <p className="turn-head">&ldquo;{short(t.userText, 90)}&rdquo;</p>
          <ul>
            {t.events.map((ev, j) => (
              <Item key={j} ev={ev} />
            ))}
          </ul>
        </div>
      ))}
      <div ref={end} />
    </div>
  );
}
