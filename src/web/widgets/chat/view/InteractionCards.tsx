// Cards that collect the user's answers to questions and permission decisions mid-turn.
import { useState } from "react";
import { pretty } from "@/shared/lib/format";
import type { QuestionDto } from "@shared/protocol";

// Collect answers to the questions Claude asked before the turn continues.
export function QuestionCard({ value, onSubmit }: { value: { interactionId: string; questions: QuestionDto[] }; onSubmit: (answers: Record<string, string[]>) => void }) {
  const [answers, setAnswers] = useState<Record<string, string[]>>({});
  const [custom, setCustom] = useState<Record<string, string>>( {} );
  // Select or deselect one option, honouring each question's multi-select behavior.
  const toggle = (question: QuestionDto, label: string) =>setAnswers((current) => {
    const selected = current[question.question] || [];
    return { ...current, [question.question]: question.multiSelect ? selected.includes(label) ? selected.filter((item) => item !== label) : [...selected, label] : [label] };
  });
  // Merge custom answers into the selection and submit everything.
  const submit = () => {
    const merged = { ...answers };
    for (const question of value.questions) {
      const other = custom[question.question]?.trim();
      if (!other) continue;
      merged[question.question] = question.multiSelect
        ? [...(merged[question.question] || []), other]
        : [other];
    }
    onSubmit(merged);
  };
  return <section className="interaction-card question-card"><div className="interaction-title"><span>?</span><div><strong>Claude needs your choice</strong><p>The turn resumes where it paused after you answer</p></div></div>
    {value.questions.map((question) => <fieldset key={question.question}><legend><small>{question.header}</small>{question.question}</legend>
      <div className="option-grid">{question.options.map((option) => <button type="button" key={option.label}
        className={(answers[question.question] || []).includes(option.label) ? "selected" : ""} onClick={() => toggle(question, option.label)}>
        <strong>{option.label}</strong><span>{option.description}</span></button>)}</div>
      <input placeholder="Other answer (optional)" value={custom[question.question] || ""} onChange={(event) => setCustom((current) => ({ ...current, [question.question]: event.target.value }))} />
    </fieldset>)}
    <button className="primary" onClick={submit}>Submit answer</button>
  </section>;
}

// Show the pending tool call and collect the allow or deny decision.
export function PermissionCard({ value, onDecision }: { value: { toolName: string; input: unknown }; onDecision: (decision: "allow" | "deny", message?: string) => void }) {
  const [message, setMessage] = useState("");
  return <section className="interaction-card permission-card"><div className="interaction-title"><span>!</span><div><strong>Waiting for tool permission</strong><p>Claude wants to run {value.toolName}</p></div></div>
    <pre>{pretty(value.input)}</pre><input value={message} onChange={(event) => setMessage(event.target.value)} placeholder="Denial reason or alternative (optional)" />
    <div className="decision-row"><button className="secondary" onClick={() => onDecision("deny", message)}>Deny</button><button className="primary" onClick={() => onDecision("allow")}>Allow once</button></div>
  </section>;
}
