"use client";
import { ArrowRight, Bell, Check } from "lucide-react";
import { useLang } from "@/components/providers/LanguageProvider";
import type { NotificationControl } from "@/features/handoffs";
import type { SetupStep, SetupStepId } from "./setup-progress";

export type SetupActions = {
  chooseDevice: () => void; connectAgent: () => void; copyLink: () => void; confirmOther: (() => void) | null; createHandoff: () => void;
};
/** This browser's notifications, offered as an optional step: `deviceId` is the device a click on Turn on binds them to. */
export type SetupNotifications = { control: NotificationControl; deviceId: string; boundName: string; openSettings: () => void };
type Props = {
  steps: readonly SetupStep[]; deviceName: string; otherName: string; siteUrl: string; actions: SetupActions;
  notifications: SetupNotifications | null; onDismiss: () => void; onSample?: () => void;
};

/**
 * The optional step after the numbered ones. It is not counted in the progress and never becomes the current step; it is
 * shown only where notifications can work, and the browser's permission prompt still follows only the click on its button.
 */
function NotifyStep({ control, deviceId, deviceName, boundName, openSettings }: SetupNotifications & { deviceName: string }) {
  const { t, errorText } = useLang(), s = t.setup.notify;
  const { state } = control, on = state === "on";
  if (state !== "off" && !on && state !== "blocked" && state !== "reconnect") return null;
  // While the browser's request is open or went unanswered, the same browser-specific steps as in Settings say where to look.
  const guide = state === "off" && control.prompt && control.browser ? t.notifications.guide[control.browser][control.prompt] : null;
  return <div className="setup-optional" data-state={on ? "done" : "todo"}>
    <span className="setup-mark" aria-hidden="true">{on ? <Check size={13} strokeWidth={2.5} /> : <Bell size={12} />}</span>
    <div className="setup-body">
      <strong>{s.title}<small className="setup-tag">{s.optional}</small></strong>
      {on ? <>
        <p className="muted">{s.done(boundName)}{control.lastTest?.trigger === "enabled" && ` ${s.tested}`}</p>
        {control.lastTest && <div className="setup-actions"><button type="button" className="link" onClick={openSettings}>{s.missing}</button></div>}
      </> : state === "off" ? <>
        <p>{guide ?? s.body(deviceName)}</p>
        <div className="setup-actions">
          <button type="button" className="btn small" disabled={control.busy} onClick={() => void control.enable(deviceId)}>{s.action}</button>
          <button type="button" className="link" onClick={openSettings}>{s.settings}</button>
        </div>
      </> : <>
        <p>{s.attention}</p>
        <div className="setup-actions"><button type="button" className="link" onClick={openSettings}>{s.settings}</button></div>
      </>}
      {!!control.error && <p role="alert" className="muted">{errorText(control.error)}</p>}
    </div>
  </div>;
}

/** The steps in order. Done steps say what is true, the first open one says what to do, later ones only name themselves. */
export function SetupSteps({ steps, deviceName, otherName, siteUrl, actions, notifications }: Omit<Props, "onDismiss" | "onSample">) {
  const { t } = useLang(), s = t.setup;
  const next = steps.findIndex(step => !step.done);
  const titles: Record<SetupStepId, string> = { device: s.device.title, agent: s.agent.title, nextDevice: s.nextDevice.title, handoff: s.handoff.title };
  function doneText(step: SetupStep) {
    switch (step.id) {
      case "device": return s.device.done(deviceName);
      case "agent": return step.selfReported ? s.agent.plugin(deviceName) : s.agent.done(deviceName);
      case "nextDevice": return step.selfReported ? s.nextDevice.confirmed : s.nextDevice.done;
      case "handoff": return s.handoff.done;
    }
  }
  function open(id: SetupStepId) {
    switch (id) {
      case "device": return <><p>{s.device.body}</p>
        <div className="setup-actions"><button type="button" className="btn primary small" onClick={actions.chooseDevice}>{s.device.action}</button></div></>;
      case "agent": return <><p>{s.agent.body(deviceName)}</p>
        <div className="setup-actions"><button type="button" className="btn primary small" onClick={actions.connectAgent}>{s.agent.action}<ArrowRight size={15} aria-hidden="true" /></button></div></>;
      case "nextDevice": return <><p>{s.nextDevice.body(siteUrl)}</p>
        <div className="setup-actions"><button type="button" className="btn small" onClick={actions.copyLink}>{s.nextDevice.copy}</button>
          {actions.confirmOther && <button type="button" className="link" onClick={actions.confirmOther}>{s.nextDevice.confirm}</button>}</div></>;
      case "handoff": return <><p>{s.handoff.body(otherName)}</p>
        <div className="setup-actions"><button type="button" className="link" onClick={actions.createHandoff}>{s.handoff.action}</button></div></>;
    }
  }
  return <><ol className="setup-list">
    {steps.map((step, i) => <li key={step.id} data-state={step.done ? "done" : i === next ? "current" : "todo"} aria-current={i === next ? "step" : undefined}>
      <span className="setup-mark" aria-hidden="true">{step.done ? <Check size={13} strokeWidth={2.5} /> : i + 1}</span>
      <div className="setup-body">
        <strong>{titles[step.id]}</strong>
        {step.done ? <p className="muted">{doneText(step)}{step.selfReported && <small className="setup-said">{s.selfReported}</small>}</p>
          : i === next ? open(step.id) : null}
      </div>
    </li>)}
  </ol>
  {notifications && <NotifyStep {...notifications} deviceName={deviceName} />}</>;
}

/** The checklist in place of an empty inbox. */
export default function SetupChecklist({ onDismiss, onSample, ...rest }: Props) {
  const { t } = useLang();
  return <section className="setup" aria-labelledby="setup-title">
    <h2 id="setup-title">{t.setup.title}</h2><p className="setup-sub">{t.setup.sub}</p>
    <SetupSteps {...rest} />
    <div className="setup-foot">
      {onSample && <button type="button" className="link" onClick={onSample}>{t.seeSample}<ArrowRight size={15} aria-hidden="true" /></button>}
      <button type="button" className="link quiet" onClick={onDismiss}>{t.setup.hide}</button>
    </div>
  </section>;
}

/** Above a list that already has handoffs: the progress and the next step, folded until opened. */
export function SetupProgress({ onDismiss, ...rest }: Omit<Props, "onSample">) {
  const { t } = useLang();
  const done = rest.steps.filter(step => step.done).length, next = rest.steps.find(step => !step.done);
  const titles: Record<SetupStepId, string> = { device: t.setup.device.title, agent: t.setup.agent.title, nextDevice: t.setup.nextDevice.title, handoff: t.setup.handoff.title };
  return <details className="setup-progress">
    <summary><strong>{t.setup.progress(done, rest.steps.length)}</strong>{next && <span>{t.setup.next(titles[next.id])}</span>}</summary>
    <SetupSteps {...rest} />
    <div className="setup-foot"><button type="button" className="link quiet" onClick={onDismiss}>{t.setup.hide}</button></div>
  </details>;
}
