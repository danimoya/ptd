import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { trackKeys } from "./api";

/**
 * Live timer updates.
 *
 * The server pushes `timer_start` / `timer_stop` / `dashboard_update` to every
 * socket a user has open, so a session started from an editor over MCP — or in
 * another browser tab — shows up here without a reload. The socket only ever
 * carries a hint; the query cache is the source of truth, so a message just
 * invalidates and lets react-query refetch through the normal action calls.
 *
 * Failure is silent by design: with no socket the page still works, it just
 * refreshes on its own schedule instead of instantly.
 */
export function useTrackSocket() {
  const qc = useQueryClient();

  useEffect(() => {
    const token = (() => {
      try {
        return localStorage.getItem("token");
      } catch {
        return null;
      }
    })();
    if (!token) return;

    let socket: WebSocket | null = null;
    let retry: number | undefined;
    let attempts = 0;
    let closed = false;

    const connect = () => {
      if (closed) return;
      const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
      try {
        socket = new WebSocket(`${proto}//${window.location.host}/ws?token=${encodeURIComponent(token)}`);
      } catch {
        return;
      }
      socket.onopen = () => {
        attempts = 0;
      };
      socket.onmessage = (event) => {
        let type: string | undefined;
        try {
          type = JSON.parse(String(event.data))?.type;
        } catch {
          return;
        }
        if (type === "timer_start" || type === "timer_stop" || type === "timer_update" || type === "dashboard_update") {
          qc.invalidateQueries({ queryKey: trackKeys.all });
        }
      };
      socket.onclose = () => {
        // Back off so a server restart does not turn into a reconnect storm.
        if (closed || attempts >= 5) return;
        attempts += 1;
        retry = window.setTimeout(connect, Math.min(30_000, 2_000 * attempts));
      };
      socket.onerror = () => socket?.close();
    };

    connect();
    return () => {
      closed = true;
      if (retry) window.clearTimeout(retry);
      socket?.close();
    };
  }, [qc]);
}
