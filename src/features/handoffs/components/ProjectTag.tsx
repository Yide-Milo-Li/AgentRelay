import type { ProjectRef } from "@/shared/formatting/project-identity";

/** A project's name behind a square swatch; square so it is never read as a device's round station dot. */
export function ProjectTag({ project }: { project: ProjectRef }) {
  return <span className="project-tag" data-line={project.line} title={project.name}><i aria-hidden="true" /><span>{project.name}</span></span>;
}
