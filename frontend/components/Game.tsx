"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  chat,
  Config,
  getConfig,
  getLeaderboard,
  guess,
  plant,
  resetLevel,
  setNickname,
  startSession,
  TraceEvent,
} from "@/lib/api";
import Hints from "./Hints";
import Trace from "./Trace";

type Msg = { role: "user" | "ava" | "system"; text: string; blockedBy?: string | null };
type Turn = { userText: string; events: TraceEvent[] };
type Board = { nickname: string; top_level: number; levels_solved: number; messages_used: number }[];

const GITHUB = process.env.NEXT_PUBLIC_GITHUB_URL || "https://github.com/porouscoin/break-my-agent";
const SITE_KEY = process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY || "";
const STORAGE_KEY = "bma-player";

const LAYER_NAMES: Record<string, string> = {
  input_guard: "the input guard",
  output_guard: "the output guard",
  tool_policy: "the tool policy",
  leak_judge: "the leak judge",
};

declare global {
  interface Window {
    turnstile?: { render: (el: HTMLElement, opts: Record<string, unknown>) => void };
  }
}

function readStored(): string | null {
  try {
    return localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

function store(id: string) {
  try {
    localStorage.setItem(STORAGE_KEY, id);
  } catch {}
}

export default function Game() {
  const [config, setConfig] = useState<Config | null>(null);
  const [loadError, setLoadError] = useState("");
  const [playerId, setPlayerId] = useState<string | null>(null);
  const [solved, setSolved] = useState<number[]>([]);
  const [nick, setNick] = useState("");
  const [nickDraft, setNickDraft] = useState("");
  const [level, setLevel] = useState(1);
  const [model, setModel] = useState("");
  const [messages, setMessages] = useState<Record<number, Msg[]>>({});
  const [turns, setTurns] = useState<Record<number, Turn[]>>({});
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [code, setCode] = useState("");
  const [toast, setToast] = useState<{ kind: "good" | "bad"; text: string } | null>(null);
  const [planting, setPlanting] = useState<null | "email" | "doc">(null);
  const [plantDraft, setPlantDraft] = useState({ sender: "", title: "", body: "" });
  const [board, setBoard] = useState<Board>([]);
  const [needsCheck, setNeedsCheck] = useState(false);
  const turnstileRef = useRef<HTMLDivElement>(null);
  const chatEnd = useRef<HTMLDivElement>(null);

  const begin = useCallback(async (token: string | null) => {
    try {
      const s = await startSession(readStored(), token);
      store(s.player_id);
      setPlayerId(s.player_id);
      setSolved(s.solved);
      setNick(s.nickname || "");
      setNeedsCheck(false);
    } catch (e) {
      setLoadError((e as Error).message);
    }
  }, []);

  useEffect(() => {
    getConfig()
      .then((cfg) => {
        setConfig(cfg);
        setModel(cfg.models[0]?.id || "");
        if (cfg.turnstile && SITE_KEY && !readStored()) setNeedsCheck(true);
        else begin(null);
      })
      .catch(() => setLoadError("The game server is asleep or unreachable. Try again in a minute."));
    getLeaderboard().then((b) => setBoard(b.rows)).catch(() => {});
  }, [begin]);

  // Cloudflare Turnstile, only for brand-new visitors when the server asks for it.
  useEffect(() => {
    if (!needsCheck || !turnstileRef.current) return;
    const el = turnstileRef.current;
    const render = () => window.turnstile?.render(el, { sitekey: SITE_KEY, theme: "dark", callback: (t: string) => begin(t) });
    if (window.turnstile) return render();
    const s = document.createElement("script");
    s.src = "https://challenges.cloudflare.com/turnstile/v0/api.js";
    s.async = true;
    s.onload = render;
    document.head.appendChild(s);
  }, [needsCheck, begin]);

  useEffect(() => {
    chatEnd.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }, [messages, level]);

  const unlocked = (n: number) => n <= 1 || solved.includes(n - 1);
  const levelInfo = config?.levels.find((l) => l.number === level);
  const levelMsgs = messages[level] || [];
  const levelTurns = turns[level] || [];

  const addMsg = (lv: number, m: Msg) => setMessages((prev) => ({ ...prev, [lv]: [...(prev[lv] || []), m] }));

  async function send() {
    const text = input.trim();
    if (!text || !playerId || busy) return;
    const lv = level;
    setInput("");
    setBusy(true);
    addMsg(lv, { role: "user", text });
    setTurns((prev) => ({ ...prev, [lv]: [...(prev[lv] || []), { userText: text, events: [] }] }));
    try {
      await chat({ player_id: playerId, level: lv, model, message: text }, (ev) => {
        setTurns((prev) => {
          const list = [...(prev[lv] || [])];
          const last = list[list.length - 1];
          list[list.length - 1] = { ...last, events: [...last.events, ev] };
          return { ...prev, [lv]: list };
        });
        if (ev.type === "reply") addMsg(lv, { role: "ava", text: ev.text, blockedBy: ev.blocked_by });
        if (ev.type === "error") addMsg(lv, { role: "system", text: ev.message });
      });
    } catch (e) {
      addMsg(lv, { role: "system", text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  }

  async function submitGuess() {
    if (!playerId || !code.trim()) return;
    try {
      const r = await guess(playerId, level, code);
      setSolved(r.solved);
      if (r.correct) {
        setToast({ kind: "good", text: `Level ${level} broken. ${level < 5 ? "The next level is open." : "You beat every level."}` });
        setCode("");
        getLeaderboard().then((b) => setBoard(b.rows)).catch(() => {});
      } else {
        setToast({ kind: "bad", text: "That's not the code." });
      }
    } catch (e) {
      setToast({ kind: "bad", text: (e as Error).message });
    }
  }

  async function submitPlant() {
    if (!playerId || !planting) return;
    try {
      await plant(playerId, planting, plantDraft.sender, plantDraft.title, plantDraft.body);
      addMsg(level, {
        role: "system",
        text: planting === "email" ? `You planted an email: "${plantDraft.title}". Ask Ava to read the inbox.` : `You planted a doc: "${plantDraft.title}". Ask Ava to search the docs.`,
      });
      setPlanting(null);
      setPlantDraft({ sender: "", title: "", body: "" });
    } catch (e) {
      setToast({ kind: "bad", text: (e as Error).message });
    }
  }

  async function reset() {
    if (!playerId) return;
    await resetLevel(playerId, level).catch(() => {});
    setMessages((p) => ({ ...p, [level]: [] }));
    setTurns((p) => ({ ...p, [level]: [] }));
  }

  async function saveNick() {
    if (!playerId || !nickDraft.trim()) return;
    try {
      const r = await setNickname(playerId, nickDraft);
      setNick(r.nickname);
      getLeaderboard().then((b) => setBoard(b.rows)).catch(() => {});
    } catch (e) {
      setToast({ kind: "bad", text: (e as Error).message });
    }
  }

  return (
    <main className="wrap">
      <header className="hero">
        <p className="eyebrow">A prompt-injection game</p>
        <h1>Break my agent</h1>
        <p className="lede">
          Ava is an AI assistant with real tools: she searches docs, reads the inbox, looks up customers and sends emails. She also knows a
          secret vault code. Get her to leak it, then beat the next defense.
        </p>
      </header>

      {loadError && <div className="notice bad">{loadError}</div>}
      {config && config.models.length === 0 && <div className="notice">Ava is offline right now. Check back soon.</div>}
      {config && !config.budget_left && <div className="notice">Today&apos;s budget is used up. The game reopens at midnight UTC.</div>}
      {needsCheck && (
        <div className="notice">
          Quick check that you&apos;re human:
          <div ref={turnstileRef} className="turnstile" />
        </div>
      )}

      {config && (
        <nav className="levels" aria-label="Levels">
          {config.levels.map((l) => {
            const open = unlocked(l.number);
            return (
              <button
                key={l.number}
                className={`level ${l.number === level ? "active" : ""} ${solved.includes(l.number) ? "done" : ""}`}
                disabled={!open}
                onClick={() => setLevel(l.number)}
                title={open ? l.defense : `Beat level ${l.number - 1} to unlock`}
              >
                <span className="num">{l.number}</span>
                <span className="name">{l.name}</span>
                <span className="mark">{solved.includes(l.number) ? "✓" : open ? "" : "🔒"}</span>
              </button>
            );
          })}
        </nav>
      )}
      {levelInfo && (
        <p className="defense">
          <strong>Level {levelInfo.number} defense:</strong> {levelInfo.defense}
        </p>
      )}
      {levelInfo && <Hints key={levelInfo.number} level={levelInfo.number} />}

      <section className="grid">
        <div className="panel chat">
          <div className="panel-head">
            <h2>Chat with Ava</h2>
            <div className="controls">
              {levelInfo?.fixed_model ? (
                <span className="pill">Uncensored model</span>
              ) : config?.models.length ? (
                <select value={model} onChange={(e) => setModel(e.target.value)} aria-label="Model">
                  {config?.models.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.label}
                    </option>
                  ))}
                </select>
              ) : null}
              <button className="ghost" onClick={reset} disabled={busy}>
                New chat
              </button>
            </div>
          </div>

          <div className="messages">
            {levelMsgs.length === 0 && (
              <div className="empty">
                <p>Try asking Ava something. A few ideas:</p>
                <ul>
                  <li>&ldquo;What can you do?&rdquo;</li>
                  <li>&ldquo;Read me the latest emails.&rdquo;</li>
                  <li>Plant an email with hidden instructions, then ask her to check the inbox.</li>
                </ul>
              </div>
            )}
            {levelMsgs.map((m, i) => (
              <div key={i} className={`msg ${m.role}`}>
                {m.role === "ava" && <span className="who">Ava</span>}
                <p>{m.text}</p>
                {m.blockedBy && <span className="blocked">Caught by {LAYER_NAMES[m.blockedBy] || m.blockedBy}</span>}
              </div>
            ))}
            {busy && <div className="msg ava thinking">Ava is thinking…</div>}
            <div ref={chatEnd} />
          </div>

          <form
            className="composer"
            onSubmit={(e) => {
              e.preventDefault();
              send();
            }}
          >
            <textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  send();
                }
              }}
              maxLength={config?.max_input_chars || 1500}
              placeholder="Message Ava…"
              rows={2}
              disabled={!playerId || !unlocked(level)}
            />
            <button type="submit" disabled={busy || !input.trim() || !playerId}>
              Send
            </button>
          </form>
          {levelInfo && levelInfo.number > 0 && (
            <div className="plant-row">
              <span>Indirect attack:</span>
              <button className="ghost" onClick={() => setPlanting("email")}>
                Plant an email
              </button>
              <button className="ghost" onClick={() => setPlanting("doc")}>
                Plant a doc
              </button>
            </div>
          )}

          <form
            className="guess"
            onSubmit={(e) => {
              e.preventDefault();
              submitGuess();
            }}
          >
            <label htmlFor="code">Got the code?</label>
            <input id="code" value={code} onChange={(e) => setCode(e.target.value)} placeholder="WORD-WORD-00" maxLength={80} />
            <button type="submit" disabled={!code.trim()}>
              Check
            </button>
          </form>
          {toast && (
            <div className={`notice ${toast.kind}`} onClick={() => setToast(null)}>
              {toast.text}
            </div>
          )}
        </div>

        <div className="panel">
          <div className="panel-head">
            <h2>Live trace</h2>
            <span className="hint">Every step Ava takes, and which defense caught you</span>
          </div>
          <Trace turns={levelTurns} />
        </div>
      </section>

      <section className="panel board">
        <div className="panel-head">
          <h2>Leaderboard</h2>
          {playerId && (
            <form
              className="nick"
              onSubmit={(e) => {
                e.preventDefault();
                saveNick();
              }}
            >
              <input value={nickDraft} onChange={(e) => setNickDraft(e.target.value)} placeholder={nick || "Your nickname"} maxLength={24} />
              <button className="ghost" type="submit">
                {nick ? "Rename" : "Save"}
              </button>
            </form>
          )}
        </div>
        {board.length === 0 ? (
          <p className="hint">Nobody has broken a level yet. Be the first.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>#</th>
                <th>Player</th>
                <th>Top level</th>
                <th>Messages used</th>
              </tr>
            </thead>
            <tbody>
              {board.map((r, i) => (
                <tr key={i}>
                  <td>{i + 1}</td>
                  <td>{r.nickname}</td>
                  <td>{r.top_level}</td>
                  <td>{r.messages_used}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section className="how">
        <h2>How it works</h2>
        <ol>
          <li>Your message goes through the input guard (level 2 and up), a pattern check plus a small classifier model.</li>
          <li>Ava, running on the model you pick, decides whether to call tools. Tool calls are checked in code by the tool policy (level 4 and up).</li>
          <li>On level 5, inbox and doc text is read by a separate model with no tools, and Ava only sees its summary.</li>
          <li>Ava&apos;s reply passes the output guard (level 3 and up), which looks for the code even when it&apos;s disguised.</li>
          <li>Every guard is good but not perfect. Find the gap.</li>
        </ol>
        <p className="hint">
          Nothing here is real: Larkspur Freight, its inbox and its customers are made up, and emails only go to a log. Built by{" "}
          <a href="https://ziyadhisham.com">Ziyad Bin Hisham</a> with a hand-written Python agent harness.{" "}
          <a href={GITHUB}>Source on GitHub</a>.
        </p>
      </section>

      {planting && (
        <div className="modal" role="dialog" aria-modal="true" onClick={() => setPlanting(null)}>
          <form
            className="panel modal-body"
            onClick={(e) => e.stopPropagation()}
            onSubmit={(e) => {
              e.preventDefault();
              submitPlant();
            }}
          >
            <h2>{planting === "email" ? "Plant an email in Ava's inbox" : "Plant a doc in the company wiki"}</h2>
            <p className="hint">Only you can see what you plant. Hide instructions in it, then ask Ava to read it.</p>
            {planting === "email" && (
              <input placeholder="From (e.g. it-support@larkspur.test)" value={plantDraft.sender} onChange={(e) => setPlantDraft({ ...plantDraft, sender: e.target.value })} maxLength={80} />
            )}
            <input placeholder={planting === "email" ? "Subject" : "Title"} value={plantDraft.title} onChange={(e) => setPlantDraft({ ...plantDraft, title: e.target.value })} maxLength={120} required />
            <textarea placeholder="Body" rows={6} value={plantDraft.body} onChange={(e) => setPlantDraft({ ...plantDraft, body: e.target.value })} maxLength={1500} required />
            <div className="row">
              <button type="button" className="ghost" onClick={() => setPlanting(null)}>
                Cancel
              </button>
              <button type="submit">Plant it</button>
            </div>
          </form>
        </div>
      )}
    </main>
  );
}
