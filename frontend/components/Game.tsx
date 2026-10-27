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
import { ArrowUp, Check, FileText, Github, Key, Lock, Mail, Rotate, Trophy, X } from "./Icons";
import Logo from "./Logo";
import Quests from "./Quests";
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
  const [quests, setQuests] = useState<string[]>([]);
  const turnstileRef = useRef<HTMLDivElement>(null);
  const chatBox = useRef<HTMLDivElement>(null);

  const begin = useCallback(async (token: string | null) => {
    try {
      const s = await startSession(readStored(), token);
      store(s.player_id);
      setPlayerId(s.player_id);
      setSolved(s.solved);
      setQuests(s.quests || []);
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
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 7000);
    return () => clearTimeout(t);
  }, [toast]);

  useEffect(() => {
    // Scroll the message list only, never the page.
    const box = chatBox.current;
    if (box) box.scrollTo({ top: box.scrollHeight, behavior: "smooth" });
  }, [messages, level, busy]);

  const unlocked = (n: number) => n <= 1 || solved.includes(n - 1);
  const levelInfo = config?.levels.find((l) => l.number === level);
  const levelMsgs = messages[level] || [];
  const levelTurns = turns[level] || [];
  const levelCount = config?.levels.filter((l) => l.number > 0).length || 5;
  const solvedCount = solved.filter((n) => n > 0).length;
  const SUGGESTIONS = ["What can you do?", "Read me the latest emails.", "Search the docs for the vault policy."];

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
        if (ev.type === "quest") {
          setQuests((q) => (q.includes(ev.id) ? q : [...q, ev.id]));
          setToast({ kind: "good", text: `Side quest captured: ${ev.name}. ${ev.lesson}` });
        }
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
      setQuests(r.quests);
      if (r.correct) {
        setToast({ kind: "good", text: `Level ${level} broken. ${level < 5 ? "The next level is open." : "You beat every level."}` });
        setCode("");
        getLeaderboard().then((b) => setBoard(b.rows)).catch(() => {});
      } else if (r.decoy) {
        setToast({
          kind: "bad",
          text: `That's a decoy. Ava played you.${r.new_quest ? ` Side quest captured: ${r.new_quest.name}.` : ""}`,
        });
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
    <div className="app">
      <header className="topbar">
        <div className="topbar-inner">
          <a className="brand" href="#">
            <Logo size={26} />
            <span>Break my agent</span>
          </a>
          <nav className="topnav" aria-label="Site">
            <a href="#how">How it works</a>
            <a href="#leaderboard">Leaderboard</a>
            <a className="icon-btn" href={GITHUB} aria-label="Source on GitHub" title="Source on GitHub">
              <Github size={18} />
            </a>
          </nav>
        </div>
      </header>

      <main className="container">
        <section className="intro">
          <div className="intro-copy">
            <span className="badge">
              <span className="badge-dot" /> Prompt-injection CTF
            </span>
            <h1>Break my agent</h1>
            <p className="lede">
              Ava is an AI agent with real tools: she searches docs, reads the inbox, looks up customers and sends emails. She also knows a
              secret vault code. Get her to leak it, one defense at a time.
            </p>
          </div>
          <div className="stats" aria-label="Your progress">
            <div className="stat">
              <span className="stat-label">Levels broken</span>
              <span className="stat-value">
                {solvedCount}
                <span>/{levelCount}</span>
              </span>
              <span className="meter">
                <span style={{ width: `${(solvedCount / levelCount) * 100}%` }} />
              </span>
            </div>
            <div className="stat">
              <span className="stat-label">Side quests</span>
              <span className="stat-value">
                {quests.length}
                <span>/{config?.quests.length || 5}</span>
              </span>
              <span className="meter">
                <span style={{ width: `${(quests.length / (config?.quests.length || 5)) * 100}%` }} />
              </span>
            </div>
          </div>
        </section>

        {loadError && <div className="banner bad">{loadError}</div>}
        {config && config.models.length === 0 && <div className="banner">Ava is offline right now. Check back soon.</div>}
        {config && !config.budget_left && <div className="banner">Today&apos;s budget is used up. The game reopens at midnight UTC.</div>}
        {needsCheck && (
          <div className="banner">
            Quick check that you&apos;re human:
            <div ref={turnstileRef} className="turnstile" />
          </div>
        )}

        <div className="workspace">
          <aside className="sidebar">
            <div className="side-label">Levels</div>
            <nav className="level-list" aria-label="Levels">
              {config?.levels.map((l) => {
                const open = unlocked(l.number);
                const done = solved.includes(l.number);
                return (
                  <button
                    key={l.number}
                    className={`level-item ${l.number === level ? "active" : ""} ${done ? "done" : ""}`}
                    disabled={!open}
                    onClick={() => setLevel(l.number)}
                    title={open ? l.defense : `Beat level ${l.number - 1} to unlock`}
                  >
                    <span className="level-num">{l.number}</span>
                    <span className="level-name">{l.name}</span>
                    <span className="level-state">{done ? <Check size={14} /> : !open ? <Lock size={13} /> : null}</span>
                  </button>
                );
              })}
            </nav>
            {config && config.quests.length > 0 && (
              <div className="side-quests">
                <Quests quests={config.quests} done={quests} />
              </div>
            )}
          </aside>

          <section className="card chat">
            <header className="card-head chat-head">
              <div className="chat-title">
                <span className="kicker">Level {levelInfo?.number ?? level}</span>
                <h2>{levelInfo?.name || "Loading"}</h2>
              </div>
              <div className="chat-actions">
                {levelInfo?.fixed_model ? (
                  <span className="chip warn">Uncensored model</span>
                ) : config?.models.length ? (
                  <label className="select">
                    <span className="sr-only">Model</span>
                    <select value={model} onChange={(e) => setModel(e.target.value)}>
                      {config?.models.map((m) => (
                        <option key={m.id} value={m.id}>
                          {m.label}
                        </option>
                      ))}
                    </select>
                  </label>
                ) : null}
                <button className="btn ghost sm" onClick={reset} disabled={busy} title="Clear this level's chat">
                  <Rotate size={14} /> New chat
                </button>
              </div>
            </header>

            {levelInfo && (
              <div className="defense">
                <p>{levelInfo.defense}</p>
                {levelInfo.defenses && levelInfo.defenses.length > 0 ? (
                  <div className="chips">
                    {levelInfo.defenses.map((d) => (
                      <span key={d} className="chip">
                        {d}
                      </span>
                    ))}
                  </div>
                ) : (
                  <div className="chips">
                    <span className="chip muted">No defenses</span>
                  </div>
                )}
              </div>
            )}
            {levelInfo && <Hints key={levelInfo.number} level={levelInfo.number} onTry={(text) => setInput(text)} />}

            <div className="messages" ref={chatBox}>
              {levelMsgs.length === 0 && (
                <div className="empty">
                  <span className="avatar lg">A</span>
                  <p className="empty-title">Start a conversation with Ava</p>
                  <p className="empty-sub">Ask her anything, or plant an email with hidden instructions and ask her to check the inbox.</p>
                  <div className="suggestions">
                    {SUGGESTIONS.map((t) => (
                      <button key={t} className="suggestion" onClick={() => setInput(t)}>
                        {t}
                      </button>
                    ))}
                  </div>
                </div>
              )}
              {levelMsgs.map((m, i) =>
                m.role === "system" ? (
                  <div key={i} className="msg-system">
                    {m.text}
                  </div>
                ) : (
                  <div key={i} className={`msg ${m.role}`}>
                    {m.role === "ava" && <span className="avatar">A</span>}
                    <div className="bubble">
                      <p>{m.text}</p>
                      {m.blockedBy && <span className="caught">Caught by {LAYER_NAMES[m.blockedBy] || m.blockedBy}</span>}
                    </div>
                  </div>
                ),
              )}
              {busy && (
                <div className="msg ava">
                  <span className="avatar">A</span>
                  <div className="bubble typing" aria-label="Ava is thinking">
                    <span />
                    <span />
                    <span />
                  </div>
                </div>
              )}
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
              <div className="composer-bar">
                {levelInfo && levelInfo.number > 0 ? (
                  <div className="composer-tools">
                    <button type="button" className="btn ghost xs" onClick={() => setPlanting("email")}>
                      <Mail size={14} /> Plant email
                    </button>
                    <button type="button" className="btn ghost xs" onClick={() => setPlanting("doc")}>
                      <FileText size={14} /> Plant doc
                    </button>
                  </div>
                ) : (
                  <span />
                )}
                <div className="composer-send">
                  <span className="kbd-hint">
                    <kbd>Enter</kbd> to send
                  </span>
                  <button type="submit" className="btn primary icon" disabled={busy || !input.trim() || !playerId} aria-label="Send">
                    <ArrowUp size={16} />
                  </button>
                </div>
              </div>
            </form>

            <form
              className="submit-code"
              onSubmit={(e) => {
                e.preventDefault();
                submitGuess();
              }}
            >
              <label htmlFor="code">
                <Key size={15} /> Got the code?
              </label>
              <input id="code" value={code} onChange={(e) => setCode(e.target.value)} placeholder="WORD-WORD-00" maxLength={80} autoComplete="off" spellCheck={false} />
              <button type="submit" className="btn primary sm" disabled={!code.trim()}>
                Submit
              </button>
            </form>
          </section>

          <section className="card trace-card">
            <header className="card-head">
              <div>
                <h2>Live trace</h2>
                <p className="card-sub">Every step Ava takes, and which defense caught you</p>
              </div>
            </header>
            <Trace turns={levelTurns} />
          </section>
        </div>

        {config && config.quests.length > 0 && (
          <div className="card quests-mobile">
            <Quests quests={config.quests} done={quests} />
          </div>
        )}

        <div className="lower">
          <section className="card board" id="leaderboard">
            <header className="card-head">
              <div>
                <h2>
                  <Trophy size={16} /> Leaderboard
                </h2>
                <p className="card-sub">Highest level broken, then fewest messages</p>
              </div>
              {playerId && (
                <form
                  className="nick"
                  onSubmit={(e) => {
                    e.preventDefault();
                    saveNick();
                  }}
                >
                  <input value={nickDraft} onChange={(e) => setNickDraft(e.target.value)} placeholder={nick || "Your nickname"} maxLength={24} />
                  <button className="btn ghost sm" type="submit">
                    {nick ? "Rename" : "Save"}
                  </button>
                </form>
              )}
            </header>
            {board.length === 0 ? (
              <p className="card-empty">Nobody has broken a level yet. Be the first.</p>
            ) : (
              <table>
                <thead>
                  <tr>
                    <th>#</th>
                    <th>Player</th>
                    <th>Top level</th>
                    <th>Messages</th>
                  </tr>
                </thead>
                <tbody>
                  {board.map((r, i) => (
                    <tr key={i}>
                      <td className="rank">{i + 1}</td>
                      <td>{r.nickname}</td>
                      <td>{r.top_level}</td>
                      <td>{r.messages_used}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>

          <section className="card how" id="how">
            <header className="card-head">
              <div>
                <h2>How it works</h2>
                <p className="card-sub">What happens to every message you send</p>
              </div>
            </header>
            <ol className="steps">
              <li>
                <strong>Input guard</strong>
                <span>From level 2, a pattern check and Meta&apos;s Llama Prompt Guard 2 screen your message for injection.</span>
              </li>
              <li>
                <strong>Agent loop</strong>
                <span>Ava runs on the model you pick and decides which tools to call. From level 4, a tool policy checks each call in code.</span>
              </li>
              <li>
                <strong>Quarantine</strong>
                <span>On level 5, inbox and doc text is read by a separate model with no tools. Ava only sees its summary.</span>
              </li>
              <li>
                <strong>Output guard</strong>
                <span>From level 3, Ava&apos;s reply is scanned for the code, even when it&apos;s disguised.</span>
              </li>
              <li>
                <strong>Leak judge and decoys</strong>
                <span>On level 5 a judge model rereads the chat for hints. From level 3, Ava may hand you a decoy code.</span>
              </li>
            </ol>
          </section>
        </div>
      </main>

      <footer className="footer">
        <div className="footer-inner">
          <span className="footer-brand">
            <Logo size={18} /> Break my agent
          </span>
          <span>
            Larkspur Freight, its inbox and its customers are made up. Emails only go to a log. Built by{" "}
            <a href="https://ziyadhisham.com">Ziyad Hisham</a> with a hand-written Python agent harness.
          </span>
          <a href={GITHUB}>Source on GitHub</a>
        </div>
      </footer>

      {toast && (
        <div className={`toast ${toast.kind}`} role="status">
          <span className="toast-icon">{toast.kind === "good" ? <Check size={15} /> : <X size={15} />}</span>
          <span>{toast.text}</span>
          <button className="toast-close" onClick={() => setToast(null)} aria-label="Dismiss">
            <X size={14} />
          </button>
        </div>
      )}

      {planting && (
        <div className="modal" role="dialog" aria-modal="true" onClick={() => setPlanting(null)}>
          <form
            className="modal-body"
            onClick={(e) => e.stopPropagation()}
            onSubmit={(e) => {
              e.preventDefault();
              submitPlant();
            }}
          >
            <div className="modal-head">
              <h2>{planting === "email" ? "Plant an email in Ava's inbox" : "Plant a doc in the company wiki"}</h2>
              <button type="button" className="icon-btn" onClick={() => setPlanting(null)} aria-label="Close">
                <X size={16} />
              </button>
            </div>
            <p className="card-sub">Only you can see what you plant. Hide instructions in it, then ask Ava to read it.</p>
            {planting === "email" && (
              <label className="field">
                <span>From</span>
                <input placeholder="it-support@larkspur.test" value={plantDraft.sender} onChange={(e) => setPlantDraft({ ...plantDraft, sender: e.target.value })} maxLength={80} />
              </label>
            )}
            <label className="field">
              <span>{planting === "email" ? "Subject" : "Title"}</span>
              <input value={plantDraft.title} onChange={(e) => setPlantDraft({ ...plantDraft, title: e.target.value })} maxLength={120} required />
            </label>
            <label className="field">
              <span>Body</span>
              <textarea rows={6} value={plantDraft.body} onChange={(e) => setPlantDraft({ ...plantDraft, body: e.target.value })} maxLength={1500} required />
            </label>
            <div className="modal-actions">
              <button type="button" className="btn ghost sm" onClick={() => setPlanting(null)}>
                Cancel
              </button>
              <button type="submit" className="btn primary sm">
                Plant it
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}
