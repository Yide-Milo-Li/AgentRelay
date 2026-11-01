"use client";
import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { Check, ChevronDown, Plus } from "lucide-react";
import { useLang } from "@/components/providers/LanguageProvider";
import type { Project } from "@/shared/contracts/projects";
import { PROJECT_NAME_MAX } from "@/shared/contracts/projects";
import { projectDisplayName, projectNameKey, resolveProject, type ProjectIndex } from "@/shared/formatting/project-identity";

type Props = {
  name: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  projects: ProjectIndex;
  disabled?: boolean;
};

/**
 * Pick an existing project, type a new name (sent as is; the server creates the project), or leave it empty for no
 * project. Names match by key, so `web app` selects `web-app` and is replaced by its stored spelling on blur.
 */
export default function ProjectCombobox({ name, label, value, onChange, projects, disabled = false }: Props) {
  const { t } = useLang();
  const [open, setOpen] = useState(false), [filtering, setFiltering] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null), inputRef = useRef<HTMLInputElement>(null), menuRef = useRef<HTMLDivElement>(null);
  const inputId = useId(), listId = `${inputId}-listbox`;

  const key = projectNameKey(value), match = key ? projects.byKey.get(key) : undefined;
  const shown = resolveProject(projects, null, projectDisplayName(value));
  // Archived projects stay out of the idle list but are found by typing; sending to one restores it.
  const options: readonly Project[] = filtering && key
    ? projects.projects.filter(project => projectNameKey(project.name).includes(key))
    : projects.projects.filter(project => !project.archived);
  const offerCreate = filtering && !!key && !match;

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => { if (!wrapRef.current?.contains(event.target as Node)) { setOpen(false); setFiltering(false); } };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [open]);

  function close() { setOpen(false); setFiltering(false); }
  function choose(next: string) { onChange(next); close(); inputRef.current?.focus(); }
  function show() { if (!disabled && !open) { setOpen(true); setFiltering(false); } }
  function handleBlur() {
    if (match && match.name !== value) onChange(match.name);
    else if (!match && value !== projectDisplayName(value)) onChange(projectDisplayName(value));
  }
  function move(step: 1 | -1) {
    const items = Array.from(menuRef.current?.querySelectorAll<HTMLButtonElement>("button") ?? []);
    if (!items.length) return;
    const at = items.indexOf(document.activeElement as HTMLButtonElement);
    if (step === -1 && at <= 0) { inputRef.current?.focus(); return; }
    items[at < 0 ? 0 : (at + step) % items.length]?.focus();
  }
  function handleKeyDown(event: KeyboardEvent<HTMLElement>) {
    if (event.key === "Escape" && open) { event.preventDefault(); event.stopPropagation(); close(); inputRef.current?.focus(); }
    else if (event.key === "ArrowDown") { event.preventDefault(); if (open) move(1); else show(); }
    else if (event.key === "ArrowUp" && open) { event.preventDefault(); move(-1); }
    else if (event.key === "Tab" && open) close();
  }

  return <div className="field" data-line={shown?.line ?? "neutral"}>
    <label className="field-label" htmlFor={inputId}>{label}<span className="optional">{t.optional}</span></label>
    <div className="device-combobox-wrap" ref={wrapRef} onKeyDown={handleKeyDown}>
      <span className="line-input project-input" data-empty={!shown || undefined} data-new={(shown && !match) || undefined}>
        <i aria-hidden="true" />
        <input ref={inputRef} id={inputId} name={name} value={value} maxLength={PROJECT_NAME_MAX} disabled={disabled}
          placeholder={t.fieldProjectPh} autoComplete="off" role="combobox" aria-expanded={open} aria-haspopup="listbox"
          aria-controls={open ? listId : undefined} aria-describedby={shown && !match ? `${inputId}-new` : undefined}
          onChange={event => { onChange(event.target.value); setFiltering(true); setOpen(true); }} onClick={show} onBlur={handleBlur} />
        <button type="button" className="device-toggle" tabIndex={-1} aria-label={label} aria-expanded={open} disabled={disabled}
          onClick={() => { if (disabled) return; setFiltering(false); setOpen(previous => !previous); }}>
          <ChevronDown className="device-chevron" size={14} aria-hidden="true" />
        </button>
      </span>
      {open && <div ref={menuRef} id={listId} className="menu device-menu device-combobox-menu project-menu" role="listbox" aria-label={label} data-shortcut-layer>
        {!filtering && <button type="button" role="option" aria-selected={!value.trim()} className="project-menu-none" onClick={() => choose("")}>
          <i className="swatch" aria-hidden="true" /><span className="device-menu-name">{t.noProject}</span>
          {!value.trim() && <Check className="device-menu-check" size={15} aria-hidden="true" />}
        </button>}
        {options.map(project => {
          const checked = project.id === match?.id;
          return <button key={project.id} type="button" role="option" aria-selected={checked} data-line={project.line} onClick={() => choose(project.name)}>
            <i className="swatch" aria-hidden="true" /><span className="device-menu-name">{project.name}</span>
            {project.archived && <span className="chip">{t.projectArchived}</span>}
            {checked && <Check className="device-menu-check" size={15} aria-hidden="true" />}
          </button>;
        })}
        {offerCreate && <button type="button" role="option" aria-selected={false} className="project-menu-create" onClick={() => choose(projectDisplayName(value))}>
          <Plus size={15} aria-hidden="true" /><span className="device-menu-name">{t.createProject(projectDisplayName(value))}</span>
        </button>}
        {!options.length && !offerCreate && filtering && <div className="device-combobox-empty">{t.projectNoMatch}</div>}
      </div>}
    </div>
    {shown && !match && <span id={`${inputId}-new`} className="field-note">{t.projectWillCreate}</span>}
  </div>;
}
