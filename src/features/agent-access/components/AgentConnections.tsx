"use client";
import { useEffect, useRef, useState } from "react";
import { History, KeyRound, Plus, RefreshCw } from "lucide-react";
import { useLang } from "@/components/providers/LanguageProvider";
import InfoTip from "@/components/ui/InfoTip";
import { api } from "@/shared/http/client";
import { AgentRelayClientError } from "@/shared/errors/agent-relay-client-error";
import type { Device } from "@/shared/contracts/devices";
import type { TokenInfo } from "@/shared/contracts/agent-tokens";
import { AGENT_PROFILES } from "@/shared/agent-profiles";
import { copyText } from "@/shared/browser/clipboard";
import { DEPLOYMENT_TARGET } from "@/shared/contracts/deployment-target";
import { isRetired } from "@/shared/formatting/connection-health";
import ActivityDrawer from "@/features/agent-access/components/ActivityDrawer";
import ConnectionList from "@/features/agent-access/components/ConnectionList";
import ConnectionToolbar from "@/features/agent-access/components/ConnectionToolbar";
import ConnectionWizard from "@/features/agent-access/components/ConnectionWizard";
import ExtendDialog from "@/features/agent-access/components/ExtendDialog";
import OffboardingDialog from "@/features/agent-access/components/OffboardingDialog";
import RotateDialog from "@/features/agent-access/components/RotateDialog";
import SetupCommandDialog from "@/features/agent-access/components/SetupCommandDialog";
import HygieneBanner from "@/features/agent-access/components/HygieneBanner";
import InactiveConnections from "@/features/agent-access/components/InactiveConnections";
import { skillCommand } from "@/features/agent-access/connect-command";
import RevokeSetDialog from "@/features/agent-access/components/RevokeSetDialog";
import {
  filterConnections, filtersActive, issuersOf, NO_FILTERS, summarizeAttention, type ConnectionFilters, type ConnectionGroupBy,
} from "@/features/agent-access/connection-view";

type Pending = { token: TokenInfo; trigger: HTMLElement };
// v2: the device view became the clustered default, so choices remembered from the old layout start over.
const GROUP_KEY = "agentrelay.connections.group.v2";
function storedGroupBy(): ConnectionGroupBy | null {
  try { const value = localStorage.getItem(GROUP_KEY); return value === "member" || value === "device" || value === "client" ? value : null; } catch { return null; }
}

type Props = {
  siteUrl: string; notify: (message: string, action?: { label: string; run: () => void }) => void;
  devices: readonly Device[]; currentDeviceId: string | null; onCreateDevice: (name: string) => Promise<Device>;
  initialDevice?: string | null; startWizard?: boolean; onPluginConfirmed: (deviceId: string) => void;
};

