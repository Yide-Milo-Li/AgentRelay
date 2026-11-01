"use client";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { Check, Plus } from "lucide-react";
import { useLang } from "@/components/providers/LanguageProvider";
import { api } from "@/shared/http/client";
import type { Device } from "@/shared/contracts/devices";
import type { IssuedAgentToken, TokenInfo } from "@/shared/contracts/agent-tokens";
import { AGENT_PROFILES, DEFAULT_AGENT_PROFILE, findAgentProfile } from "@/shared/agent-profiles";
import ConnectionSecret from "@/features/agent-access/components/ConnectionSecret";
import PluginSetup from "@/features/agent-access/components/PluginSetup";
import PermanentConnectionDialog from "./PermanentConnectionDialog";

type Props = {
  devices: readonly Device[]; defaultDeviceId: string | null; siteUrl: string;
  notify: (message: string) => void; onCreateDevice: (name: string) => Promise<Device>;
  onIssued: (record: TokenInfo) => void; onClose: () => void; onPluginConfirmed: (deviceId: string) => void;
  /** Devices where a usable connection has already been used, so their gateway token is saved. */
  connectedDevices: ReadonlySet<string>;
};
const NO_DEVICE = "";
/** The Site's own plugin: chosen like an agent, but it issues no token and ends in its own instructions. */
const PLUGIN = "plugin";
type Step = "device" | "agent" | "details" | "setup" | "plugin";

/**
 * Device → agent → name and lifetime → setup, one decision per step. Only the details step's Create issues a token;
 * after that the earlier steps are locked, because changing them would describe a credential that no longer matches.
 * The plugin path skips the details and issues nothing.
 */
