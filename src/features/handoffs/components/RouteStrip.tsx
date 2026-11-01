"use client";
import { useEffect, useRef, useState } from "react";
import { useLang } from "@/components/providers/LanguageProvider";
import { formatTime } from "@/shared/formatting/date";
import { type Handoff } from "@/shared/contracts/handoffs";
import { resolveStop, type DeviceIndex } from "@/shared/formatting/device-identity";

const PROGRESS: Record<string, number> = { ready: 0, claimed: 0.5, done: 1 };

// The ride only plays when the status really changes; mounting or a theme switch repaints at rest.
function useRide(status: string) {
  const [moving, setMoving] = useState(false);
  const previous = useRef(status);
  useEffect(() => {
    if (previous.current === status) return;
    previous.current = status;
    setMoving(true);
    const timer = setTimeout(() => setMoving(false), 1300);
    return () => clearTimeout(timer);
  }, [status]);
  return { style: { "--p": PROGRESS[status] ?? 0 } as React.CSSProperties, moving: moving || undefined };
}

// Show the registry's current name and colour by id; handoffs whose device is gone keep their stored name.
function useStops(row: Handoff, devices: DeviceIndex) {
  const { t } = useLang();
  const from = resolveStop(devices, row.sourceDeviceId, row.sourceDevice, t.devices[3]);
  const to = resolveStop(devices, row.targetDeviceId, row.targetDevice, t.devices[3]);
  const claimedBy = row.claimedBy ? resolveStop(devices, row.claimedByDeviceId, row.claimedBy, t.devices[3]).name : null;
  return { from, to, claimedBy };
}

export function RouteMini({ row, devices }: { row: Handoff; devices: DeviceIndex }) {
  const { t } = useLang();
  const ride = useRide(row.status);
  const { from, to } = useStops(row, devices);
  return <span className="route-mini" data-line={to.line} data-status={row.status} data-moving={ride.moving} style={ride.style}
    role="img" aria-label={t.routeLabel(from.name, to.name, t.status[row.status])}>
    <span className="route-name">{from.name}</span>
    <span className="track" aria-hidden="true"><span className="fill" /><i className="stop" data-at="0" /><i className="stop" data-at="1" /><i className="train" /></span>
    <span className="route-name">{to.name}</span>
  </span>;
}

export function RouteFull({ row, devices }: { row: Handoff; devices: DeviceIndex }) {
  const { t, locale } = useLang();
  const ride = useRide(row.status);
  const { from, to, claimedBy } = useStops(row, devices);
  const claimed = row.status !== "ready", done = row.status === "done";
  return <div className="route-full" data-line={to.line} data-status={row.status} data-moving={ride.moving} style={ride.style}
    role="img" aria-label={t.routeLabel(from.name, to.name, t.status[row.status])}>
    <span className="track" aria-hidden="true"><span className="fill" /><i className="train" /></span>
    <ol aria-hidden="true">
      <li className="passed"><i className="stop" /><b>{from.name}</b><span className="tnum">{row.createdByName ? t.stopSentBy(row.createdByName, formatTime(row.createdAt, locale)) : t.stopSent(formatTime(row.createdAt, locale))}</span></li>
      <li className={claimed ? "passed" : ""}><i className="stop" /><b>{t.stopClaimed}</b><span>{claimed ? (claimedBy ? t.stopClaimedBy(claimedBy) : t.status.claimed) : t.stopWaiting}</span></li>
      <li className={done ? "passed" : ""}><i className="stop" /><b>{to.name}</b><span>{done ? t.stopDone : t.stopNotYet}</span></li>
    </ol>
  </div>;
}
