// Hook that maintains the per-session WebSocket connection with sequenced events and automatic reconnect.
import { useCallback, useEffect, useRef, useState } from "react";
import type { ClientCommand, ServerEvent } from "@shared/protocol";

// Maintain the session's live WebSocket connection, tracking the last event sequence.
export function useLiveSession(sessionId: string | null, onEvent: (event: ServerEvent) => void) {
  const [status, setStatus] = useState<"connecting" | "open" | "closed">("closed");
  const socketRef = useRef<WebSocket | null>(null);
  const callbackRef = useRef(onEvent);
  const lastSeqRef = useRef(0);
  callbackRef.current = onEvent;

  useEffect(() => {
    if (!sessionId) return;
    let disposed = false;
    let retry = 0;
    let timer: number | undefined;

    const connect = () => {
      if (disposed) return;
      setStatus("connecting");
      const protocol = location.protocol === "https:" ? "wss:" : "ws:";
      const socket = new WebSocket(`${protocol}//${location.host}/api/sessions/${sessionId}/live?lastSeq=${lastSeqRef.current}`);
      socketRef.current = socket;
      socket.onopen = () => {
        retry = 0;
        setStatus("open");
        socket.send(JSON.stringify({ type: "hello", lastSeq: lastSeqRef.current } satisfies ClientCommand));
      };
      socket.onmessage = (message) => {
        try {
          const event = JSON.parse(message.data) as ServerEvent;
          if (event.seq > 0) lastSeqRef.current = Math.max(lastSeqRef.current, event.seq);
          callbackRef.current(event);
        } catch {
          // Invalid frames never reach product state.
        }
      };
      socket.onclose = () => {
        if (socketRef.current === socket) socketRef.current = null;
        setStatus("closed");
        if (!disposed) timer = window.setTimeout(connect, Math.min(10_000, 500 * 2 ** retry++));
      };
      socket.onerror = () => socket.close();
    };
    lastSeqRef.current = 0;
    connect();
    return () => {
      disposed = true;
      if (timer) clearTimeout(timer);
      socketRef.current?.close();
      socketRef.current = null;
    };
  }, [sessionId]);

  // Send one client command over the open socket, failing fast when it is not ready.
  const send = useCallback((command: ClientCommand) => {
    const socket = socketRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN) throw new Error("Live connection is not ready");
    socket.send(JSON.stringify(command));
  }, []);

  return { status, send };
}
