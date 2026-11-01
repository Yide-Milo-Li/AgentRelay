"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { currentNotificationEnvironment, notificationSupport } from "@/shared/browser/notification-support";
import type { ExpiryReminderScope, NotificationSettings, ProgressScope } from "@/shared/contracts/notifications";
import { api } from "@/shared/http/client";
import { applyNotificationRepairs, disableNotificationSubscription, enableNotificationSubscription, notificationBrowserId, observeNotifications, syncWaitingNotifications, wasSwitchedOn } from "../notification-browser";
import { decideNotification, type Decision, type NotificationState, type PermissionPrompt } from "../notification-state";

const LOCK = "agentrelay-notifications";
const REVISIT_MS = 60_000;
/** A prompt answered faster than this was already decided, so no guidance flashes up for it. */
const PROMPT_GRACE_MS = 800;
export type NotificationChange = { deviceId?: string; locale?: "en" | "zh"; label?: string | null; notifyRequeue?: boolean; notifyAny?: boolean; showDetails?: boolean;
  notifyExpiry?: ExpiryReminderScope; notifyProgress?: ProgressScope };
export type NotificationControl = {
  /** `loading` until the first reading finishes; `error` when it could not be read at all. */
  state: NotificationState | "loading" | "error";
  reason: Decision["reason"]; hint: Decision["hint"];
  /** The supported browser, so permission steps can name its own controls; null when it is not Chrome or Edge. */
  browser: "Chrome" | "Edge" | null;
  /** Where the permission request from the last click stands; null once it was granted or blocked. */
  prompt: PermissionPrompt | null;
  settings: NotificationSettings | null;
  /** When `settings` was read, so times can be shown relative to it without reading the clock while rendering. */
  readAt: number;
  busy: boolean; error: unknown;
  /** Must run directly from a click: it asks the browser for permission first. */
  enable: (deviceId: string) => Promise<boolean>;
  disable: () => Promise<boolean>;
  update: (change: NotificationChange) => Promise<boolean>;
  test: () => Promise<boolean>;
  /** Stop another browser of this workspace from being notified. */
  remove: (browserId: string) => Promise<boolean>;
  refresh: () => Promise<void>;
};

/** Tabs share one subscription, so reading and repairing it takes turns across tabs. */
function exclusive<T>(run: () => Promise<T>): Promise<T> {
  return navigator.locks ? navigator.locks.request(LOCK, run) as Promise<T> : run();
}

/**
 * The single place that knows whether this browser will be notified. On every visit it reads the Site, the permission, the
 * push subscription and the worker, repairs what can be repaired without asking, and reports one state. Nothing here ever
 * prompts for permission except `enable`, which is meant to be called from a click.
 */
