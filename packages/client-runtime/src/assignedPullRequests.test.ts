import { describe, expect, it } from "vite-plus/test";
import {
  DEFAULT_SERVER_SETTINGS,
  EnvironmentId,
  ProjectId,
  type PullRequestListEntry,
} from "@t3tools/contracts";
import {
  assignedPullRequestProjects,
  assignedPullRequestTargets,
  uniqueAssignedPullRequests,
} from "./assignedPullRequests.ts";

const environmentId = EnvironmentId.make("one");
const enabled = ProjectId.make("enabled");
const disabled = ProjectId.make("disabled");

describe("assigned pull request scope", () => {
  it("only queries explicitly enabled projects on their owning environment", () => {
    const other = EnvironmentId.make("other");
    const targets = assignedPullRequestTargets(
      [
        { id: enabled, environmentId },
        { id: disabled, environmentId },
        { id: enabled, environmentId: other },
      ],
      new Map([
        [
          environmentId,
          {
            settings: {
              ...DEFAULT_SERVER_SETTINGS,
              projectSettingsOverrides: { [enabled]: { showAssignedPullRequests: true } },
            },
          },
        ],
      ]),
    );
    const projects = [enabled, disabled].map((id) => ({
      id,
      environmentId,
      repositoryIdentity: { canonicalKey: "github.com/acme/web" },
    }));
    expect(
      assignedPullRequestProjects(
        { projectId: enabled, environmentId },
        projects,
        new Map([
          [
            environmentId,
            {
              settings: {
                ...DEFAULT_SERVER_SETTINGS,
                projectSettingsOverrides: { [enabled]: { showAssignedPullRequests: true } },
              },
            },
          ],
        ]),
      ),
    ).toEqual([projects[0]]);
    expect(targets).toEqual([
      {
        environmentId,
        input: {
          state: "open",
          involvement: "assigned",
          projectIds: [enabled],
          limit: 100,
        },
      },
    ]);
    expect(
      assignedPullRequestTargets(
        [{ id: disabled, environmentId }],
        new Map([[environmentId, { settings: DEFAULT_SERVER_SETTINGS }]]),
      ),
    ).toEqual([]);
  });

  it("deduplicates repositories across environments and excludes terminal states", () => {
    const row = {
      provider: "github",
      host: "github.com",
      repository: "acme/web",
      number: 1,
      state: "open",
      updatedAt: "2026-11-10T00:00:00Z",
    } as PullRequestListEntry;
    expect(
      uniqueAssignedPullRequests([
        row,
        { ...row, projectId: disabled },
        { ...row, number: 2, state: "merged" },
        { ...row, number: 3, state: "closed" },
      ]),
    ).toEqual([row]);
  });
});
