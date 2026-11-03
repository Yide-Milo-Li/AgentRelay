"use client";
import { NewHandoff, HandoffDetail, RouteMini, ProjectTag, examples, exampleProjects, useInboxList, useHandoffDetail, listItemOf, listPath, projectCountsPath, type InboxQuery, type ThreadEntry } from "@/features/handoffs";
import { ManageProjectsDialog, ProjectFilter, useProjectRegistry } from "@/features/projects";
import { AgentGuide, useConnectedDevices, useConnectionCounts } from "@/features/agent-access";
import { DeviceChooser, DevicePicker, DevicesView, useCurrentDevice, useDeviceRegistry } from "@/features/devices";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { Plus, RefreshCw, Search, X, CircleCheck, TriangleAlert, LockKeyhole, ChevronDown, ArrowRight, Settings, Image as ImageIcon, FolderCog, Reply, NotebookPen, GitBranch } from "lucide-react";
import { LangProvider, useLang } from "@/components/providers/LanguageProvider";
import type { Lang } from "@/shared/i18n/locale";
import { api } from "@/shared/http/client";
import { formatTime } from "@/shared/formatting/date";
import { HANDOFF_LIST, type Handoff, type HandoffListItem, type HandoffListPage, type HandoffProjectCounts } from "@/shared/contracts/handoffs";
import { indexProjects, resolveProject, type ProjectIndex } from "@/shared/formatting/project-identity";
import { deviceNameKey, EMPTY_DEVICE_INDEX, isReservedDeviceName, resolveStop, unregisteredNames, type DeviceIndex } from "@/shared/formatting/device-identity";
import { adjacentItemIndex, isTextEntry, SHORTCUTS, type ShortcutId } from "@/shared/browser/keyboard-shortcuts";
import { useKeyboardShortcuts } from "@/shared/hooks/use-keyboard-shortcuts";
import { useShortcutPreference } from "@/shared/hooks/use-shortcut-preference";
import { copyText } from "@/shared/browser/clipboard";
import { dictionaries } from "@/shared/i18n/messages";
import { ShortcutHint } from "@/components/ui/ShortcutHint";
import KeyboardShortcuts from "./KeyboardShortcuts";
import SettingsView, { type SettingsSection } from "./SettingsView";
import SetupChecklist, { SetupProgress, type SetupActions, type SetupNotifications } from "./SetupChecklist";
import { setupEstablished, setupSteps } from "./setup-progress";
import { useSetupRecord } from "./use-setup-record";
import { StorageView, StorageIndicator, NotificationIndicator, useStorageSummary, useNotificationMessages, useNotificationSettings, useStaleNotificationCleanup } from "@/features/handoffs";

type View = "inbox" | "done" | "devices" | "agent" | "settings";
const TAB_SHORTCUTS: Record<View, ShortcutId> = {
  inbox: "tabInbox",
  done: "tabDone",
  devices: "tabDevices",
  agent: "tabAgents",
  settings: "tabSettings",
};
// Filter values: `d:<id>` for a registered device, `n:<name>` for a name that isn't registered, `any` for the reserved target.
function matchesTarget(row: Handoff, target: string, devices: DeviceIndex) {
  if (target === "all") return true;
  if (target === "any") return isReservedDeviceName(row.targetDevice);
  const stop = resolveStop(devices, row.targetDeviceId, row.targetDevice);
  return target.startsWith("d:") ? stop.id === target.slice(2) : !stop.registered && stop.name === target.slice(2);
}
// Project filter values: `all`, `none` for handoffs without a project, or `p:<id>`.
function matchesProject(row: Handoff, filter: string, projects: ProjectIndex) {
  if (filter === "all") return true;
  const project = resolveProject(projects, row.projectId, row.project);
  return filter === "none" ? !project : project?.id === filter.slice(2);
}
/** `initialView` is only ever the connection list, which an expiry reminder opens. */
type Props = { displayName: string | null; initialLang: Lang; initialHandoff: string | null; initialView?: "agent" | null };
export default function AgentRelayApp({ displayName, initialLang, initialHandoff, initialView = null }: Props) {
  return <LangProvider initial={initialLang}><AgentRelay displayName={displayName} initialHandoff={initialHandoff} initialView={initialView} /></LangProvider>;
}

/** The row's project, branch, image count and reply and result markers, on one line under the route; nothing when it has none of them. */
function RowMeta({ row, projects }: { row: HandoffListItem; projects: ProjectIndex }) {
  const { t } = useLang();
  const project = resolveProject(projects, row.projectId, row.project ?? ""), images = row.attachmentCount ?? 0, result = !!row.resultCharacters;
  if (!project && !images && !row.replyToId && !result && !row.branch) return null;
  return <span className="row-meta">
    {project && <ProjectTag project={project} />}
    {row.branch && <span className="row-branch" role="img" aria-label={t.git.branch(row.branch)} title={t.git.branch(row.branch)}><GitBranch size={13} aria-hidden="true" /><span>{row.branch}</span></span>}
    {images > 0 && <span className="row-images" role="img" aria-label={t.images.inboxCount(images)}><ImageIcon size={13} aria-hidden="true" /><span className="tnum">{images}</span></span>}
    {row.replyToId && <span className="row-images" role="img" aria-label={t.receipts.rowReply} title={t.receipts.rowReply}><Reply size={13} aria-hidden="true" /></span>}
    {result && <span className="row-images" role="img" aria-label={t.receipts.rowResult} title={t.receipts.rowResult}><NotebookPen size={13} aria-hidden="true" /></span>}
  </span>;
}
/** The sample's thread of a sample row, oldest first; empty when the row neither replies to another nor has replies. */
function threadOf(row: Handoff | undefined, rows: readonly Handoff[]): Handoff[] {
  if (!row) return [];
  const root = row.threadId ?? row.id;
  const items = rows.filter(item => item.id === root || item.threadId === root).sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
  return items.length > 1 || row.threadId ? items : [];
}

