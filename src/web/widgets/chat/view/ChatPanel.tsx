// Chat panel: transcript, live streaming, uploads, interaction cards and the message composer.
import { useCallback, useEffect, useRef, useState } from "react";
import { MessageView } from "@/entities/message";
import { useLiveSession } from "@/features/live-session";
import { Markdown } from "@/shared/ui/Markdown";
import { PermissionCard, QuestionCard } from "./InteractionCards";
import { api, messageOf } from "@/shared/api/client";
import { stateLabel } from "@/shared/lib/labels";
import type {
  AppConfigDto, ContentBlockDto, EffortLevel, MessageDto, PermissionMode, ProjectDto,
  QuestionDto, ServerEvent, SessionDto, UploadDto,
} from "@shared/protocol";

// Host the conversation: history, live stream, uploads, interaction cards and the composer.
export function ChatPanel({ session, project, config, onSessionUpdate, onRefreshSessions, onFork }: {
  session: SessionDto; project: ProjectDto; config: AppConfigDto;
  onSessionUpdate: (session: SessionDto) => void; onRefreshSessions: () => void; onFork: (session: SessionDto) => void;
}) {
  const [messages, setMessages] = useState<MessageDto[]>([]);
  const [liveMessages, setLiveMessages] = useState<MessageDto[]>([]);
  const [liveDelta, setLiveDelta] = useState("");
  const [text, setText] = useState("");
  const [uploads, setUploads] = useState<UploadDto[]>([]);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState("");
  const [external, setExternal] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [olderOffset, setOlderOffset] = useState(0);
  const [question, setQuestion] = useState<{ interactionId: string; questions: QuestionDto[] } | null>(null);
  const [permission, setPermission] = useState<{ interactionId: string; toolName: string; input: unknown } | null>(null);
  const endRef = useRef<HTMLDivElement>(null);

  // Fetch a page of history, replacing or prepending it depending on the direction.
  const loadMessages = useCallback(async (offset = 0, prepend = false) => {
    const result = await api<{ messages: MessageDto[]; hasMore: boolean; nextOffset: number }>(
      `/api/sessions/${session.id}/messages?limit=100&offset=${offset}`,
    );
    setMessages((current) => prepend ? [...result.messages, ...current] : result.messages);
    setHasMore(result.hasMore); setOlderOffset(result.nextOffset);
  }, [session.id]);

  // Apply one server event to the transcript, interaction prompts and error state.
  const handleEvent = useCallback((event: ServerEvent) => {
    switch (event.type) {
      case "session.metadata": onSessionUpdate(event.payload as SessionDto); break;
      case "assistant.delta": setLiveDelta((value) => value + String((event.payload as { text?: string }).text || "")); break;
      case "assistant.message": {
        const value = event.payload as MessageDto;
        setLiveMessages((current) => [...current.filter((item) => item.id !== value.id), value]);
        setLiveDelta("");
        break;
      }
      case "tool.finished": {
        const block = event.payload as ContentBlockDto;
        const id = `tool-result-${block.toolUseId || event.seq}`;
        setLiveMessages((current) => [
          ...current.filter((item) => item.id !== id),
          { id, role: "assistant", blocks: [block] },
        ]);
        break;
      }
      case "interaction.question": setQuestion(event.payload as { interactionId: string; questions: QuestionDto[] }); break;
      case "interaction.permission": setPermission(event.payload as { interactionId: string; toolName: string; input: unknown }); break;
      case "interaction.resolved": {
        const id = String((event.payload as { interactionId?: string }).interactionId || "");
        setQuestion((current) => current?.interactionId === id ? null : current);
        setPermission((current) => current?.interactionId === id ? null : current);
        break;
      }
      case "external.changed":
        setExternal(true);
        onRefreshSessions();
        break;
      case "command.error": setError(String((event.payload as { message?: string }).message || "Operation failed")); break;
      case "turn.failed":
        setQuestion(null); setPermission(null);
        setError(String((event.payload as { message?: string }).message || "Turn failed"));
        break;
      case "turn.completed":
      case "turn.interrupted":
        setQuestion(null); setPermission(null); setLiveMessages([]); setLiveDelta("");
        loadMessages().catch((cause) => setError(messageOf(cause))); onRefreshSessions(); break;
    }
  }, [loadMessages, onRefreshSessions, onSessionUpdate]);
  const live = useLiveSession(session.id, handleEvent);

  useEffect(() => { loadMessages().catch((cause) => setError(messageOf(cause))); }, [loadMessages]);
  useEffect(() => { endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" }); }, [messages, liveMessages, liveDelta, question, permission]);

  // Send the composed message with its attachments and show it optimistically.
  const send = () => {
    try {
      live.send({ type: "send", text, uploadIds: uploads.map((upload) => upload.id) });
      if (text.trim()) setLiveMessages((current) => [...current, { id: `optimistic-${Date.now()}`, role: "user", blocks: [{ type: "text", text }] }]);
      setText(""); setUploads([]); setError("");
    } catch (cause) { setError(messageOf(cause)); }
  };

  // Upload each selected file and collect the returned attachment descriptors.
  const uploadFiles = async (files: FileList | null) => {
    if (!files?.length) return;
    setUploading(true); setError("");
    try {
      const next: UploadDto[] = [];
      for (const file of Array.from(files)) {
        const body = new FormData(); body.append("file", file);
        next.push(await api<UploadDto>(`/api/sessions/${session.id}/uploads`, { method: "POST", body }));
      }
      setUploads((current) => [...current, ...next]);
    } catch (cause) { setError(messageOf(cause)); }
    finally { setUploading(false); }
  };

  // Switch the permission mode, confirming the consequences of full access first.
  const changeMode = (mode: PermissionMode) => {
    if (mode === "bypassPermissions" && !window.confirm("Full access lets Claude run commands and modify files without confirmation. Switch anyway?")) return;
    try { live.send({ type: "set_mode", mode }); } catch (cause) { setError(messageOf(cause)); }
  };

  // Fork the session at the given message and hand the new session to the parent.
  const forkAt = async (messageId: string) => {
    try {
      const fork = await api<SessionDto>(`/api/sessions/${session.id}/fork`, {
        method: "POST", body: JSON.stringify({ messageId }),
      });
      onFork(fork);
    } catch (cause) { setError(messageOf(cause)); }
  };

  const allMessages = [...messages, ...liveMessages];
  return (
    <div className="chat-layout" data-session-id={session.id}>
      <section className="chat-column">
        <header className="chat-header">
          <div><p className="eyebrow">{project.name}</p><h2>{session.title}</h2></div>
        </header>
        {external && <div className="external-banner">History changed externally.<button onClick={() => {
          loadMessages(); onRefreshSessions(); setExternal(false);
        }}>Refresh</button></div>}
        <div className="transcript">
          {hasMore && <button className="load-older" onClick={() => loadMessages(olderOffset, true)}>Load earlier messages</button>}
          {!allMessages.length && !liveDelta && <div className="conversation-empty"><span>⌘</span><h3>Start here</h3><p>Runs on this Mac and saves into Claude Code's native session history.</p></div>}
          {allMessages.map((message) => <MessageView key={message.id} message={message} onFork={message.id.startsWith("optimistic-") ? undefined : () => forkAt(message.id)} />)}
          {liveDelta && <div className="message assistant streaming"><div className="avatar">C</div><div className="message-body"><Markdown text={liveDelta} /><span className="typing-caret" /></div></div>}
          {question && <QuestionCard value={question} onSubmit={(answers) => {
            try { live.send({ type: "answer", interactionId: question.interactionId, answers }); }
            catch (cause) { setError(messageOf(cause)); }
          }} />}
          {permission && <PermissionCard value={permission} onDecision={(decision, message) => {
            try { live.send({ type: "permission", interactionId: permission.interactionId, decision, message }); }
            catch (cause) { setError(messageOf(cause)); }
          }} />}
          <div ref={endRef} />
        </div>
        <div className="composer-wrap">
          {error && <div className="inline-error">{error}<button onClick={() => setError("")}>×</button></div>}
          {uploads.length > 0 && <div className="upload-chips">{uploads.map((upload) => <div className="upload-chip" key={upload.id}>
            <a href={upload.url} target="_blank" rel="noreferrer" title={`Preview ${upload.name}`}>
              {upload.isImage ? <img src={upload.url} alt="" /> : <span className="file-glyph">▤</span>}
              <span className="upload-name">{upload.name}</span>
            </a>
            <button aria-label={`Remove ${upload.name}`} onClick={() => setUploads((items) => items.filter((item) => item.id !== upload.id))}>×</button>
          </div>)}</div>}
          <div className="composer">
            <textarea aria-label="Message to Claude" value={text} onChange={(event) => setText(event.target.value)}
              onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); send(); } }}
              placeholder={session.state === "running" || session.state === "waiting" ? "Claude is working…" : "Type a message. Shift + Enter for a new line"} />
            <div className="composer-actions">
              <label className="attach-button" title="Upload images or files">＋<input type="file" multiple onChange={(event) => {
                void uploadFiles(event.target.files); event.currentTarget.value = "";
              }} /></label>
              <span>{uploading ? "Uploading…" : `${text.length.toLocaleString()} characters`}</span>
              <div className="composer-session-controls">
                <select className="composer-model" aria-label="Model" title="Model"
                  value={session.model} onChange={(event) => live.send({ type: "set_model", model: event.target.value })}>
                  {config.models.map((model) => <option key={model}>{model}</option>)}
                </select>
                <select className="composer-mode" aria-label="Mode" title="Mode"
                  value={session.permissionMode} onChange={(event) => changeMode(event.target.value as PermissionMode)}>
                  {config.modes.map((mode) => <option key={mode.value} value={mode.value}>{mode.label}</option>)}
                </select>
                <select className="composer-effort" aria-label="Effort" title="Effort level"
                  value={session.effortLevel} onChange={(event) => live.send({ type: "set_effort", effort: event.target.value as EffortLevel })}>
                  {config.efforts.map((effort) => <option key={effort.value} value={effort.value}>{effort.label}</option>)}
                </select>
                <span className={`connection ${live.status}`} title={`Live connection: ${live.status}`} />
              </div>
              {session.state === "running" || session.state === "waiting" ?
                <button className="stop-button" onClick={() => live.send({ type: "interrupt" })}>■ Stop</button> :
                <button className="send-button" onClick={send} disabled={live.status !== "open" || (!text.trim() && !uploads.length)}>Send ↑</button>}
            </div>
          </div>
        </div>
      </section>
      <aside className="detail-panel">
        <div className="detail-section"><p className="section-label">SESSION</p><dl>
          <dt>Status</dt><dd><span className={`session-state ${session.state}`} />{stateLabel(session.state)}</dd>
          <dt>Branch</dt><dd>{session.gitBranch || "—"}</dd><dt>Model</dt><dd className="mono trim">{session.model}</dd>
          <dt>Mode</dt><dd>{config.modes.find((mode) => mode.value === session.permissionMode)?.label}</dd>
          <dt>Effort</dt><dd>{config.efforts.find((effort) => effort.value === session.effortLevel)?.label}</dd>
        </dl></div>
        <div className="detail-section"><p className="section-label">WORKSPACE</p><p className="path-card">{project.path}</p></div>
        {session.parentSessionId && <div className="detail-section"><p className="section-label">FORK</p><p className="muted">Forked from message <span className="mono">{session.parentMessageId?.slice(0, 8)}</span></p></div>}
        <div className="detail-tip"><strong>Runs locally</strong><p>Tool calls, project files and credentials stay on this Mac.</p></div>
      </aside>
    </div>
  );
}
