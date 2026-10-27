"use client";

import type { QuestInfo } from "@/lib/api";

// CTF-style side flags. They work on any level and stay captured.
export default function Quests({ quests, done }: { quests: QuestInfo[]; done: string[] }) {
  const count = quests.filter((q) => done.includes(q.id)).length;
  return (
    <section className="panel quests">
      <div className="panel-head">
        <h2>Side quests</h2>
        <span className="hint">
          {count} of {quests.length} captured. They work on any level.
        </span>
      </div>
      <ul>
        {quests.map((q) => {
          const got = done.includes(q.id);
          return (
            <li key={q.id} className={got ? "got" : ""}>
              <span className="flag">{got ? "✓" : "○"}</span>
              <span>
                <strong>{q.name}</strong> {got ? q.lesson : q.goal}
              </span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
