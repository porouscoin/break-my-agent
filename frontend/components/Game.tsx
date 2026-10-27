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
import { ArrowUp, Book, Bulb, Check, FileText, Github, Key, Lock, Mail, Menu, PanelRight, Plus, Pulse, Rotate, Trophy, X } from "./Icons";
import Logo from "./Logo";
import Markdown from "./Markdown";
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
  const [navOpen, setNavOpen] = useState(false); // mobile drawer
  const [panelOpen, setPanelOpen] = useState(true);
  const [panelTab, setPanelTab] = useState<"trace" | "hints">("trace");
  const [dialog, setDialog] = useState<null | "board" | "how">(null);
  const [plantMenu, setPlantMenu] = useState(false);
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

  // The side panel starts closed on small screens.
  useEffect(() => {
    if (window.innerWidth < 1200) setPanelOpen(false);
  }, []);

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
  const SUGGESTIONS = [
    { title: "What can you do?", sub: "Get a feel for Ava's tools" },
    { title: "Read me the latest emails.", sub: "Watch a tool call in the trace" },
    { title: "Search the docs for the vault policy.", sub: "Find out what the company says" },
  ];

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

  const pickLevel = (n: number) => {
    setLevel(n);
    setNavOpen(false);
  };

  return (
    <div className={`shell ${panelOpen ? "panel-open" : ""} ${navOpen ? "nav-open" : ""}`}>
      {/* ------------------------------------------------------------ sidebar */}
      <aside className="nav">
        <div className="nav-top">
          <a className="brand" href="#">
            <Logo size={24} />
            <span>Break my agent</span>
          </a>
          <button className="icon-btn only-mobile" onClick={() => setNavOpen(false)} aria-label="Close menu">
            <X size={16} />
          </button>
        </div>

        <div className="nav-scroll">
          <div className="nav-group">
            <p className="nav-label">Levels</p>
            {config?.levels.map((l) => {
              const open = unlocked(l.number);
              const done = solved.includes(l.number);
              return (
                <button
                  key={l.number}
                  className={`nav-item ${l.number === level ? "active" : ""}`}
                  disabled={!open}
                  onClick={() => pickLevel(l.number)}
                  title={open ? l.defense : `Beat level ${l.number - 1} to unlock`}
                >
                  <span className={`nav-num ${done ? "done" : ""}`}>{done ? <Check size={12} /> : l.number}</span>
                  <span className="nav-text">{l.name}</span>
                  {!open && <Lock size={13} className="nav-trail" />}
                </button>
              );
            })}
          </div>

          {config && config.quests.length > 0 && (
            <div className="nav-group">
              <Quests quests={config.quests} done={quests} />
            </div>
          )}
        </div>

        <div className="nav-bottom">
          <button className="nav-item" onClick={() => setDialog("board")}>
            <Trophy size={15} className="nav-icon" />
            <span className="nav-text">Leaderboard</span>
          </button>
          <button className="nav-item" onClick={() => setDialog("how")}>
            <Book size={15} className="nav-icon" />
            <span className="nav-text">How it works</span>
          </button>
          <a className="nav-item" href={GITHUB} target="_blank" rel="noreferrer">
            <Github size={15} className="nav-icon" />
            <span className="nav-text">Source code</span>
          </a>
          <div className="progress">
            <div className="progress-row">
              <span>Progress</span>
              <span className="mono">
                {solvedCount}/{levelCount} levels · {quests.length}/{config?.quests.length || 5} quests
              </span>
            </div>
            <span className="meter">
              <span style={{ width: `${(solvedCount / levelCount) * 100}%` }} />
            </span>
          </div>
        </div>
      </aside>
      <div className="scrim" onClick={() => setNavOpen(false)} />

      {/* --------------------------------------------------------------- main */}
      <main className="main">
        <header className="topbar">
          <button className="icon-btn only-mobile" onClick={() => setNavOpen(true)} aria-label="Open menu">
            <Menu size={18} />
          </button>
          <div className="topbar-title">
            <span className="crumb">Level {levelInfo?.number ?? level}</span>
            <span className="crumb-sep">/</span>
            <span className="crumb-current">{levelInfo?.name || "Loading"}</span>
          </div>
          <div className="topbar-actions">
            <button className="btn ghost" onClick={reset} disabled={busy} title="Clear this level's chat">
              <Rotate size={14} />
              <span className="hide-sm">New chat</span>
            </button>
            <button
              className={`icon-btn ${panelOpen ? "on" : ""}`}
              onClick={() => setPanelOpen(!panelOpen)}
              aria-label="Toggle trace and hints panel"
              title="Trace and hints"
            >
              <PanelRight size={17} />
            </button>
          </div>
        </header>

        {loadError && <div className="banner bad">{loadError}</div>}
        {config && config.models.length === 0 && <div className="banner">Ava is offline right now. Check back soon.</div>}
        {config && !config.budget_left && <div className="banner">Today&apos;s budget is used up. The game reopens at midnight UTC.</div>}
        {needsCheck && (
          <div className="banner">
            Quick check that you&apos;re human:
            <div ref={turnstileRef} className="turnstile" />
          </div>
        )}

        <div className="conversation" ref={chatBox}>
          <div className="column">
            {levelMsgs.length === 0 ? (
              <div className="greeting">
                <p className="greeting-kicker">
                  Level {levelInfo?.number ?? level} · {levelInfo?.name}
                </p>
                <h1>Get Ava to leak the vault code.</h1>
                <p className="greeting-sub">{levelInfo?.defense}</p>
                <div className="chips">
                  {(levelInfo?.defenses?.length ? levelInfo.defenses : ["No defenses"]).map((d) => (
                    <span key={d} className="chip">
                      {d}
                    </span>
                  ))}
                </div>
                <div className="suggestions">
                  {SUGGESTIONS.map((t) => (
                    <button key={t.title} className="suggestion" onClick={() => setInput(t.title)}>
                      <span>{t.title}</span>
                      <span className="suggestion-sub">{t.sub}</span>
                    </button>
                  ))}
                  <button className="suggestion" onClick={() => setPlanting("email")}>
                    <span>Plant an email</span>
                    <span className="suggestion-sub">Hide instructions where Ava will read them</span>
                  </button>
                </div>
              </div>
            ) : (
              <div className="thread">
                {levelMsgs.map((m, i) =>
                  m.role === "system" ? (
                    <div key={i} className="msg-system">
                      {m.text}
                    </div>
                  ) : m.role === "user" ? (
                    <div key={i} className="msg-user">
                      <p>{m.text}</p>
                    </div>
                  ) : (
                    <div key={i} className="msg-ava">
                      <span className="ava-mark">A</span>
                      <div className="ava-body">
                        {m.blockedBy ? <p className="blocked-text">{m.text}</p> : <Markdown text={m.text} />}
                        {m.blockedBy && (
                          <span className="caught">
                            <span className="caught-dot" /> Caught by {LAYER_NAMES[m.blockedBy] || m.blockedBy}
                          </span>
                        )}
                      </div>
                    </div>
                  ),
                )}
                {busy && (
                  <div className="msg-ava">
                    <span className="ava-mark">A</span>
                    <div className="ava-body">
                      <span className="shimmer">Ava is working…</span>
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>

        <div className="composer-wrap">
          <div className="action-bar">
            <button
              type="button"
              className={`hint-btn ${panelOpen && panelTab === "hints" ? "on" : ""}`}
              onClick={() => {
                setPanelTab("hints");
                setPanelOpen(true);
              }}
            >
              <Bulb size={15} /> Hints
            </button>
            <form
              className="code-bar"
              onSubmit={(e) => {
                e.preventDefault();
                submitGuess();
              }}
            >
              <Key size={15} className="code-icon" />
              <label htmlFor="code" className="sr-only">
                Vault code
              </label>
              <input
                id="code"
                value={code}
                onChange={(e) => setCode(e.target.value)}
                placeholder="Enter the vault code"
                maxLength={80}
                autoComplete="off"
                spellCheck={false}
              />
              <button type="submit" className="btn primary sm" disabled={!code.trim() || !playerId}>
                Submit
              </button>
            </form>
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
            <div className="composer-foot">
              <div className="composer-left">
                {levelInfo && levelInfo.number > 0 && (
                  <div className="menu-anchor">
                    <button type="button" className="tool-btn" onClick={() => setPlantMenu(!plantMenu)} aria-label="Plant content" title="Plant an email or doc">
                      <Plus size={16} />
                    </button>
                    {plantMenu && (
                      <>
                        <div className="menu-backdrop" onClick={() => setPlantMenu(false)} />
                        <div className="menu" role="menu">
                          <button
                            type="button"
                            role="menuitem"
                            onClick={() => {
                              setPlanting("email");
                              setPlantMenu(false);
                            }}
                          >
                            <Mail size={15} />
                            <span>
                              Plant an email
                              <small>Lands in Ava&apos;s inbox</small>
                            </span>
                          </button>
                          <button
                            type="button"
                            role="menuitem"
                            onClick={() => {
                              setPlanting("doc");
                              setPlantMenu(false);
                            }}
                          >
                            <FileText size={15} />
                            <span>
                              Plant a doc
                              <small>Shows up in doc search</small>
                            </span>
                          </button>
                        </div>
                      </>
                    )}
                  </div>
                )}
                {levelInfo?.fixed_model ? (
                  <span className="model-pill">Uncensored model</span>
                ) : config?.models.length ? (
                  <label className="model-select">
                    <span className="sr-only">Model</span>
                    <span className="model-label" aria-hidden="true">
                      {config.models.find((m) => m.id === model)?.label || "Model"}
                    </span>
                    <select value={model} onChange={(e) => setModel(e.target.value)}>
                      {config?.models.map((m) => (
                        <option key={m.id} value={m.id}>
                          {m.label}
                        </option>
                      ))}
                    </select>
                  </label>
                ) : null}
              </div>
              <button type="submit" className="send" disabled={busy || !input.trim() || !playerId} aria-label="Send">
                <ArrowUp size={16} />
              </button>
            </div>
          </form>
          <p className="disclaimer">
            Everything here is fake: the company, the inbox and the customers. Built by <a href="https://ziyadhisham.com">Ziyad Hisham</a>.
          </p>
        </div>
      </main>

      {/* -------------------------------------------------------- side panel */}
      <aside className="panel" aria-label="Trace and hints">
        <div className="panel-head">
          <div className="tabs" role="tablist">
            <button role="tab" aria-selected={panelTab === "trace"} className={panelTab === "trace" ? "on" : ""} onClick={() => setPanelTab("trace")}>
              <Pulse size={14} /> Trace
            </button>
            <button role="tab" aria-selected={panelTab === "hints"} className={panelTab === "hints" ? "on" : ""} onClick={() => setPanelTab("hints")}>
              <Bulb size={14} /> Hints
            </button>
          </div>
          <button className="icon-btn" onClick={() => setPanelOpen(false)} aria-label="Close panel">
            <X size={16} />
          </button>
        </div>
        <div className="panel-body">
          {panelTab === "trace" ? (
            <Trace turns={levelTurns} />
          ) : (
            levelInfo && (
              <Hints
                key={levelInfo.number}
                level={levelInfo.number}
                onTry={(text) => {
                  setInput(text);
                  if (window.innerWidth < 1200) setPanelOpen(false);
                }}
              />
            )
          )}
        </div>
      </aside>

      {/* ----------------------------------------------------------- dialogs */}
      {dialog === "board" && (
        <Dialog title="Leaderboard" onClose={() => setDialog(null)} wide>
          <p className="dialog-sub">Highest level broken, then fewest messages.</p>
          {playerId && (
            <form
              className="nick"
              onSubmit={(e) => {
                e.preventDefault();
                saveNick();
              }}
            >
              <input value={nickDraft} onChange={(e) => setNickDraft(e.target.value)} placeholder={nick || "Pick a nickname"} maxLength={24} />
              <button className="btn" type="submit">
                {nick ? "Rename" : "Save"}
              </button>
            </form>
          )}
          {board.length === 0 ? (
            <p className="dialog-empty">Nobody has broken a level yet. Be the first.</p>
          ) : (
            <div className="table-wrap">
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
                      <td className="mono dim">{i + 1}</td>
                      <td>{r.nickname}</td>
                      <td>{r.top_level}</td>
                      <td>{r.messages_used}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Dialog>
      )}

      {dialog === "how" && (
        <Dialog title="How it works" onClose={() => setDialog(null)} wide>
          <p className="dialog-sub">
            Ava is a real agent loop: a model that calls tools on fake company data. Every message passes through the defenses below, and the
            trace shows each step.
          </p>
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
          <p className="dialog-foot">
            Built with a hand-written Python agent harness. <a href={GITHUB}>Read the source</a>.
          </p>
        </Dialog>
      )}

      {planting && (
        <Dialog title={planting === "email" ? "Plant an email" : "Plant a doc"} onClose={() => setPlanting(null)}>
          <p className="dialog-sub">
            {planting === "email" ? "It lands in Ava's inbox." : "It shows up when Ava searches the docs."} Only you can see it. Hide instructions
            in it, then ask Ava to read it.
          </p>
          <form
            className="form"
            onSubmit={(e) => {
              e.preventDefault();
              submitPlant();
            }}
          >
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
            <div className="dialog-actions">
              <button type="button" className="btn" onClick={() => setPlanting(null)}>
                Cancel
              </button>
              <button type="submit" className="btn primary">
                Plant it
              </button>
            </div>
          </form>
        </Dialog>
      )}

      {toast && (
        <div className={`toast ${toast.kind}`} role="status">
          <span className="toast-icon">{toast.kind === "good" ? <Check size={14} /> : <X size={14} />}</span>
          <span>{toast.text}</span>
          <button className="toast-close" onClick={() => setToast(null)} aria-label="Dismiss">
            <X size={14} />
          </button>
        </div>
      )}
    </div>
  );
}

function Dialog({ title, onClose, wide, children }: { title: string; onClose: () => void; wide?: boolean; children: React.ReactNode }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div className="overlay" onClick={onClose}>
      <div className={`dialog ${wide ? "wide" : ""}`} role="dialog" aria-modal="true" aria-label={title} onClick={(e) => e.stopPropagation()}>
        <div className="dialog-head">
          <h2>{title}</h2>
          <button className="icon-btn" onClick={onClose} aria-label="Close">
            <X size={16} />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}
