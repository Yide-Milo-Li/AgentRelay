"use client";
import { useEffect, useRef } from "react";

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
/**
 * `connectionId` marks an expiry reminder and `progress` a handoff this device sent moving on; for both, `title` is the
 * notice text the worker composed. Otherwise `title` is the handoff's.
 */
export type NotificationArrival = { handoffId: string | null; connectionId: string | null; progress: "claimed" | "done" | null; title: string | null; gone: boolean };
type Handlers = {
  /** A push arrived while this page is visible: show a notice (or just refresh when the handoff is already gone). */
  onArrived: (arrival: NotificationArrival) => void;
  /** The person clicked a system notification and the worker handed the handoff to this page. */
  onOpen: (handoffId: string) => void;
  /** The person clicked an expiry reminder: show the connection list. */
  onOpenConnections: () => void;
};

/**
 * Messages from the notification worker. A visible page answers on the channel it is given: that answer is what lets the
 * worker skip the system notification, and what lets it skip reloading the tab when a notification is clicked.
 */
export function useNotificationMessages(handlers: Handlers) {
  const latest = useRef(handlers);
  useEffect(() => { latest.current = handlers; });
  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;
    const receive = (event: MessageEvent) => {
      const data = event.data as Record<string, unknown> | null;
      if (data?.type === "agentrelay.notification") {
        event.ports[0]?.postMessage({ displayed: true });
        latest.current.onArrived({ handoffId: typeof data.handoffId === "string" && UUID.test(data.handoffId) ? data.handoffId : null,
          connectionId: typeof data.connectionId === "string" && UUID.test(data.connectionId) ? data.connectionId : null,
          progress: data.progress === "claimed" || data.progress === "done" ? data.progress : null,
          title: typeof data.detail === "string" && data.detail.length <= 200 ? data.detail : null, gone: data.gone === true });
      } else if (data?.type === "agentrelay.open-handoff" && typeof data.id === "string" && UUID.test(data.id)) {
        event.ports[0]?.postMessage({ handled: true });
        latest.current.onOpen(data.id);
      } else if (data?.type === "agentrelay.open-connections") {
        event.ports[0]?.postMessage({ handled: true });
        latest.current.onOpenConnections();
      }
    };
    navigator.serviceWorker.addEventListener("message", receive);
    return () => navigator.serviceWorker.removeEventListener("message", receive);
  }, []);
}