export default function ConnectionWizard({ devices, defaultDeviceId, siteUrl, notify, onCreateDevice, onIssued, onClose, onPluginConfirmed, connectedDevices }: Props) {
  const { t, lang, errorText } = useLang();
  const [profileId, setProfileId] = useState(DEFAULT_AGENT_PROFILE.id);
  // Without this browser's device nothing is preselected: "No device" is a deliberate choice, never a default to click past.
  const [at, setAt] = useState(0), [choice, setChoice] = useState<string | null>(defaultDeviceId && devices.some(device => device.id === defaultDeviceId) ? defaultDeviceId : null);
  const [typedName, setTypedName] = useState<string | null>(null), [days, setDays] = useState<number | null>(90);
  const [riskOpen, setRiskOpen] = useState(false);
  const validity = useRef<HTMLSelectElement>(null);
  const [newDevice, setNewDevice] = useState(""), [busy, setBusy] = useState(false), [error, setError] = useState<unknown>(null);
  const [issued, setIssued] = useState<IssuedAgentToken | null>(null);
  // Settled when the token is issued, so the set-up step keeps its layout while the new connection comes in.
  const [firstOnDevice, setFirstOnDevice] = useState(true);
  const heading = useRef<HTMLHeadingElement>(null), first = useRef(true);
  const device = devices.find(item => item.id === choice) ?? null;
  const plugin = profileId === PLUGIN;
  const profile = findAgentProfile(profileId) ?? DEFAULT_AGENT_PROFILE;
  const steps: Step[] = plugin ? ["device", "agent", "plugin"] : ["device", "agent", "details", "setup"];
  const step = steps[at];
  // Until the name is edited it follows the chosen device and agent.
  const name = typedName ?? t.connectionNameDefault(profile.label, device?.name);

  useEffect(() => {
    if (first.current) { first.current = false; return; }
    heading.current?.focus();
  }, [at]);

  function go(next: number) { setError(null); setAt(next); }
  async function addDevice() {
    const value = newDevice.trim();
    if (!value || busy) return;
    setBusy(true); setError(null);
    try { const created = await onCreateDevice(value); setChoice(created.id); setNewDevice(""); }
    catch (e) { setError(e); } finally { setBusy(false); }
  }
  async function create() {
    if (busy || !name.trim()) return;
    setBusy(true); setError(null);
    try {
      const { token, ...record } = await api<IssuedAgentToken>("/api/agent-tokens", "POST", { name, expiresInDays: days,
        ...(days === null ? { acknowledgePermanentRisk: true } : {}), ...(device ? { deviceId: device.id } : {}), clientProfile: profile.id });
      setFirstOnDevice(!device || !connectedDevices.has(device.id));
      setIssued({ ...record, token }); onIssued(record); go(at + 1);
    } catch (e) { setError(e); } finally { setBusy(false); }
  }
  function submit(event: FormEvent) {
    event.preventDefault();
    if (step === "details") void create(); else go(at + 1);
  }

  const titles: Record<Step, string> = { device: t.wizardDeviceTitle, agent: t.wizardClientTitle, details: t.wizardDetailsTitle, setup: t.wizardSecretTitle, plugin: t.pluginTitle };
  const ledes: Partial<Record<Step, string>> = { device: t.wizardDeviceBody, agent: t.wizardClientBody };
  // What each finished step settled, shown under its label so later steps never need a separate summary.
  const values: Partial<Record<Step, string>> = { device: device?.name ?? t.connectionUnbound, agent: plugin ? t.pluginOption : profile.label, details: days === null ? t.permanentOption : t.days(days) };
  const labels = plugin ? t.wizardStepsPlugin : t.wizardSteps;
  // The plugin has no `self`: its agent names the device, so it needs one.
  const blocked = (step === "agent" && plugin && !device) || (step === "device" && choice === null);

  return <section className="wizard" aria-labelledby="wizard-heading">
    <ol className="wizard-steps" aria-label={t.connectionStep(at + 1, labels.length)} style={{ gridTemplateColumns: `repeat(${labels.length}, minmax(0, 1fr))` }}>
      {labels.map((label, index) => {
        const state = index < at ? "done" : index === at ? "current" : "todo", value = values[steps[index]];
        const body = <><span className="wizard-step-label">{state === "done" ? <Check size={12} strokeWidth={2.5} aria-hidden="true" /> : <b aria-hidden="true">{index + 1}</b>}{label}</span>
          {state === "done" && value && <small>{value}</small>}</>;
        return <li key={label} data-state={state} aria-current={state === "current" ? "step" : undefined}>
          {state === "done" && !issued
            ? <button type="button" className="wizard-step" disabled={busy} onClick={() => go(index)} aria-label={t.wizardStepEdit(label, value ?? "")}>{body}</button>
            : <div className="wizard-step">{body}</div>}
        </li>;
      })}
    </ol>
    <h3 id="wizard-heading" ref={heading} tabIndex={-1}>{titles[step]}</h3>
    {ledes[step] && <p className="wizard-lede">{ledes[step]}</p>}

    {(step === "device" || step === "agent" || step === "details") && <form onSubmit={submit} noValidate>
      <fieldset className="wizard-pane" key={step} disabled={busy} aria-labelledby="wizard-heading">
        {step === "device" && <>
          {devices.map(item => <label className="choice" key={item.id} data-line={item.line}>
            <input type="radio" name="connection-device" checked={choice === item.id} onChange={() => setChoice(item.id)} />
            <i aria-hidden="true" /><span>{item.name}</span><code>{item.id}</code></label>)}
          <label className="choice"><input type="radio" name="connection-device" checked={choice === NO_DEVICE} onChange={() => setChoice(NO_DEVICE)} /><span>{t.connectionUnbound}</span></label>
          {choice === NO_DEVICE && <p className="muted">{t.connectionUnboundHint} {t.wizardUnboundSkill}</p>}
          {choice === null && <p className="muted">{t.wizardChooseDevice}</p>}
          <div className="inline-add">
            <input aria-label={t.connectionAddDevice} value={newDevice} onChange={event => setNewDevice(event.target.value)} maxLength={80} placeholder={t.connectionAddPh}
              onKeyDown={event => { if (event.key === "Enter") { event.preventDefault(); void addDevice(); } }} />
            <button type="button" className="btn small" disabled={busy || !newDevice.trim()} onClick={addDevice}><Plus size={14} aria-hidden="true" />{t.connectionAddDevice}</button>
          </div>
        </>}

        {step === "agent" && <>
          {AGENT_PROFILES.map(item => <label className="choice stacked" key={item.id}>
            <input type="radio" name="connection-client" checked={profileId === item.id} onChange={() => setProfileId(item.id)} />
            <span>{item.label}<small>{item.description[lang]}</small></span></label>)}
          <label className="choice stacked">
            <input type="radio" name="connection-client" checked={plugin} onChange={() => setProfileId(PLUGIN)} />
            <span>{t.pluginOption}<small>{t.pluginOptionBody}</small></span></label>
          {blocked && <p className="muted">{t.pluginNeedsDevice}</p>}
        </>}

        {step === "details" && <>
          <label className="field">{t.tokenName}<input value={name} onChange={event => setTypedName(event.target.value)} maxLength={80} required /></label>
          <label className="field">{t.tokenValidity}<select ref={validity} value={days === null ? "permanent" : days}
            onChange={event => { if (event.target.value === "permanent") setRiskOpen(true); else setDays(Number(event.target.value)); }}>
            {[30, 90, 365].map(value => <option key={value} value={value}>{t.days(value)}</option>)}<option value="permanent">{t.permanentOption}</option>
          </select></label>
          {days === null && <p className="muted">{t.permanentSelected}</p>}
          <div className="wizard-note">
            <p>{t.wizardFiles(profile.ruleFile, device ? profile.skillDir : undefined)}</p>
            <details><summary>{t.wizardSetupMore}</summary><p>{t.wizardSetupBody}</p></details>
          </div>
        </>}
      </fieldset>

      {!!error && <p role="alert" className="form-error">{errorText(error)}</p>}
      <div className="wizard-actions">
        <button type="button" className="btn" disabled={busy} onClick={at === 0 ? onClose : () => go(at - 1)}>{at === 0 ? t.wizardCancel : t.wizardBack}</button>
        <button type="submit" className="btn primary" disabled={busy || blocked || (step === "details" && !name.trim())}>
          {step === "details" ? (busy ? t.working : t.wizardCreate) : t.wizardNext}</button>
      </div>
    </form>}

    {step === "setup" && issued && <div className="wizard-pane">
      <ConnectionSecret issued={issued} profile={profile} siteUrl={siteUrl} notify={notify} onDone={onClose} device={device && { id: device.id, name: device.name }}
        firstOnDevice={firstOnDevice} />
    </div>}
    {step === "plugin" && device && <div className="wizard-pane">
      <PluginSetup device={device} siteUrl={siteUrl} notify={notify} onBack={() => go(at - 1)}
        onConfirm={() => { onPluginConfirmed(device.id); notify(t.toastPluginConfirmed(device.name)); onClose(); }} />
    </div>}
    {riskOpen && <PermanentConnectionDialog onCancel={() => { setRiskOpen(false); requestAnimationFrame(() => validity.current?.focus()); }}
      onConfirm={() => { setDays(null); setRiskOpen(false); requestAnimationFrame(() => validity.current?.focus()); }} />}
  </section>;
}
