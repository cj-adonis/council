import { useState } from 'react';
import type { InputReply, PendingInput } from '../types';

function InputCard({
  request,
  onReply,
}: {
  request: PendingInput;
  onReply: (id: string, reply: InputReply) => Promise<void>;
}) {
  const [answers, setAnswers] = useState<Record<string, string[]>>({});
  const [custom, setCustom] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const detail = request.input && typeof request.input === 'object' ? (request.input as Record<string, unknown>) : {};
  const changes = Array.isArray(detail.proposedChanges)
    ? detail.proposedChanges.map((value) =>
        value && typeof value === 'object' ? (value as Record<string, unknown>) : {},
      )
    : [];
  const merged = Object.fromEntries(
    (request.questions ?? []).map((q) => [
      q.id,
      custom[q.id]?.trim()
        ? q.multiSelect
          ? [...new Set([...(answers[q.id] ?? []), custom[q.id]!.trim()])]
          : [custom[q.id]!.trim()]
        : (answers[q.id] ?? []),
    ]),
  );
  const complete = !!request.questions?.length && request.questions.every((q) => (merged[q.id]?.length ?? 0) > 0);
  const reply = async (value: InputReply) => {
    setBusy(true);
    try {
      await onReply(request.id, value);
    } finally {
      setBusy(false);
    }
  };
  return (
    <section
      className="card live-input"
      aria-label={request.kind === 'approval' ? 'Pending tool approval' : 'Worker questions'}
    >
      <header className="card-title">{request.title}</header>
      <p className="muted small">The worker is paused until you respond.</p>
      {request.description && <p>{request.description}</p>}
      {request.kind === 'approval' ? (
        <>
          {request.tool && (
            <p>
              <strong>Tool:</strong> <code>{request.tool}</code>
            </p>
          )}
          {request.input !== undefined && (
            <details open={changes.length === 0}>
              <summary>Requested action</summary>
              <pre className="input-details">
                {typeof request.input === 'string' ? request.input : JSON.stringify(request.input, null, 2)}
              </pre>
            </details>
          )}
          {changes.length > 0 && (
            <div aria-label="Proposed file changes">
              {changes.map((change, index) => (
                <section key={index}>
                  <strong>{String(change.path ?? 'File')}</strong>
                  <pre className="input-details">
                    {typeof change.diff === 'string' ? change.diff : JSON.stringify(change, null, 2)}
                  </pre>
                </section>
              ))}
            </div>
          )}
          <div className="row wrap gap-sm">
            {request.options
              ?.filter((o) => o.decision === 'allow')
              .map((option) => (
                <button
                  key={option.id}
                  className="primary"
                  disabled={busy}
                  onClick={() => void reply({ decision: 'allow', optionId: option.id })}
                >
                  {option.label}
                </button>
              ))}
            <button
              disabled={busy}
              onClick={() =>
                void reply({ decision: 'deny', optionId: request.options?.find((o) => o.decision === 'deny')?.id })
              }
            >
              Deny
            </button>
          </div>
        </>
      ) : (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (complete && !busy) void reply({ decision: 'answer', answers: merged });
          }}
        >
          {request.questions?.map((question) => (
            <fieldset key={question.id} disabled={busy}>
              <legend>{question.question}</legend>
              {question.options.map((option, index) => (
                <label className="input-choice" key={`${option.label}-${index}`}>
                  <input
                    type={question.multiSelect ? 'checkbox' : 'radio'}
                    name={`${request.id}-${question.id}`}
                    checked={answers[question.id]?.includes(option.label) ?? false}
                    onChange={(event) => {
                      if (!question.multiSelect) setCustom((values) => ({ ...values, [question.id]: '' }));
                      setAnswers((values) => ({
                        ...values,
                        [question.id]: question.multiSelect
                          ? event.target.checked
                            ? [...(values[question.id] ?? []), option.label]
                            : (values[question.id] ?? []).filter((v) => v !== option.label)
                          : [option.label],
                      }));
                    }}
                  />
                  <span>
                    {option.label}
                    {option.description && <span className="muted small"> — {option.description}</span>}
                  </span>
                </label>
              ))}
              <label className="input-choice-text">
                {question.options.length ? 'Or enter your answer' : 'Your answer'}
                <input
                  type={question.isSecret ? 'password' : 'text'}
                  autoComplete="off"
                  value={custom[question.id] ?? ''}
                  maxLength={8000}
                  onChange={(event) => {
                    if (!question.multiSelect) setAnswers((values) => ({ ...values, [question.id]: [] }));
                    setCustom((values) => ({ ...values, [question.id]: event.target.value }));
                  }}
                />
              </label>
            </fieldset>
          ))}
          <div className="row gap-sm">
            <button className="primary" disabled={busy || !complete} type="submit">
              Send answers
            </button>
            <button disabled={busy} type="button" onClick={() => void reply({ decision: 'deny' })}>
              Dismiss
            </button>
          </div>
        </form>
      )}
    </section>
  );
}

export function PendingInputs({
  requests,
  onReply,
}: {
  requests: PendingInput[];
  onReply: (id: string, reply: InputReply) => Promise<void>;
}) {
  return (
    <>
      {requests.map((request) => (
        <InputCard key={request.id} request={request} onReply={onReply} />
      ))}
    </>
  );
}