export default function AgentConnections({ siteUrl, notify, devices, currentDeviceId, onCreateDevice, initialDevice, startWizard = false, onPluginConfirmed }: Props) {
  const { t, lang, errorText } = useLang();
  const [tokens, setTokens] = useState<TokenInfo[]>([]);
  // Expiry is judged against the moment the list was last loaded or changed, not on every render.
  const [checkedAt, setCheckedAt] = useState(0);
  const [wizard, setWizard] = useState(startWizard), [busy, setBusy] = useState(false), [loading, setLoading] = useState(true), [error, setError] = useState<unknown>(null);
  const section = useRef<HTMLElement>(null), newConnection = useRef<HTMLButtonElement>(null), wizardWasOpen = useRef(false);
  const [filters, setFilters] = useState<ConnectionFilters>(() => ({ ...NO_FILTERS, device: initialDevice ?? NO_FILTERS.device }));
  // Nothing group-dependent renders before the list has loaded, so reading the stored choice up front cannot mismatch the server markup.
  const [groupPref, setGroupPref] = useState<ConnectionGroupBy | null>(storedGroupBy);
  const [activity, setActivity] = useState<HTMLElement | null>(null);
  const [revokeSet, setRevokeSet] = useState<{ tokens: readonly TokenInfo[]; trigger: HTMLElement; mode: "issuer" | "selection" } | null>(null);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [extending, setExtending] = useState<Pending | null>(null), [rotating, setRotating] = useState<Pending | null>(null), [setup, setSetup] = useState<Pending | null>(null);
  const [offboarding, setOffboarding] = useState<{ issuerRef: string; name: string | null; trigger: HTMLElement } | null>(null);
  useEffect(() => {
    let active = true;
    const load = () => api<{ tokens: TokenInfo[] }>("/api/agent-tokens").then(result => { if (active) { setTokens(result.tokens); setCheckedAt(Date.now()); } });
    load().catch(e => { if (active) setError(e); }).finally(() => { if (active) setLoading(false); });
    // Last-use times go stale while the tab sits in the background, so catch up when it becomes visible again.
    const onVisible = () => { if (document.visibilityState === "visible") load().catch(() => {}); };
    document.addEventListener("visibilitychange", onVisible);
    return () => { active = false; document.removeEventListener("visibilitychange", onVisible); };
  }, []);

  // Closing the wizard removes everything below the fold, so hand focus back to where it was opened and, when
  // the reader had scrolled into the wizard, bring the section's head back out from under the sticky header.
  useEffect(() => {
    if (wizard) { wizardWasOpen.current = true; return; }
    if (!wizardWasOpen.current) return;
    wizardWasOpen.current = false;
    newConnection.current?.focus({ preventScroll: true });
    const head = section.current;
    if (head && head.getBoundingClientRect().top < parseFloat(getComputedStyle(head).scrollMarginTop)) head.scrollIntoView({ block: "start" });
  }, [wizard]);

  const retired = (token: TokenInfo) => isRetired(token, checkedAt);
  const active = tokens.filter(token => !retired(token)), inactive = tokens.filter(retired);
  const issuers = issuersOf(active), shared = issuers.length > 1;
  // Members are the natural grouping once more than one of them has issued connections; otherwise devices are.
  const groupBy: ConnectionGroupBy = groupPref ?? (shared ? "member" : "device");
  // Search and filters earn their space on a longer list; switching the grouping is useful as soon as there are two.
  const fullToolbar = active.length > 3 || shared || filtersActive(filters);
  const visible = filterConnections(active, filters, devices, checkedAt, AGENT_PROFILES);
  // A selection only ever holds connections that are still usable, however the list changed since they were ticked.
  const chosen = active.filter(token => selected.has(token.id));
  const select = (token: TokenInfo, on: boolean) => setSelected(old => { const next = new Set(old); if (on) next.add(token.id); else next.delete(token.id); return next; });
  const chooseGroupBy = (next: ConnectionGroupBy) => { setGroupPref(next); try { localStorage.setItem(GROUP_KEY, next); } catch { /* the choice just isn't remembered */ } };

  async function reload() {
    const result = await api<{ tokens: TokenInfo[] }>("/api/agent-tokens"); setTokens(result.tokens); setCheckedAt(Date.now());
  }
  /** Run one management call, replacing the affected row on success. A conflict means the list was stale, so it is reloaded. */
  async function change(run: () => Promise<void>) {
    setBusy(true); setError(null);
    try { await run(); } catch (e) {
      setError(e);
      if (e instanceof AgentRelayClientError && e.status === 409) await reload().catch(() => {});
    } finally { setBusy(false); }
  }
  const replace = (record: TokenInfo) => setTokens(old => old.map(item => item.id === record.id ? record : item));
  const patch = (token: TokenInfo, body: Record<string, unknown>, message: string, action?: { label: string; run: () => void }) => change(async () => {
    const updated = await api<TokenInfo>(`/api/agent-tokens/${token.id}`, "PATCH", { ...body, version: token.version });
    replace({ ...updated, issuerRef: token.issuerRef, issuedByViewer: token.issuedByViewer }); setCheckedAt(Date.now()); notify(message, action);
  });
  // Binding or unbinding decides whether the agent may say `self`, which its skill and rule on the device rely on. Only
  // that device can rewrite them, so the toast offers the command to run there.
  const move = (token: TokenInfo, deviceId: string | null) => {
    if (Boolean(deviceId) === Boolean(token.deviceId)) return patch(token, { deviceId }, t.toastConnectionMoved);
    const copy = async () => { try { await copyText(skillCommand(token.id)); notify(t.toastCommandCopied); } catch (e) { notify(errorText(e)); } };
    patch(token, { deviceId }, deviceId ? t.toastConnectionBound : t.toastConnectionUnbound, { label: t.copySkillCommand, run: () => void copy() });
  };

  return <section ref={section} className="tokens" aria-labelledby="token-heading">
    <div className="tokens-head">
      <h2 id="token-heading"><KeyRound size={18} aria-hidden="true" />{t.tokensTitle}</h2>
      {/* How the credentials behave: worth knowing once, not worth rereading on every visit. */}
      <InfoTip label={t.infoAbout(t.tokensTitle)}>
        <p>{t.tokensFlow}</p><p>{t.tokensLabelNote}</p>{shared && <p>{t.issuerBody}</p>}<p>{DEPLOYMENT_TARGET === "cloudflare" ? t.tokensNoGateway : t.tokensGateway}</p>
      </InfoTip>
      <div className="token-tools">
        <button type="button" className="btn quiet" disabled={busy} onClick={() => void change(reload)}><RefreshCw size={15} aria-hidden="true" />{t.refresh}</button>
        <button type="button" className="btn quiet" onClick={event => setActivity(event.currentTarget)}><History size={15} aria-hidden="true" />{t.activityOpen}</button>
      </div>
    </div>
    {/* The scope is the one fact about a connection that must never be missed, so it alone carries emphasis. */}
    <p className="tokens-lede">{t.tokensBody}{lang === "zh" ? "" : " "}<strong>{t.tokensScope}</strong></p>
    {!wizard && <button type="button" ref={newConnection} className="btn primary new-connection" onClick={() => { setError(null); setWizard(true); }}><Plus size={16} aria-hidden="true" />{t.connectionNew}</button>}
    {wizard && <ConnectionWizard devices={devices} defaultDeviceId={currentDeviceId} siteUrl={siteUrl} notify={notify} onCreateDevice={onCreateDevice} onPluginConfirmed={onPluginConfirmed}
          connectedDevices={new Set(active.filter(token => token.deviceId && token.lastAuthenticatedAt).map(token => token.deviceId as string))}
          onIssued={record => { setTokens(old => [record, ...old]); setCheckedAt(Date.now());
            void api<{ tokens: TokenInfo[] }>("/api/agent-tokens").then(result => setTokens(result.tokens)).catch(e => setError(e)); }} onClose={() => setWizard(false)} />}
    {!!error && !wizard && <p role="alert" className="form-error">{errorText(error)}</p>}
    {!loading && <HygieneBanner summary={summarizeAttention(active, checkedAt)} onReview={() => setFilters({ ...NO_FILTERS, status: "attention" })} />}
    {(fullToolbar || active.length > 1) && <ConnectionToolbar filters={filters} onFilters={setFilters} issuers={issuers} devices={devices}
      groupBy={groupBy} onGroupBy={chooseGroupBy} showFilters={fullToolbar} />}
    {chosen.length > 0 && <div className="conn-selection" role="status"><strong>{t.connSelected(chosen.length)}</strong>
      <button type="button" className="btn small danger" disabled={busy} onClick={event => setRevokeSet({ tokens: chosen, trigger: event.currentTarget, mode: "selection" })}>{t.connRevokeSelected}</button>
      <button type="button" className="btn quiet small" onClick={() => setSelected(new Set())}>{t.connClearSelection}</button></div>}
    {loading ? <p className="muted">{t.tokensLoading}</p>
      : active.length === 0 ? <p className="muted">{t.tokensEmpty}</p>
      : visible.length === 0 ? <p className="muted">{t.connNoMatch}</p>
      : <ConnectionList tokens={visible} active={active} devices={devices} currentDeviceId={currentDeviceId} busy={busy} groupBy={groupBy} now={checkedAt}
          selected={selected} onSelect={select}
          onRevokeGroup={(group, trigger) => setRevokeSet({ tokens: group, trigger, mode: "issuer" })}
          onOffboard={(issuerRef, name, trigger) => setOffboarding({ issuerRef, name, trigger })}
          onExtend={(token, trigger) => setExtending({ token, trigger })}
          onRotate={(token, trigger) => setRotating({ token, trigger })}
          onSetup={(token, trigger) => setSetup({ token, trigger })}
          onRename={(token, name) => patch(token, { name }, t.toastConnectionRenamed)}
          onMove={move}
          onRevoke={token => change(async () => { replace(await api<TokenInfo>(`/api/agent-tokens/${token.id}?version=${token.version}`, "DELETE")); notify(t.toastRevoked); })} />}
    <InactiveConnections tokens={inactive} busy={busy}
      onRemove={token => change(async () => { await api(`/api/agent-tokens/${token.id}?permanent=1`, "DELETE"); setTokens(old => old.filter(item => item.id !== token.id)); notify(t.toastConnectionRemoved); })}
      onRemoveAll={() => change(async () => {
        const { removed } = await api<{ removed: number }>("/api/agent-tokens?scope=inactive", "DELETE");
        setTokens(old => old.filter(token => !retired(token))); notify(t.toastConnectionsRemoved(removed));
      })} />
    {activity && <ActivityDrawer devices={devices} trigger={activity} onClose={() => setActivity(null)} />}
    {revokeSet && <RevokeSetDialog tokens={revokeSet.tokens} devices={devices} trigger={revokeSet.trigger} busy={busy} onClose={() => setRevokeSet(null)}
      onConfirm={snapshot => void change(async () => {
        // A changed set is refused as a whole and the conflict handler reloads the list for another review.
        if (revokeSet.mode === "selection") await api("/api/agent-tokens/revoke", "POST", { ids: snapshot.map(token => token.id), reason: "bulk" });
        else await api("/api/agent-tokens/revoke-issuer", "POST", { connectionId: snapshot[0].id, expectedTokenIds: snapshot.map(token => token.id) });
        setSelected(new Set()); await reload(); notify(t.toastRevokedMany(snapshot.length));
      })} />}
    {extending && <ExtendDialog token={extending.token} trigger={extending.trigger} busy={busy} onClose={() => setExtending(null)}
      onConfirm={days => { const { token, trigger } = extending;
        // The menu button is disabled while the change runs, so focus returns to it afterwards.
        void patch(token, days === null ? { expiresInDays: null, acknowledgePermanentRisk: true } : { expiresInDays: days }, t.toastConnectionExtended)
          .finally(() => requestAnimationFrame(() => trigger.focus())); }} />}
    {rotating && <RotateDialog token={rotating.token} devices={devices} siteUrl={siteUrl} trigger={rotating.trigger} notify={notify} onClose={() => setRotating(null)}
      onRotated={record => { replace(record); setCheckedAt(Date.now()); }} onConflict={() => void reload().catch(() => {})} />}
    {setup && <SetupCommandDialog token={setup.token} devices={devices} siteUrl={siteUrl} trigger={setup.trigger} notify={notify} onClose={() => setSetup(null)} />}
    {offboarding && <OffboardingDialog name={offboarding.name} tokens={active.filter(token => token.issuerRef === offboarding.issuerRef)} devices={devices} now={checkedAt}
      trigger={offboarding.trigger} onClose={() => setOffboarding(null)} onRevoked={() => { setSelected(new Set()); void reload().catch(() => {}); notify(t.toastRevoked); }}
      onConflict={() => void reload().catch(() => {})} />}
  </section>;
}
