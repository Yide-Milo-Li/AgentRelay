"use client";
import { useEffect, useRef, useState } from "react";
import { Archive, ArchiveRestore, Combine, Ellipsis, Pencil, Trash2 } from "lucide-react";
import { useLang } from "@/components/providers/LanguageProvider";
import { PROJECT_NAME_MAX, type Project } from "@/shared/contracts/projects";
import type { ProjectRegistry } from "../hooks/use-project-registry";

type Props = {
  project: Project;
  /** Other projects this one can be merged into. */
  others: readonly Project[];
  /** Loaded handoffs filed under the project. */
  count: number;
  registry: ProjectRegistry;
  onChanged: () => void;
  /** Called after the row's project is gone, so focus can move somewhere that still exists. */
  onRemoved: () => void;
  notify: (message: string) => void;
};

type Panel = "merge" | "delete" | null;

export default function ProjectRow({ project, others, count, registry, onChanged, onRemoved, notify }: Props) {
  const { t, errorText } = useLang();
  const [editing, setEditing] = useState(false), [draft, setDraft] = useState(project.name), [menu, setMenu] = useState(false);
  const [panel, setPanel] = useState<Panel>(null), [into, setInto] = useState(""), [busy, setBusy] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null), moreButton = useRef<HTMLButtonElement>(null), nameInput = useRef<HTMLInputElement>(null);
  const panelFirst = useRef<{ focus: () => void } | null>(null), renaming = useRef(false);

  useEffect(() => {
    if (!menu) return;
    const close = (event: Event) => { if (!menuRef.current?.contains(event.target as Node)) setMenu(false); };
    menuRef.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, [menu]);
  useEffect(() => { if (editing) { nameInput.current?.focus(); nameInput.current?.select(); } }, [editing]);
  useEffect(() => { if (panel) panelFirst.current?.focus(); }, [panel]);

  function open(next: Panel) { setMenu(false); setInto(others[0]?.id ?? ""); setPanel(next); }
  function closePanel() { setPanel(null); moreButton.current?.focus(); }
  function startRename() { setMenu(false); setDraft(project.name); renaming.current = true; setEditing(true); }
  async function saveName() {
    // Enter and the blur it causes both arrive here; only the first one counts.
    if (!renaming.current) return;
    renaming.current = false; setEditing(false);
    const next = draft.trim();
    if (!next || next === project.name) return;
    setBusy(true);
    try { await registry.update(project, { name: next }); notify(t.toastProjectRenamed); onChanged(); } catch (e) { notify(errorText(e)); } finally { setBusy(false); }
  }
  async function toggleArchive() {
    setMenu(false); setBusy(true);
    try {
      await registry.update(project, { archived: !project.archived });
      notify(project.archived ? t.toastProjectUnarchived(project.name) : t.toastProjectArchived(project.name));
    } catch (e) { notify(errorText(e)); } finally { setBusy(false); moreButton.current?.focus(); }
  }
  async function merge() {
    const target = others.find(other => other.id === into);
    if (!target) return;
    setBusy(true);
    try {
      const result = await registry.merge(project, target);
      notify(t.toastProjectMerged(project.name, result.into.name, result.movedHandoffs)); onChanged(); onRemoved();
    } catch (e) { notify(errorText(e)); setBusy(false); }
  }
  async function remove() {
    setBusy(true);
    try { await registry.remove(project); notify(t.toastProjectDeleted(project.name)); onChanged(); onRemoved(); }
    catch (e) { notify(errorText(e)); setBusy(false); }
  }

  return <li className="project-row" data-line={project.line} data-menu-open={menu || undefined}
    onKeyDown={event => {
      if (event.key !== "Escape") return;
      // Consume Escape for the innermost open layer so the dialog stays open.
      if (menu) { setMenu(false); moreButton.current?.focus(); }
      else if (panel) closePanel();
      else return;
      event.preventDefault(); event.stopPropagation();
    }}>
    <div className="project-head">
      <i className="project-swatch" aria-hidden="true" />
      <div className="project-title">
        {editing
          ? <input ref={nameInput} className="device-rename" aria-label={t.projectRenameLabel(project.name)} value={draft} maxLength={PROJECT_NAME_MAX}
              onChange={event => setDraft(event.target.value)} onBlur={saveName}
              onKeyDown={event => {
                if (event.key === "Enter") { event.preventDefault(); void saveName(); }
                else if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); renaming.current = false; setEditing(false); moreButton.current?.focus(); }
              }} />
          : <strong>{project.name}</strong>}
        <span className="project-count tnum">{t.count(count)}</span>
      </div>
      <div className="menu-wrap" ref={menuRef} data-menu-open={menu || undefined}>
        <button ref={moreButton} type="button" className="icon" title={t.more} aria-label={t.projectMenu(project.name)} aria-haspopup="menu" aria-expanded={menu} disabled={busy} onClick={() => setMenu(value => !value)}><Ellipsis size={17} /></button>
        {menu && <div className="menu" role="menu" data-shortcut-layer>
          <button role="menuitem" onClick={startRename}><Pencil size={15} />{t.projectRename}</button>
          <button role="menuitem" disabled={!others.length} title={others.length ? undefined : t.projectMergeNone} onClick={() => open("merge")}><Combine size={15} />{t.projectMerge}</button>
          <button role="menuitem" onClick={toggleArchive}>{project.archived ? <ArchiveRestore size={15} /> : <Archive size={15} />}{project.archived ? t.projectUnarchive : t.projectArchive}</button>
          <button role="menuitem" className="danger" onClick={() => open("delete")}><Trash2 size={15} />{t.projectDelete}</button>
        </div>}
      </div>
    </div>
    {panel === "merge" && <div className="confirm project-confirm" role="group" aria-label={t.projectMergeAsk(project.name)} data-shortcut-layer>
      <div>
        <label className="project-merge-target"><strong>{t.projectMergeAsk(project.name)}</strong>
          <select ref={element => { panelFirst.current = element; }} aria-label={t.projectMergeTarget} value={into} onChange={event => setInto(event.target.value)}>
            {others.map(other => <option key={other.id} value={other.id}>{other.name}</option>)}
          </select></label>
        <p>{t.projectMergeNote(count, project.name)}</p>
      </div>
      <button className="btn" onClick={closePanel}>{t.cancel}</button>
      <button className="btn danger" disabled={busy || !into} onClick={merge}>{busy ? t.working : t.projectMergeYes}</button>
    </div>}
    {panel === "delete" && <div className="confirm project-confirm" role="alert" data-shortcut-layer>
      <div><strong>{t.projectDeleteAsk(project.name)}</strong><p>{t.projectDeleteNote(count)}</p></div>
      <button ref={element => { panelFirst.current = element; }} className="btn" onClick={closePanel}>{t.cancel}</button>
      <button className="btn danger" disabled={busy} onClick={remove}>{busy ? t.working : t.projectDelete}</button>
    </div>}
  </li>;
}
