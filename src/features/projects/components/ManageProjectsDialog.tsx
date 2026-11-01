"use client";
import { useLayoutEffect, useRef } from "react";
import { X } from "lucide-react";
import { useLang } from "@/components/providers/LanguageProvider";
import { containDialogFocus } from "@/shared/browser/keyboard-shortcuts";
import type { ProjectRegistry } from "../hooks/use-project-registry";
import ProjectRow from "./ProjectRow";

type Props = {
  registry: ProjectRegistry;
  /** Loaded handoffs per project id. */
  counts: ReadonlyMap<string, number>;
  /** Rename, merge and delete rewrite handoff snapshots, so the caller reloads them. */
  onChanged: () => void;
  onClose: () => void;
  notify: (message: string) => void;
};

/** Active projects first, archived ones in their own list. Nothing here deletes a handoff. */
export default function ManageProjectsDialog({ registry, counts, onChanged, onClose, notify }: Props) {
  const { t } = useLang();
  const dialog = useRef<HTMLDialogElement>(null), closeButton = useRef<HTMLButtonElement>(null);
  useLayoutEffect(() => {
    // Native modal focus and inertness, returning focus to the opener like the other dialogs.
    const element = dialog.current, previous = document.activeElement;
    element?.showModal();
    closeButton.current?.focus();
    return () => { element?.close(); if (previous instanceof HTMLElement && previous.isConnected) previous.focus(); };
  }, []);
  const active = registry.projects.filter(project => !project.archived), archived = registry.projects.filter(project => project.archived);
  const row = (project: (typeof registry.projects)[number]) => <ProjectRow key={project.id} project={project} registry={registry} notify={notify}
    others={registry.projects.filter(other => other.id !== project.id)} count={counts.get(project.id) ?? 0}
    onChanged={onChanged} onRemoved={() => closeButton.current?.focus()} />;

  return <dialog ref={dialog} className="compose project-manage" aria-labelledby="project-manage-title" aria-describedby="project-manage-sub"
    onCancel={event => { event.preventDefault(); onClose(); }} onKeyDown={event => containDialogFocus(event, dialog.current)}>
    <header className="compose-head">
      <div><h2 id="project-manage-title">{t.projectsTitle}</h2><p id="project-manage-sub">{t.projectsSub}</p></div>
      <button ref={closeButton} type="button" className="icon" aria-label={t.close} onClick={onClose}><X size={18} /></button>
    </header>
    {registry.projects.length === 0 ? <p className="project-empty">{t.projectsEmpty}</p> : <>
      {active.length > 0 && <ul className="project-list" aria-label={t.projectsTitle}>{active.map(row)}</ul>}
      {archived.length > 0 && <>
        <h3 className="project-list-heading">{t.projectArchived}</h3>
        <ul className="project-list" aria-label={t.projectArchived}>{archived.map(row)}</ul>
      </>}
    </>}
  </dialog>;
}