export function useNotificationSettings(lang: "en" | "zh", active = true): NotificationControl {
  const [view, setView] = useState<Pick<NotificationControl, "state" | "reason" | "hint" | "settings" | "readAt" | "error">>({ state: "loading", reason: undefined, hint: undefined, settings: null, readAt: 0, error: null });
  const [busy, setBusy] = useState(false);
  const [browser, setBrowser] = useState<NotificationControl["browser"]>(null), [prompt, setPrompt] = useState<PermissionPrompt | null>(null);
  const langRef = useRef(lang), settingsRef = useRef<NotificationSettings | null>(null), lastRun = useRef(0), channel = useRef<BroadcastChannel | null>(null);
  useEffect(() => { langRef.current = lang; });

  const publish = useCallback((state: NotificationControl["state"], settings: NotificationSettings | null, decision?: Decision, error: unknown = null) => {
    settingsRef.current = settings ?? settingsRef.current;
    setView({ state, reason: decision?.reason, hint: decision?.hint, settings: settings ?? settingsRef.current, readAt: Date.now(), error });
  }, []);

  const refresh = useCallback(async () => {
    lastRun.current = Date.now();
    // A browser that cannot use notifications and never had them on has nothing on the Site to read or repair.
    const support = notificationSupport(currentNotificationEnvironment());
    setBrowser(support.supported ? support.browser : null);
    if (!support.supported && !wasSwitchedOn()) { publish("unsupported", null, { state: "unsupported", reason: support.reason, repairs: [] }); return; }
    try {
      await exclusive(async () => {
        let observation = await observeNotifications(langRef.current), decision = decideNotification(observation), changed = false;
        if (decision.repairs.length) {
          try { await applyNotificationRepairs(decision.repairs, observation); changed = true; } catch { /* Re-read below: whatever is still wrong needs a click. */ }
          observation = await observeNotifications(langRef.current);
          decision = decideNotification(observation);
          if (decision.repairs.length) decision = { ...decision, state: "reconnect", repairs: [] };
        }
        publish(decision.state, observation.settings, decision);
        if (changed) channel.current?.postMessage("changed");
      });
    } catch (error) { publish("error", null, undefined, error); }
  }, [publish]);

  useEffect(() => {
    if (!active) return;
    void refresh();
    const revisit = () => { if (document.visibilityState === "visible" && Date.now() - lastRun.current > REVISIT_MS) void refresh(); };
    document.addEventListener("visibilitychange", revisit);
    let broadcast: BroadcastChannel | null = null;
    if (typeof BroadcastChannel !== "undefined") {
      broadcast = new BroadcastChannel(LOCK); channel.current = broadcast;
      broadcast.onmessage = () => { void refresh(); };
    }
    return () => { document.removeEventListener("visibilitychange", revisit); broadcast?.close(); channel.current = null; };
    // The language is part of what is kept in step, so a change re-reads and repairs.
  }, [active, lang, refresh]);

  /** Runs one action, remembers its error for the settings to show, and says whether it worked. */
  const guarded = useCallback(async (work: () => Promise<void>) => {
    setBusy(true);
    try { await work(); setView(old => old.error ? { ...old, error: null } : old); return true; }
    catch (error) { setView(old => ({ ...old, error })); return false; }
    finally { setBusy(false); }
  }, []);

  const enable = useCallback((deviceId: string) => guarded(async () => {
    // The permission prompt needs the click that called this, so nothing is awaited before it.
    const asking = setTimeout(() => setPrompt("waiting"), PROMPT_GRACE_MS);
    let permission: NotificationPermission;
    try { permission = await Notification.requestPermission(); }
    finally { clearTimeout(asking); }
    setPrompt(permission === "default" ? "dismissed" : null);
    if (permission === "granted") {
      const publicKey = settingsRef.current?.publicKey;
      if (!publicKey) throw new Error("Browser notifications are not configured on this Site.");
      await exclusive(() => enableNotificationSubscription(notificationBrowserId(), deviceId, langRef.current, publicKey));
      channel.current?.postMessage("changed");
    }
    await refresh();
  }), [guarded, refresh]);

  const disable = useCallback(() => guarded(async () => {
    await exclusive(() => disableNotificationSubscription(notificationBrowserId()));
    channel.current?.postMessage("changed");
    await refresh();
  }), [guarded, refresh]);

  const update = useCallback((change: NotificationChange) => guarded(async () => {
    const settings = await api<NotificationSettings>("/api/notifications", "PATCH", { browserId: notificationBrowserId(), ...change });
    publish("on", settings, { state: "on", repairs: [] });
    channel.current?.postMessage("changed");
  }), [guarded, publish]);

  const test = useCallback(() => guarded(async () => { await api("/api/notifications/test", "POST", { browserId: notificationBrowserId() }); }), [guarded]);

  const remove = useCallback((browserId: string) => guarded(async () => {
    await api("/api/notifications", "DELETE", { browserId });
    await refresh();
  }), [guarded, refresh]);

  return useMemo(() => ({ ...view, browser, prompt, busy, enable, disable, update, test, remove, refresh }), [view, browser, prompt, busy, enable, disable, update, test, remove, refresh]);
}

/** Keep notifications on screen only while their handoff is still waiting. `waiting` is null when the list is incomplete or not loaded. */
export function useStaleNotificationCleanup(waiting: readonly string[] | null, enabled: boolean) {
  const key = waiting === null ? null : waiting.join(",");
  useEffect(() => {
    if (!enabled || key === null) return;
    void syncWaitingNotifications(key ? key.split(",") : []).catch(() => { /* Closing a stale notification is a courtesy. */ });
  }, [enabled, key]);
}
