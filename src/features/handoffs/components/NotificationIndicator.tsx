"use client";
import { useSyncExternalStore } from "react";
import { BellOff } from "lucide-react";
import { useLang } from "@/components/providers/LanguageProvider";
import type { NotificationControl } from "../hooks/use-notification-settings";
import { notificationHintSeen } from "../notification-browser";

const noSubscription = () => () => {};

/**
 * A quiet footer chip, shown only when there is something to do. It is hidden while notifications are on, and for browsers
 * that cannot use them or whose Site has none. A browser that never turned them on gets an icon until the person has looked
 * at the settings once; a blocked or lapsed one gets a word, because that needs a decision.
 */
export default function NotificationIndicator({ control, onOpen }: { control: NotificationControl; onOpen: () => void }) {
  const { t } = useLang(), n = t.notifications;
  // The stored flag is unknown to the server render, which therefore counts it as seen and draws nothing.
  const seen = useSyncExternalStore(noSubscription, notificationHintSeen, () => true);
  const attention = control.state === "blocked" ? n.indicatorBlocked : control.state === "reconnect" ? n.indicatorReconnect : null;
  if (attention) return <button className="notification-indicator" data-tone="warn" onClick={onOpen} title={attention}><BellOff size={14} aria-hidden="true" /><span>{attention}</span></button>;
  if (control.state !== "off" || seen) return null;
  return <button className="notification-indicator" onClick={onOpen} title={n.indicatorOff} aria-label={n.indicatorOff}><BellOff size={14} aria-hidden="true" /></button>;
}
