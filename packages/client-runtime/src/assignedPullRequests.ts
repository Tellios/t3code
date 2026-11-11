import type {
  EnvironmentId,
  ProjectId,
  PullRequestListEntry,
  PullRequestListInput,
  ServerConfig,
} from "@t3tools/contracts";

export function assignedPullRequestTargets(
  projects: ReadonlyArray<{ readonly id: ProjectId; readonly environmentId: EnvironmentId }>,
  configs: ReadonlyMap<EnvironmentId, Pick<ServerConfig, "settings">>,
) {
  const byEnvironment = new Map<EnvironmentId, ProjectId[]>();
  for (const project of projects) {
    if (
      configs.get(project.environmentId)?.settings.projectSettingsOverrides[project.id]
        ?.showAssignedPullRequests !== true
    )
      continue;
    const ids = byEnvironment.get(project.environmentId) ?? [];
    if (!ids.includes(project.id)) ids.push(project.id);
    byEnvironment.set(project.environmentId, ids);
  }
  return [...byEnvironment]
    .flatMap(([environmentId, ids]) => {
      const targets: { environmentId: EnvironmentId; input: PullRequestListInput }[] = [];
      ids.sort();
      for (let index = 0; index < ids.length; index += 100) {
        targets.push({
          environmentId,
          input: {
            state: "open",
            involvement: "assigned",
            projectIds: ids.slice(index, index + 100),
            limit: 100,
          },
        });
      }
      return targets;
    })
    .sort((a, b) => a.environmentId.localeCompare(b.environmentId));
}

export function uniqueAssignedPullRequests<Entry extends PullRequestListEntry>(
  entries: ReadonlyArray<Entry>,
) {
  const unique = new Map<string, Entry>();
  for (const entry of entries) {
    if (entry.state !== "open") continue;
    const key = `${entry.provider}:${entry.host.toLowerCase()}:${entry.repository.toLowerCase()}:${entry.number}`;
    if (!unique.has(key)) unique.set(key, entry);
  }
  return [...unique.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export function assignedPullRequestProjects<
  Project extends {
    readonly id: ProjectId;
    readonly environmentId: EnvironmentId;
    readonly repositoryIdentity?: { readonly canonicalKey: string } | null | undefined;
  },
>(
  entry: { readonly projectId: ProjectId; readonly environmentId: EnvironmentId },
  projects: ReadonlyArray<Project>,
  configs: ReadonlyMap<EnvironmentId, Pick<ServerConfig, "settings">>,
) {
  const own = projects.find(
    (project) => project.id === entry.projectId && project.environmentId === entry.environmentId,
  );
  const key = own?.repositoryIdentity?.canonicalKey.toLowerCase();
  return projects.filter(
    (project) =>
      configs.get(project.environmentId)?.settings.projectSettingsOverrides[project.id]
        ?.showAssignedPullRequests === true &&
      (project === own ||
        (key !== undefined && project.repositoryIdentity?.canonicalKey.toLowerCase() === key)),
  );
}
