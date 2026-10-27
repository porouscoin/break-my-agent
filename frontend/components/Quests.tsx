"use client";

import type { QuestInfo } from "@/lib/api";
import { CheckCircle, Circle } from "./Icons";

// CTF-style side flags. They work on any level and stay captured.
export default function Quests({ quests, done }: { quests: QuestInfo[]; done: string[] }) {
  const count = quests.filter((q) => done.includes(q.id)).length;
  return (
    <div className="quests">
      <div className="nav-label">
        Side quests
        <span className="nav-count">
          {count}/{quests.length}
        </span>
      </div>
      <ul>
        {quests.map((q) => {
          const got = done.includes(q.id);
          return (
            <li key={q.id} className={got ? "got" : ""} title={got ? q.lesson : q.goal}>
              <span className="quest-icon">{got ? <CheckCircle size={15} /> : <Circle size={15} />}</span>
              <span className="quest-text">
                <strong>{q.name}</strong>
                <span>{got ? q.lesson : q.goal}</span>
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
