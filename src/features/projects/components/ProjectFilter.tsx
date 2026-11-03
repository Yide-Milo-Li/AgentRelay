"use client";
import { ChevronDown } from "lucide-react";
import { useLang } from "@/components/providers/LanguageProvider";
import type { Project } from "@/shared/contracts/projects";

/** Filter values: `all`, `none` for handoffs without a project, or `p:<id>`. */
export type ProjectFilterValue = string;

type Props = {
  projects: readonly Project[];
  /** Handoffs in the current view per project id; `none` counts those without a project. */
  counts: ReadonlyMap<string, number>;
  value: ProjectFilterValue;
  onChange: (value: ProjectFilterValue) => void;
  /** The menu is about to open (focus or press), so its counts can be read then instead of on every poll. */
  onOpen?: () => void;
};

/** Archived projects and "No project" are offered only while the current view still has handoffs for them. */
export default function ProjectFilter({ projects, counts, value, onChange, onOpen }: Props) {
  const { t } = useLang();
  const shown = projects.filter(project => !project.archived || counts.get(project.id) || value === `p:${project.id}`);
  const none = counts.get("none") ?? 0;
  return <label className="select-quiet"><select aria-label={t.filterProject} value={value} onChange={event => onChange(event.target.value)} onFocus={onOpen} onPointerDown={onOpen}>
    <option value="all">{t.allProjects}</option>
    {shown.map(project => <option key={project.id} value={`p:${project.id}`}>{t.projectOption(project.name, counts.get(project.id) ?? 0)}</option>)}
    {(none > 0 || value === "none") && <option value="none">{t.projectOption(t.noProject, none)}</option>}
  </select><ChevronDown size={14} aria-hidden="true" /></label>;
}
