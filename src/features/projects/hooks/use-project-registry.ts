"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "@/shared/http/client";
import type { DeletedProject, MergedProject, Project, ProjectLine } from "@/shared/contracts/projects";
import { indexProjects, type ProjectIndex } from "@/shared/formatting/project-identity";

export type ProjectRegistry = {
  projects: readonly Project[];
  index: ProjectIndex;
  /** True once the first fetch has finished, whether or not it succeeded. */
  loaded: boolean;
  error: unknown;
  refresh: () => Promise<void>;
  update: (project: Project, patch: { name?: string; line?: ProjectLine; archived?: boolean }) => Promise<Project>;
  merge: (project: Project, into: Project) => Promise<MergedProject>;
  remove: (project: Project) => Promise<DeletedProject>;
};

/**
 * The workspace's projects, most recently used first. Mutations update the list in place and are never undone by an
 * older refresh. Projects appear as handoffs are sent (by agents too), so callers refresh after sending and whenever
 * a handoff names a project id this list does not know yet.
 */
export function useProjectRegistry(enabled = true): ProjectRegistry {
  const [projects, setProjects] = useState<readonly Project[]>([]), [loaded, setLoaded] = useState(false), [error, setError] = useState<unknown>(null);
  const flight = useRef(false), epoch = useRef(0);

  const refresh = useCallback((): Promise<void> => {
    if (flight.current) return Promise.resolve();
    flight.current = true;
    const started = epoch.current;
    return api<{ projects: Project[] }>("/api/projects")
      // A mutation that finished while this request was in flight is newer than its answer.
      .then(result => { if (started === epoch.current) { setProjects(result.projects); setError(null); } }, e => setError(e))
      .finally(() => { flight.current = false; setLoaded(true); });
  }, []);
  useEffect(() => {
    if (!enabled) return;
    refresh();
    const visible = () => { if (document.visibilityState === "visible") refresh(); };
    document.addEventListener("visibilitychange", visible);
    return () => document.removeEventListener("visibilitychange", visible);
  }, [enabled, refresh]);

  const update = useCallback<ProjectRegistry["update"]>(async (project, patch) => {
    const updated = await api<Project>(`/api/projects/${encodeURIComponent(project.id)}`, "PATCH", { version: project.version, ...patch });
    epoch.current++;
    setProjects(old => old.map(item => item.id === updated.id ? updated : item));
    return updated;
  }, []);
  const merge = useCallback<ProjectRegistry["merge"]>(async (project, into) => {
    const result = await api<MergedProject>(`/api/projects/${encodeURIComponent(project.id)}/merge`, "POST", { version: project.version, into: into.id });
    epoch.current++;
    setProjects(old => old.filter(item => item.id !== project.id).map(item => item.id === result.into.id ? result.into : item));
    return result;
  }, []);
  const remove = useCallback<ProjectRegistry["remove"]>(async project => {
    const result = await api<DeletedProject>(`/api/projects/${encodeURIComponent(project.id)}`, "DELETE", { version: project.version });
    epoch.current++;
    setProjects(old => old.filter(item => item.id !== project.id));
    return result;
  }, []);

  const index = useMemo(() => indexProjects(projects), [projects]);
  return { projects, index, loaded, error, refresh, update, merge, remove };
}