const NO_THREAD: readonly ThreadEntry[] = [];

function BrandMark() {
  return <svg className="brand-mark" viewBox="0 0 28 12" aria-hidden="true">
    <line x1="5" y1="6" x2="23" y2="6" />
    <circle cx="5" cy="6" r="3.6" className="from" />
    <circle cx="23" cy="6" r="3.6" className="to" />
  </svg>;
}

function AgentRelay({ displayName, initialHandoff, initialView }: { displayName: string | null; initialHandoff: string | null; initialView: "agent" | null }) {
  const { t, lang, locale, errorText } = useLang();
  const [selectedId, setSelectedId] = useState<string | null>(initialHandoff);
  // A handoff opened by id (a link, a notification, a thread entry) may sit outside the loaded list; it stays shown
  // until the person picks another one, switches views or changes a filter.
  const [pinnedId, setPinnedId] = useState<string | null>(initialHandoff);
  const [view, setView] = useState<View>(initialView ?? "inbox"), [status, setStatus] = useState("all"), [target, setTarget] = useState("all"), [search, setSearch] = useState("");
  const [projectFilter, setProjectFilter] = useState("all"), [manageProjects, setManageProjects] = useState(false);
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState<{ id: number; text: string; action?: { label: string; run: () => void } } | null>(null);
  const [compose, setCompose] = useState(false), [demo, setDemo] = useState(false), [mobileDetail, setMobileDetail] = useState(!!initialHandoff);
  // The handoff being answered while the composer is open as a reply; null for a new handoff.
  const [replyParent, setReplyParent] = useState<Handoff | null>(null);
  const [help, setHelp] = useState(false), [settingsSection, setSettingsSection] = useState<SettingsSection>("general");
  const { summary: storageSummary, error: storageError, refresh: refreshStorage } = useStorageSummary(view === "settings" && settingsSection === "storage", !demo);
  const [characters, setCharacters] = useShortcutPreference();
  const newButton = useRef<HTMLButtonElement>(null), searchInput = useRef<HTMLInputElement>(null), workspace = useRef<HTMLElement>(null);
  const rowButtons = useRef(new Map<string, HTMLButtonElement>()), app = useRef<HTMLDivElement>(null);
  const composeTrigger = useRef<HTMLElement | null>(null), focusAction = useRef<(() => void) | null>(null);
  const [focusVersion, requestFocusRender] = useState(0);
  useLayoutEffect(() => {
    focusAction.current?.();
    focusAction.current = null;
  }, [focusVersion]);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mutationFlight = useRef(false);
  // The last claim or completion made here, kept so Ctrl / ⌘ + Z can step that one handoff back.
  const lastChange = useRef<{ id: string; from: "ready" | "claimed"; to: string; version: number } | null>(null);
  // A ?handoff= deep link is read on the server, so the first render already selects it.
  const initialLink = useRef<string | null>(initialHandoff);
  const registry = useDeviceRegistry();
  // The Devices view shows how many connections each device has and can open the connection list narrowed to one device.
  const connectionCounts = useConnectionCounts(view === "devices", registry.devices), [connectionDevice, setConnectionDevice] = useState<string | null>(null);
  const { current, select: selectDevice, confirm: confirmDevice } = useCurrentDevice(registry.index, registry.loaded && !registry.error);
  // Earlier versions set every new browser to the first default device ("Laptop" / "笔记本") without asking. A browser
  // still on that unconfirmed guess is asked once, because it may be another machine.
  const guessedDevice = current.registered && !current.confirmed && (current.id === "laptop"
    || Object.values(dictionaries).some(dict => deviceNameKey(dict.devices[0]) === deviceNameKey(current.name)));
  // "Which device is this?" and the connection wizard opened from the setup checklist.
  const [chooser, setChooser] = useState(false), [agentWizard, setAgentWizard] = useState(false);
  const setup = useSetupRecord();
  const projectRegistry = useProjectRegistry(), refreshProjects = projectRegistry.refresh;

  // The top bar wraps on narrow screens; the pinned detail header and the phone layout need its real height.
  useLayoutEffect(() => {
    const bar = app.current?.querySelector<HTMLElement>(".topbar");
    if (!bar) return;
    const measure = () => app.current?.style.setProperty("--topbar-h", `${bar.offsetHeight}px`);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(bar);
    return () => observer.disconnect();
  }, []);

  // A message with an action stays longer, because the person has to read it and then decide to use it.
  const notify = useCallback((text: string, action?: { label: string; run: () => void }) => {
    setToast({ id: Date.now(), text, action });
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), action ? 8000 : 4000);
  }, []);
  useEffect(() => () => { if (toastTimer.current) clearTimeout(toastTimer.current); }, []);
  // Search runs in SQL, 300 ms after typing stops; clearing it applies at once.
  const [searched, setSearched] = useState("");
  useEffect(() => { const timer = setTimeout(() => setSearched(search), search ? 300 : 0); return () => clearTimeout(timer); }, [search]);
  // Setup also ends once any handoff is done; one row of the Done list tells, read once per visit.
  const [hasDone, setHasDone] = useState(false);
  useEffect(() => {
    api<HandoffListPage>(listPath({ scope: "done", status: "all", target: "all", project: "all", q: "" }, { limit: 1 }))
      .then(page => { if (page.handoffs.length) setHasDone(true); }, () => {});
  }, []);
  // Notifications: this browser's own state is kept right on every visit, not only while Settings is open.
  const notifications = useNotificationSettings(lang);
  // Show a handoff by id, from a notification click, the toast or a thread entry: it may sit outside the loaded list,
  // so it is read first and then opened in the view its status belongs to.
  function openHandoff(id: string) {
    setDemo(false); setStatus("all"); setTarget("all"); setProjectFilter("all"); setSearch("");
    setSelectedId(id); setPinnedId(id); setMobileDetail(true); history.replaceState(null, "", `?handoff=${id}`);
    detail.open(id).then(record => { if (record) setView(record.status === "done" ? "done" : "inbox"); }, e => notify(errorText(e)));
    void reloadHandoffs();
  }
  useNotificationMessages({
    onArrived: ({ handoffId, connectionId, progress, title, gone }) => {
      if (connectionId) { if (!gone && title) notify(title, { label: t.notifications.expiringToast, run: () => navigate("agent") }); return; }
      if (progress) {
        void reloadHandoffs();
        if (!gone && title) notify(title, handoffId ? { label: t.notifications.open, run: () => openHandoff(handoffId) } : undefined);
        return;
      }
      void reloadHandoffs();
      if (!gone) notify(t.notifications.arrived(title), handoffId ? { label: t.notifications.open, run: () => openHandoff(handoffId) } : undefined);
    },
    onOpen: openHandoff,
    onOpenConnections: () => navigate("agent"),
  });
  const samples = useMemo(() => examples(lang, t.devices), [lang, t.devices]);
  // Sample rows carry no ids, so they are shown with heuristic colours and never listed as unregistered devices.
  const routeDevices = demo ? EMPTY_DEVICE_INDEX : registry.index;
  const targetOptions = useMemo(() => [
    ...routeDevices.devices.map(device => ({ value: `d:${device.id}`, label: device.name })),
    { value: "any", label: t.devices[3] },
  ], [routeDevices, t.devices]);
  const activeTarget = targetOptions.some(option => option.value === target) ? target : "all";
  const projects = useMemo(() => demo ? indexProjects(exampleProjects()) : projectRegistry.index, [demo, projectRegistry.index]);
  const [serverCounts, setServerCounts] = useState<ReadonlyMap<string, number>>(new Map());
  const countsRead = useRef(0), scope = view === "done" ? "done" : "open";
  const readProjectCounts = useCallback((asked: InboxQuery["scope"], force = false) => {
    if (!force && Date.now() - countsRead.current < 10_000) return;
    countsRead.current = Date.now();
    api<HandoffProjectCounts>(projectCountsPath(asked)).then(result => setServerCounts(new Map(Object.entries(result.projects))), () => {});
  }, []);
  useEffect(() => { if (!demo) readProjectCounts(scope, true); }, [demo, scope, readProjectCounts]);
  const projectCounts = useMemo(() => {
    if (!demo) return serverCounts;
    const counts = new Map<string, number>();
    for (const row of samples) {
      if ((row.status === "done") !== (view === "done")) continue;
      const key = resolveProject(projects, row.projectId, row.project)?.id ?? (row.project ? null : "none");
      if (key) counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    return counts;
  }, [demo, serverCounts, samples, view, projects]);
  // Every handoff per project, both tabs, read when Manage projects opens.
  const [projectTotals, setProjectTotals] = useState<ReadonlyMap<string, number>>(new Map());
  useEffect(() => {
    if (!manageProjects) return;
    api<HandoffProjectCounts>(projectCountsPath("all")).then(result => setProjectTotals(new Map(Object.entries(result.projects))), () => {});
  }, [manageProjects]);
  const activeProject = projectFilter === "all" || projectFilter === "none" || projects.byId.has(projectFilter.slice(2)) ? projectFilter : "all";
  const filtering = !!search || activeTarget !== "all" || activeProject !== "all" || status !== "all";
  // The server filters, searches and pages real handoffs; the inbox keeps polling while other views are open, for the
  // badge and notifications.
  const inboxQuery = useMemo<InboxQuery>(() => ({ scope: view === "done" ? "done" : "open", status: view === "done" ? "all" : status as InboxQuery["status"],
    target: activeTarget, project: activeProject, q: searched }), [view, status, activeTarget, activeProject, searched]);
  const list = useInboxList(inboxQuery), rows = list.rows, loading = list.loading, error = list.error, refresh = list.refresh;
  const seenNames = useMemo(() => unregisteredNames(rows, registry.index), [rows, registry.index]);
  // Agents on other devices create projects too: a row naming an unknown project id means the registry is behind.
  const unknownProject = !demo && projectRegistry.loaded && rows.some(row => row.projectId && !projectRegistry.index.byId.has(row.projectId));
  useEffect(() => { if (unknownProject) void refreshProjects(); }, [unknownProject, refreshProjects]);
  // Registering or deleting a device, or deleting in Storage, rewrites stored handoffs: read the list again now.
  const reloadHandoffs = list.refresh;
  const openCount = list.openCount;
  // The sample is filtered here, as the server filters real handoffs.
  const sampleRows = useMemo(() => !demo ? [] : samples.filter(row => (view === "done" ? row.status === "done" : row.status !== "done")
    && (status === "all" || row.status === status) && matchesTarget(row, activeTarget, routeDevices) && matchesProject(row, activeProject, projects)
    && `${row.title}\n${row.project}\n${row.content}`.toLocaleLowerCase().includes(search.toLocaleLowerCase())).map(listItemOf),
  [demo, samples, view, status, activeTarget, routeDevices, activeProject, projects, search]);
  const filtered: HandoffListItem[] = demo ? sampleRows : rows;
  const listed = filtered.find(row => row.id === selectedId), pinned = !listed && !!pinnedId && pinnedId === selectedId;
  const selectedRow = listed ?? (pinned ? undefined : filtered[0]), selectedRowId = selectedRow?.id ?? (pinned ? pinnedId : null);
  const detail = useHandoffDetail(demo ? null : selectedRowId, selectedRow ? { version: selectedRow.version, updatedAt: selectedRow.updatedAt } : null, !demo);
  const selected: Handoff | undefined = demo ? samples.find(row => row.id === selectedRowId) : detail.detail ?? undefined;
  // A real thread is the server's, across both tabs and every filter; the sample's comes from its rows.
  const selectedThread: readonly ThreadEntry[] = demo ? threadOf(selected, samples) : selected?.thread?.items ?? NO_THREAD;
  // Only the whole unfiltered inbox shows every waiting handoff; otherwise notifications are left as they are.
  const waitingIds = useMemo(() => demo || loading || inboxQuery.scope !== "open" || filtering || list.nextCursor ? null
    : rows.filter(row => row.status === "ready").map(row => row.id), [demo, loading, inboxQuery.scope, filtering, list.nextCursor, rows]);
  useStaleNotificationCleanup(waitingIds, notifications.state === "on");
  // A ?handoff= link opens the view its handoff belongs to, once its record is read.
  useEffect(() => {
    if (!initialLink.current || detail.detail?.id !== initialLink.current) return;
    setView(detail.detail.status === "done" ? "done" : "inbox"); initialLink.current = null;
  }, [detail.detail]);
  const handoffView = view === "inbox" || view === "done";
  // Setup ends for good once the loaded handoffs prove two devices work together (or hold a finished one); this browser
  // then remembers it, so deleting or expiring those handoffs never brings the checklist back.
  const established = hasDone || setupEstablished(rows);
  const { record: setupRecord, finish: finishSetup } = setup;
  useEffect(() => { if (!demo && !loading && !error && established && !setupRecord.done) finishSetup(); }, [demo, loading, error, established, setupRecord.done, finishSetup]);
  const showSetup = !demo && !loading && !error && registry.loaded && !setupRecord.done && !setupRecord.dismissed && !established;
  // Only the inbox shows the checklist, so only the inbox polls for newly connected devices.
  const connectedDevices = useConnectedDevices(showSetup && view === "inbox");
  const steps = setupSteps({ currentId: current.id, connected: connectedDevices, record: setupRecord, rows });
  const setupActions: SetupActions = {
    chooseDevice: () => setChooser(true),
    connectAgent: () => { navigate("agent"); setAgentWizard(true); },
    copyLink: () => { copyText(window.location.origin).then(() => notify(t.setup.linkCopied), e => notify(errorText(e))); },
    confirmOther: current.id ? () => setup.confirmOther(current.id as string) : null,
    createHandoff: () => openCompose(),
  };
  const setupHidden = !demo && !loading && !error && !!setupRecord.dismissed && !setupRecord.done && !established;
  // Notifications bind to a device, so the optional step waits until this browser has chosen one.
  const boundDeviceId = notifications.settings?.subscription?.deviceId;
  const setupNotifications: SetupNotifications | null = current.id ? {
    control: notifications, deviceId: current.id, boundName: registry.devices.find(device => device.id === boundDeviceId)?.name ?? current.name,
    openSettings: () => { setSettingsSection("notifications"); navigate("settings"); },
  } : null;
  const setupProps = { steps, deviceName: current.name, otherName: registry.devices.find(device => device.id !== current.id)?.name ?? t.setup.otherDevice,
    siteUrl: typeof window === "undefined" ? "" : window.location.origin, actions: setupActions, notifications: setupNotifications, onDismiss: setup.dismiss };
  const deepLinkMissing = !demo && !!selectedId && detail.missing === selectedId;

  function navigate(next: View) {
    setPinnedId(null); setView(next); setConnectionDevice(null); setAgentWizard(false); setStatus("all"); setSearch(""); setMobileDetail(false);
    // Each view starts at its top: the stage scrolls on desktop and the page itself on phones.
    document.querySelector(".stage")?.scrollTo(0, 0); window.scrollTo(0, 0);
  }
  function afterRender(action: () => void) {
    // Couple focus to the actual commit rather than racing native dialog events with a timer.
    focusAction.current = action;
    requestFocusRender(version => version + 1);
  }
  function focusRow() {
    // Read the committed selection, including after a status change removes the old detail.
    const button = workspace.current?.querySelector<HTMLButtonElement>('.row[aria-current="true"]');
    (button || searchInput.current)?.focus();
    button?.scrollIntoView({ block: "nearest" });
  }
  function backToList() { setMobileDetail(false); afterRender(focusRow); }
  function openCompose(parent: Handoff | null = null) {
    composeTrigger.current = document.activeElement instanceof HTMLElement && document.activeElement !== document.body ? document.activeElement : newButton.current;
    setReplyParent(parent);
    setCompose(true);
  }
  function closeCompose() {
    setCompose(false);
    afterRender(() => {
      const previous = composeTrigger.current;
      (previous?.isConnected && previous.getClientRects().length ? previous : newButton.current)?.focus();
    });
  }
  function focusPrompt() { workspace.current?.querySelector<HTMLElement>(".prompt")?.focus(); }
  function select(row: HandoffListItem, enter = false) {
    setSelectedId(row.id); setPinnedId(null); setMobileDetail(true);
    if (!demo) history.replaceState(null, "", `?handoff=${row.id}`);
    if (enter) afterRender(focusPrompt);
  }
  function moveSelection(direction: -1 | 1) {
    if (!handoffView || (mobileDetail && matchMedia("(max-width: 720px)").matches) || (loading && !demo)) return false;
    const index = adjacentItemIndex(filtered.length, filtered.findIndex(row => row.id === selectedRowId), direction);
    // Past the last loaded row, the next page comes in and the selection stays until it arrives.
    if (index === null) { if (direction === 1 && !demo && list.nextCursor) { void list.loadMore(); return true; } return false; }
    const row = filtered[index];
    setSelectedId(row.id); setPinnedId(null); setMobileDetail(false);
    if (!demo) history.replaceState(null, "", `?handoff=${row.id}`);
    afterRender(() => { const button = rowButtons.current.get(row.id); button?.focus(); button?.scrollIntoView({ block: "nearest" }); });
    return true;
  }
  /** A thread item may sit in the other tab or behind a filter; samples are switched to in place, real handoffs read again. */
  function openThreadItem(id: string) {
    if (!demo) { openHandoff(id); return; }
    const row = samples.find(item => item.id === id);
    if (!row) return;
    setStatus("all"); setTarget("all"); setProjectFilter("all"); setSearch("");
    setView(row.status === "done" ? "done" : "inbox"); setSelectedId(id); setMobileDetail(true);
  }
  function startDemo() { setDemo(true); setStatus("all"); setTarget("all"); setProjectFilter("all"); setSearch(""); setSelectedId(samples[0].id); }
  /** `result` is the receipt of a completion written in the browser; it is sent only with `done`. */
  async function update(next: string, result?: string) {
    if (!selected || busy || demo || mutationFlight.current) return;
    if (!current.chosen) { setChooser(true); return; }
    const row = selected, origin = document.activeElement;
    const fromDetail = !!workspace.current?.querySelector(".detail")?.contains(origin);
    const restoreFocus = () => fromDetail && !!workspace.current && !document.querySelector("dialog[open]") &&
      (document.activeElement === origin || document.activeElement === document.body);
    const leavesList = (view === "done") !== (next === "done") || (status !== "all" && status !== next);
    // Lock synchronously: two key events can arrive before React renders the disabled controls.
    mutationFlight.current = true;
    setBusy(true);
    try {
      const updated = await api<Handoff>(`/api/handoffs/${row.id}`, "PATCH", { status: next, version: row.version, device: current.id ?? current.name,
        ...(next === "done" && result ? { result } : {}) });
      detail.store(updated); list.applyWrite(updated); void refresh(); readProjectCounts(scope, true);
      if (updated.status === "done") setHasDone(true);
      const undoable = (row.status === "ready" && next === "claimed") || (row.status === "claimed" && next === "done");
      lastChange.current = undoable ? { id: row.id, from: row.status as "ready" | "claimed", to: next, version: updated.version } : null;
      if (restoreFocus()) {
        if (leavesList) setMobileDetail(false);
        afterRender(() => {
          const activeRow = workspace.current?.querySelector('.row[aria-current="true"]');
          if (!leavesList && activeRow === rowButtons.current.get(row.id)) focusPrompt(); else focusRow();
        });
      }
      notify(next === "done" ? t.toastDone : next === "claimed" ? t.toastClaimed : t.toastRequeued, undoable ? { label: t.undo, run: () => void undo() } : undefined);
      void refreshStorage();
    } catch (e) {
      notify(errorText(e)); await refresh();
      // Re-sync after a conflict without reapplying the action to a newly selected record.
      if (restoreFocus()) { setMobileDetail(false); afterRender(focusRow); }
    } finally { mutationFlight.current = false; setBusy(false); }
  }
  /** Targets the recorded handoff, not the current selection; the server refuses it once anyone else has moved that handoff on. */
  async function undo() {
    const change = lastChange.current;
    if (!change || demo || mutationFlight.current) return;
    lastChange.current = null;
    mutationFlight.current = true;
    setBusy(true);
    try {
      const updated = await api<Handoff>(`/api/handoffs/${change.id}`, "PATCH", { status: change.from, version: change.version, undo: true });
      detail.store(updated); list.applyWrite(updated); void refresh(); readProjectCounts(scope, true);
      notify(change.from === "ready" ? t.toastUndoClaim : t.toastUndoComplete);
      void refreshStorage();
    } catch (e) { notify(errorText(e)); await refresh(); } finally { mutationFlight.current = false; setBusy(false); }
  }
  async function remove() {
    if (!selected || busy || demo || mutationFlight.current) return;
    mutationFlight.current = true;
    setBusy(true);
    try {
      await api(`/api/handoffs/${selected.id}`, "DELETE", { version: selected.version });
      if (lastChange.current?.id === selected.id) lastChange.current = null;
      list.remove(selected.id); detail.forget(selected.id); void refresh(); readProjectCounts(scope, true); setSelectedId(null); setPinnedId(null); setMobileDetail(false); history.replaceState(null, "", "/"); notify(t.toastDeleted);
      void refreshStorage();
    } catch (e) { notify(errorText(e)); } finally { mutationFlight.current = false; setBusy(false); }
  }

  useKeyboardShortcuts({
    tabInbox: () => { navigate("inbox"); afterRender(() => document.querySelector<HTMLButtonElement>('button.tab[data-view="inbox"]')?.focus()); return true; },
    tabDone: () => { navigate("done"); afterRender(() => document.querySelector<HTMLButtonElement>('button.tab[data-view="done"]')?.focus()); return true; },
    tabDevices: () => { navigate("devices"); afterRender(() => document.querySelector<HTMLButtonElement>('button.tab[data-view="devices"]')?.focus()); return true; },
    tabAgents: () => { navigate("agent"); afterRender(() => document.querySelector<HTMLButtonElement>('button.tab[data-view="agent"]')?.focus()); return true; },
    tabSettings: () => { navigate("settings"); afterRender(() => document.querySelector<HTMLButtonElement>(".settings-button")?.focus()); return true; },
    create: () => { openCompose(); return true; },
    help: () => { setHelp(true); return true; },
    search: () => {
      if (!handoffView) return false;
      setMobileDetail(false); afterRender(() => searchInput.current?.focus()); return true;
    },
    undo: () => {
      if (!lastChange.current || demo || mutationFlight.current) return false;
      void undo(); return true;
    },
    next: () => moveSelection(1),
    previous: () => moveSelection(-1),
    open: event => {
      const row = filtered.find(item => rowButtons.current.get(item.id) === event.target);
      if (!row) return false;
      select(row, true); return true;
    },
    escape: event => {
      if (event.target === searchInput.current) {
        if (search) setSearch(""); else focusRow();
        return true;
      }
      if (isTextEntry(event.target) || !handoffView || !mobileDetail || !matchMedia("(max-width: 720px)").matches) return false;
      backToList(); return true;
    },
  }, { characters });

  const tabs: [View, string][] = [["inbox", t.navInbox], ["done", t.navDone], ["devices", t.navDevices], ["agent", t.navAgents]];
  // Names offered while composing: registered devices first, then the ones seen in handoffs and this browser's own name.
  // Both sender and recipient must be registered devices (clean namespace).
  const registeredNames = registry.devices.map(device => device.name);
  const sourceSuggestions = registeredNames;
  const targetSuggestions = Array.from(new Set([...registeredNames, t.devices[3]]));
  // Default to where this device last sent work; otherwise another registered device, or the other common machine.
  function pickDefaultTarget() {
    for (const row of rows) {
      const stop = resolveStop(registry.index, row.targetDeviceId, row.targetDevice, t.devices[3]);
      if (stop.registered && (current.id ? stop.id !== current.id : deviceNameKey(stop.name) !== deviceNameKey(current.name))) return stop.name;
    }
    return registry.devices.find(device => device.id !== current.id)?.name ?? t.devices[3];
  }
  const emptyTitle = loading ? t.emptyLoadingTitle : filtering ? t.emptyFilteredTitle : view === "done" ? t.emptyDoneTitle : t.emptyInboxTitle;
  const emptyBody = loading ? t.emptyLoadingBody : filtering ? t.emptyFilteredBody : view === "done" ? t.emptyDoneBody : t.emptyInboxBody;

  return <div className="app" ref={app}>
    <header className="topbar">
      {/* Prefetch is off: the brand points at this same page, and vinext's prefetch setup throws in this build. */}
      <Link className="brand" href="/" prefetch={false} aria-label={t.home}><BrandMark /><span>AgentRelay</span></Link>
      <nav className="tabs" aria-label={t.mainNav}>
        {tabs.map(([name, label]) => <button key={name} className="tab" data-view={name} aria-current={view === name ? "page" : undefined}
          aria-keyshortcuts={characters ? SHORTCUTS[TAB_SHORTCUTS[name]].aria : undefined} onClick={() => navigate(name)}>
          {label}{name === "inbox" && openCount > 0 && <span className="tab-count tnum">{openCount}</span>}
        </button>)}
      </nav>
      <div className="top-tools">
        <DevicePicker devices={registry.devices} current={current} onSelect={device => selectDevice({ id: device.id, name: device.name })} onManage={() => navigate("devices")} />
        <button className="icon settings-button" aria-current={view === "settings" ? "page" : undefined} aria-label={t.settings.open} title={t.settings.open}
          aria-keyshortcuts={characters ? SHORTCUTS.tabSettings.aria : undefined} onClick={() => navigate("settings")}><Settings size={18} /></button>
        <button ref={newButton} className="btn primary new" onClick={() => openCompose()} aria-label={t.newHandoff} aria-keyshortcuts={characters ? SHORTCUTS.create.aria : undefined}><Plus size={17} /><span>{t.newHandoff}</span>{characters && <ShortcutHint action="create" />}</button>
      </div>
    </header>

    <main className="stage">
      {!!list.error && <div className="banner warn" role="alert"><TriangleAlert size={16} /><span>{errorText(list.error)}</span><button className="link" onClick={() => refresh()}>{t.retry}</button></div>}
      {view === "settings" ? <SettingsView section={settingsSection} onSection={setSettingsSection} displayName={displayName} deviceName={current.name}
          notifications={notifications} devices={registry.devices} currentDeviceId={current.id} notify={notify}
          setupHidden={setupHidden} onShowSetup={() => { setup.reopen(); navigate("inbox"); }}
          characters={characters} onCharactersChange={setCharacters} onShowShortcuts={() => setHelp(true)}
          storage={demo ? <div className="storage-view"><p className="banner note">{t.storage.sampleNote}</p><button className="btn" onClick={() => { setDemo(false); setSelectedId(null); }}>{t.exitSample}</button></div>
            : <StorageView projects={projectRegistry.projects} summary={storageSummary} summaryError={storageError} refreshSummary={refreshStorage} onDeleted={async () => {
                setSelectedId(null); setMobileDetail(false); history.replaceState(null, "", "/");
                await Promise.all([reloadHandoffs(), refreshStorage()]);
              }} />} /> : view === "agent" ? <AgentGuide notify={notify} devices={registry.devices} currentDeviceId={current.id} initialDevice={connectionDevice}
              // A device added in the wizard by a browser that has none is most likely this one.
              onCreateDevice={async name => { const device = await registry.create({ name }); if (!current.chosen) selectDevice({ id: device.id, name: device.name }); return device; }}
              startWizard={agentWizard} onPluginConfirmed={setup.confirmPlugin} />
        : view === "devices" ? <DevicesView registry={registry} current={current} seen={seenNames} notify={notify} onChanged={reloadHandoffs}
            connections={connectionCounts} onOpenConnections={id => { navigate("agent"); setConnectionDevice(id); }}
            onUseHere={device => { selectDevice({ id: device.id, name: device.name }); notify(t.toastUsingDevice(device.name)); }} /> :
        <section ref={workspace} className={`workspace ${mobileDetail && selectedRowId ? "show-detail" : ""}`} aria-label={t.inboxLabel}>
          <div className="list-pane">
            <div className="list-tools">
              <label className="search"><Search size={16} aria-hidden="true" /><input ref={searchInput} maxLength={HANDOFF_LIST.searchCharacters} aria-label={t.search} aria-keyshortcuts={characters ? SHORTCUTS.search.aria : undefined} value={search} onChange={e => { setPinnedId(null); setSearch(e.target.value); }} placeholder={t.search} />
                {characters && !search && <ShortcutHint action="search" />}
                {search && <button className="icon" aria-label={t.clearSearch} onClick={() => { setPinnedId(null); setSearch(""); }}><X size={15} /></button>}</label>
              <div className="filters">
                {view !== "done" && <div className="segmented" role="group" aria-label={t.statusGroup}>
                  {(["all", "ready", "claimed"] as const).map(value => <button key={value} aria-pressed={status === value} onClick={() => { setPinnedId(null); setStatus(value); }}>{value === "all" ? t.statusAll : t.status[value]}</button>)}
                </div>}
                <div className="filter-selects">
                <label className="select-quiet"><select aria-label={t.filterTarget} value={activeTarget} onChange={e => { setPinnedId(null); setTarget(e.target.value); }}>
                  <option value="all">{t.allDevices}</option>{targetOptions.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
                </select><ChevronDown size={14} aria-hidden="true" /></label>
                <ProjectFilter projects={projects.projects} counts={projectCounts} value={activeProject} onChange={value => { setPinnedId(null); setProjectFilter(value); }} onOpen={demo ? undefined : () => readProjectCounts(scope)} />
                {!demo && <button type="button" className="icon small" title={t.manageProjects} aria-label={t.manageProjects} onClick={() => setManageProjects(true)}><FolderCog size={15} /></button>}
                </div>
              </div>
            </div>
            {showSetup && rows.length > 0 && view === "inbox" && <SetupProgress {...setupProps} />}
            {!showSetup && !demo && registry.loaded && registry.devices.length > 0 && !current.registered && <div className="banner note"><span>{t.deviceUnknown}</span>
              <button className="link" onClick={() => setChooser(true)}>{t.goToRegisterDevice}</button></div>}
            {!demo && guessedDevice && <div className="banner note device-guess"><span>{t.legacyDeviceAsk(current.name)}</span>
              <button className="link" onClick={confirmDevice}>{t.legacyDeviceYes}</button>
              <button className="link" onClick={() => setChooser(true)}>{t.legacyDeviceOther}</button></div>}
            {demo && <div className="banner note"><span>{t.sampleBoundary}</span><button className="link" onClick={() => { setDemo(false); setSelectedId(null); }}>{t.exitSample}</button></div>}
            {deepLinkMissing && !demo && <div className="banner warn"><TriangleAlert size={16} /><span>{t.linkMissing}</span><button className="link" onClick={() => { setSelectedId(null); history.replaceState(null, "", "/"); }}>{t.dismiss}</button></div>}
            <div className="list">
              {loading && !demo ? <p className="list-empty">{t.loadingList}</p>
                : filtered.length ? filtered.map((row, i) => <button key={row.id} ref={element => { if (element) rowButtons.current.set(row.id, element); else rowButtons.current.delete(row.id); }} className="row" aria-current={selectedRowId === row.id ? "true" : undefined}
                    style={{ "--i": Math.min(i, 8) } as React.CSSProperties} onClick={() => select(row)}>
                    <span className="row-head"><strong>{demo && <em className="tag">{t.sample}</em>}{row.title}</strong><time className="tnum">{formatTime(row.createdAt, locale)}</time></span>
                    <RouteMini row={row} devices={routeDevices} />
                    <RowMeta row={row} projects={projects} />
                  </button>)
                : showSetup && rows.length === 0 && view !== "done" && !filtering
                  // Phones show only this pane until a handoff is opened, so the checklist sits here for them.
                  ? <><p className="list-empty wide-only">{t.emptyList}</p><div className="list-setup"><SetupChecklist {...setupProps} onSample={startDemo} /></div></>
                  : <p className="list-empty">{filtering ? t.noMatch : t.emptyList}</p>}
              {!demo && !loading && list.nextCursor && <button type="button" className="btn small quiet list-more" disabled={list.loadingMore}
                onClick={() => void list.loadMore()}>{list.loadingMore ? t.loadingMore : t.showMore}</button>}
            </div>
            <footer className="list-foot">
              <span className="owner"><LockKeyhole size={13} aria-hidden="true" />{t.workspaceNeutral}</span>
              <span className="foot-status">
              {!demo && <NotificationIndicator control={notifications} onOpen={() => { setSettingsSection("notifications"); navigate("settings"); }} />}
              {!demo && <StorageIndicator summary={storageSummary} stale={!!storageError} onOpen={() => { setSettingsSection("storage"); navigate("settings"); }} />}
              <button className={`sync ${list.connected ? "online" : ""}`} onClick={() => refresh()} title={t.syncHint} aria-label={`${t.refresh} · ${t.syncHint}`}>
                <RefreshCw size={13} className={loading ? "spin" : ""} aria-hidden="true" />{loading ? t.syncConnecting : list.connected ? t.syncOnline : t.syncOffline}
              </button>
              </span>
            </footer>
          </div>
          <div className="detail-pane">
            {selected
              ? <HandoffDetail key={selected.id} row={selected} thread={selectedThread} devices={routeDevices} projects={projects} demo={demo} busy={busy} characters={characters} chosen={selected.id === selectedId}
                  onStatus={update} onDelete={remove} onBack={backToList} onReply={() => openCompose(selected)} onOpen={openThreadItem} notify={notify} />
              // Its summary shows at once; the text follows with the record.
              : selectedRowId && !demo && !deepLinkMissing ? <article className="detail detail-loading" aria-busy="true">
                  <header className="detail-head"><h1>{selectedRow?.title ?? ""}</h1>
                    {selectedRow && <RouteMini row={selectedRow} devices={routeDevices} />}</header>
                  <p className="muted">{t.loadingHandoff}</p></article>
              : showSetup && rows.length === 0 && view !== "done" && !filtering ? <div className="empty setup-empty"><SetupChecklist {...setupProps} onSample={startDemo} /></div>
              : <div className="empty">
                  <svg className="empty-line" viewBox="0 0 220 24" aria-hidden="true"><line x1="12" y1="12" x2="208" y2="12" /><circle cx="12" cy="12" r="6" /><circle cx="110" cy="12" r="4" /><circle cx="208" cy="12" r="6" /></svg>
                  <h2>{emptyTitle}</h2><p>{emptyBody}</p>
                  {!loading && view !== "done" && !filtering && <div className="empty-actions">
                    <button className="btn primary" onClick={() => openCompose()}><Plus size={17} />{rows.length ? t.newHandoff : t.createFirst}</button>
                    {!demo && <button className="link" onClick={startDemo}>{t.seeSample}<ArrowRight size={15} /></button>}
                  </div>}
                  <p className="empty-foot"><LockKeyhole size={13} aria-hidden="true" />{t.privateNote}</p>
                </div>}
          </div>
        </section>}
    </main>
    {manageProjects && <ManageProjectsDialog registry={projectRegistry} counts={projectTotals} notify={notify} onChanged={reloadHandoffs} onClose={() => setManageProjects(false)} />}
    {help && <KeyboardShortcuts onClose={() => setHelp(false)} />}
    {chooser && <DeviceChooser registry={registry} currentId={current.id} notify={notify} onClose={() => setChooser(false)}
      onChoose={device => { selectDevice({ id: device.id, name: device.name }); notify(t.toastUsingDevice(device.name)); }} />}
    {compose && <NewHandoff device={current.registered ? current.name : (registry.devices[0]?.name ?? current.name)} isCurrentRegistered={current.registered} devices={registry.index} projects={projectRegistry.index} sourceSuggestions={sourceSuggestions} targetSuggestions={targetSuggestions}
      defaultTarget={replyParent ? resolveStop(registry.index, replyParent.sourceDeviceId, replyParent.sourceDevice, t.devices[3]).name : pickDefaultTarget()}
      replyTo={replyParent} defaultProject={replyParent ? resolveProject(projectRegistry.index, replyParent.projectId, replyParent.project)?.name ?? replyParent.project : ""}
      onClose={closeCompose} onChooseDevice={() => setChooser(true)} onCreated={row => {
      detail.store(row); list.prepend(row); readProjectCounts("open", true); setCompose(false); setDemo(false); setView("inbox"); setStatus("all"); setTarget("all"); setProjectFilter("all"); setSearch("");
      setSelectedId(row.id); setPinnedId(row.id); setMobileDetail(true); history.replaceState(null, "", `?handoff=${row.id}`); notify(t.toastCreated); afterRender(focusPrompt);
      void refreshStorage(); void refreshProjects();
    }} />}
    {toast && <div className="toast" role="status" key={toast.id}><CircleCheck size={16} aria-hidden="true" /><span>{toast.text}</span>
      {toast.action && <button className="link toast-action" onClick={() => { toast.action?.run(); setToast(null); }}>{toast.action.label}</button>}
      <button className="icon" aria-label={t.closeToast} onClick={() => setToast(null)}><X size={14} /></button></div>}
  </div>;
}
