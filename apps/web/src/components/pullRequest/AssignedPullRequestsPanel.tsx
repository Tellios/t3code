import { useAtomValue } from "@effect/atom-react";
import {
  assignedPullRequestProjects,
  assignedPullRequestTargets,
  uniqueAssignedPullRequests,
} from "@t3tools/client-runtime/state/pull-requests";
import { sourceControlClients } from "@t3tools/client-runtime/source-control-clients";
import {
  AuthOrchestrationOperateScope,
  AuthSourceControlWriteScope,
  type PullRequestAction,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import * as Schema from "effect/Schema";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import { useState } from "react";
import { useLiveRefresh } from "~/hooks/useLiveRefresh";
import { useLocalStorage } from "~/hooks/useLocalStorage";
import { readLocalApi } from "~/localApi";
import { useRightPanelStore } from "~/rightPanelStore";
import { useProjects, useServerConfigs } from "~/state/entities";
import { pullRequestEnvironment, usePullRequestList } from "~/state/pullRequests";
import { useEnvironmentQuery } from "~/state/query";
import { useEnvironmentScope } from "~/state/session";
import { Button } from "../ui/button";
import { CollapsibleSectionHeader } from "../ui/collapsible-section-header";
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from "../ui/menu";
import {
  AlertDialog,
  AlertDialogPopup,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogClose,
} from "../ui/alert-dialog";
import { toastManager } from "../ui/toast";
import type { EnvironmentPullRequestEntry } from "./pullRequestList.logic";
import {
  PullRequestStateGlyph,
  pullRequestChecksStatePresentation,
} from "./pullRequestPresentation";
import { pullRequestPanelReference } from "./usePullRequestDetail";
import { usePullRequestActionRunner, usePullRequestHandoffs } from "./usePullRequestActions";

export function AssignedPullRequestsPanel({ threadRef }: { threadRef: ScopedThreadRef | null }) {
  const projects = useProjects();
  const configs = useServerConfigs();
  const targets = assignedPullRequestTargets(projects, configs);
  const list = usePullRequestList(targets);
  const entries = uniqueAssignedPullRequests(list.data?.entries ?? []);
  const [expanded, setExpanded] = useLocalStorage(
    "t3code:sidebar:assigned-prs-expanded",
    true,
    Schema.Boolean,
  );
  const [visibleCount, setVisibleCount] = useState(10);
  const navigate = useNavigate();
  useLiveRefresh(list.isPending ? null : () => list.refresh(), {
    enabled: expanded && targets.length > 0,
    key: `sidebar-assigned-prs:${JSON.stringify(targets)}`,
  });
  if (targets.length === 0) return null;
  const errors = [
    list.error,
    ...(list.data?.errors.map((error) => `${error.projectTitle}: ${error.message}`) ?? []),
  ].filter(Boolean);
  return (
    <section aria-label="Assigned pull requests" data-thread-selection-safe>
      <CollapsibleSectionHeader
        expanded={expanded}
        onClick={() => setExpanded(!expanded)}
        accessory={
          <span className="font-normal tabular-nums">
            {entries.length}
            {list.data?.truncated ? "+" : ""}
          </span>
        }
      >
        Pull Requests
      </CollapsibleSectionHeader>
      {expanded ? (
        <div>
          {list.isPending && list.data === null ? (
            <p className="px-2 py-2 text-xs text-sidebar-muted-foreground">
              Loading pull requests…
            </p>
          ) : null}
          {errors.length > 0 ? (
            <div className="px-2 py-2 text-xs text-destructive">
              <p>{errors.join(" ")}</p>
              <Button size="xs" variant="ghost" onClick={() => list.refresh()}>
                Retry
              </Button>
            </div>
          ) : null}
          {!list.isPending && errors.length === 0 && entries.length === 0 ? (
            <p className="px-2 py-2 text-xs text-sidebar-muted-foreground">
              No open PRs assigned to you.
            </p>
          ) : null}
          {entries.slice(0, visibleCount).map((entry) => (
            <AssignedPullRequestRow
              key={`${entry.host}:${entry.repository}:${entry.number}`}
              entry={entry}
              threadRef={threadRef}
              refresh={() => list.refresh()}
            />
          ))}
          <Button
            size="xs"
            variant="ghost-muted"
            disabled={list.isPending}
            onClick={() => list.refresh()}
          >
            Refresh
          </Button>
          {entries.length > visibleCount ? (
            <Button size="xs" variant="ghost" onClick={() => setVisibleCount(visibleCount + 10)}>
              Show more
            </Button>
          ) : null}
          {list.data?.truncated ? (
            <Button
              size="xs"
              variant="ghost"
              onClick={() =>
                void navigate({
                  to: "/pull-requests",
                  search: { involvement: "assigned", state: "open" },
                })
              }
            >
              View all assigned PRs
            </Button>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

function AssignedPullRequestRow({
  entry,
  threadRef,
  refresh,
}: {
  entry: EnvironmentPullRequestEntry;
  threadRef: ScopedThreadRef | null;
  refresh: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [confirmClose, setConfirmClose] = useState(false);
  const reference = pullRequestPanelReference(entry);
  const query = useEnvironmentQuery(
    open || confirmClose
      ? pullRequestEnvironment.detail({ environmentId: entry.environmentId, input: reference })
      : null,
  );
  const detail = query.data;
  const checkQuery = useEnvironmentQuery(
    open && entry.checksState === "failing"
      ? pullRequestEnvironment.checks({ environmentId: entry.environmentId, input: reference })
      : null,
  );

  const projects = assignedPullRequestProjects(entry, useProjects(), useServerConfigs());
  const terminology = sourceControlClients.get(entry.provider).changeRequest;
  const writable = useAtomValue(
    pullRequestEnvironment.runAction.permissionAtom(entry.environmentId),
  );
  const { actionPending, perform } = usePullRequestActionRunner({
    environmentId: entry.environmentId,
    reference,
    terminology,
    onSuccess: refresh,
  });
  const can = (action: PullRequestAction) =>
    writable &&
    !actionPending &&
    detail?.state === "open" &&
    detail.capabilities.actions.includes(action) &&
    detail.viewerPermissions.actions.includes(action);
  const navigate = useNavigate();
  const openInternally = () => {
    if (threadRef) {
      useRightPanelStore.getState().openPullRequest(threadRef, {
        projectId: entry.projectId,
        host: entry.host,
        repository: entry.repository,
        number: entry.number,
        url: entry.url,
        ...(threadRef.environmentId === entry.environmentId
          ? {}
          : { environmentId: entry.environmentId }),
      });
    } else {
      void navigate({
        to: "/pull-requests",
        search: {
          involvement: "assigned",
          state: "open",
          selectedProjectId: entry.projectId,
          selectedEnvironmentId: entry.environmentId,
          selectedHost: entry.host,
          repository: entry.repository,
          number: entry.number,
        },
      });
    }
  };
  const openExternal = async (url: string) => {
    try {
      await readLocalApi()?.shell.openExternal(url);
    } catch {
      toastManager.add({ type: "error", title: "Could not open link" });
    }
  };
  const checks = entry.checksState ? pullRequestChecksStatePresentation(entry.checksState) : null;
  const failedChecks = (checkQuery.data?.checks ?? detail?.checks ?? []).filter(
    (check) => check.status === "failure" || check.status === "cancelled",
  );
  return (
    <>
      <Menu open={open} onOpenChange={setOpen}>
        <MenuTrigger
          render={
            <button
              type="button"
              className="flex w-full cursor-pointer items-start gap-2 rounded-md px-2 py-2 text-left hover:bg-sidebar-row-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
            />
          }
        >
          <PullRequestStateGlyph state={entry.state} isDraft={entry.isDraft} />
          <span className="min-w-0 flex-1">
            <span className="block truncate text-sm">{entry.title}</span>
            <span className="block truncate text-xs text-sidebar-muted-foreground">
              {entry.repository} #{entry.number}
            </span>
            <span className="flex flex-wrap items-center gap-x-2 text-xs text-sidebar-muted-foreground">
              <span>{entry.isDraft ? "Draft" : "Open"}</span>
              <span className={checks?.toneClassName}>
                {checks ? `CI ${entry.checksState}` : "CI unknown"}
              </span>
              <span>
                {entry.reviewDecision === "approved"
                  ? "Approved"
                  : entry.reviewDecision === "changes-requested"
                    ? "Changes requested"
                    : entry.reviewDecision === "review-required"
                      ? "Not approved"
                      : "Review unknown"}
              </span>
            </span>
          </span>
        </MenuTrigger>
        <MenuPopup align="start">
          {entry.isDraft ? (
            <MenuItem disabled={!can("ready")} onClick={() => void perform("ready")}>
              Mark ready for review
            </MenuItem>
          ) : null}
          {entry.checksState === "failing" ? (
            failedChecks.length > 0 ? (
              failedChecks.map((check) => (
                <MenuItem
                  key={`${check.name}:${check.url}`}
                  disabled={check.url === null}
                  onClick={() => {
                    if (check.url) void openExternal(check.url);
                  }}
                >
                  {failedChecks.length === 1 ? "Go to CI logs" : `CI logs: ${check.name}`}
                </MenuItem>
              ))
            ) : (
              <MenuItem disabled>
                Go to CI logs{checkQuery.isPending ? " (loading…)" : " (unavailable)"}
              </MenuItem>
            )
          ) : null}
          <MenuItem onClick={openInternally}>Open</MenuItem>
          <MenuItem onClick={() => void openExternal(entry.url)}>Open in Browser</MenuItem>
          {projects.length === 1 && projects[0] ? (
            <AssignedPullRequestCheckoutItem
              project={projects[0]}
              url={entry.url}
              label="Create thread"
            />
          ) : projects.length > 1 ? (
            <Menu>
              <MenuTrigger render={<MenuItem />}>Create thread</MenuTrigger>
              <MenuPopup>
                {projects.map((project) => (
                  <AssignedPullRequestCheckoutItem
                    key={`${project.environmentId}:${project.id}`}
                    project={project}
                    url={entry.url}
                    label={`${project.title} · ${project.workspaceRoot}`}
                  />
                ))}
              </MenuPopup>
            </Menu>
          ) : (
            <MenuItem disabled>Create thread</MenuItem>
          )}
          <MenuSeparator />
          <MenuItem disabled={!can("close")} onClick={() => setConfirmClose(true)}>
            Close PR
          </MenuItem>
        </MenuPopup>
      </Menu>
      <AlertDialog open={confirmClose} onOpenChange={setConfirmClose}>
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>Close pull request?</AlertDialogTitle>
            <AlertDialogDescription>
              #{entry.number} · {entry.title}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" />}>Cancel</AlertDialogClose>
            <Button
              variant="destructive"
              disabled={!can("close")}
              onClick={() => {
                setConfirmClose(false);
                void perform("close");
              }}
            >
              Close PR
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </>
  );
}

function AssignedPullRequestCheckoutItem({
  project,
  url,
  label,
}: {
  project: EnvironmentProject;
  url: string;
  label: string;
}) {
  const canCheckout = useEnvironmentScope(project.environmentId, AuthSourceControlWriteScope);
  const canOperate = useEnvironmentScope(project.environmentId, AuthOrchestrationOperateScope);
  const { handoff, startHandoff } = usePullRequestHandoffs({
    environmentId: project.environmentId,
    detail: { projectId: project.id, workspaceRoot: project.workspaceRoot, url },
  });
  return (
    <MenuItem
      disabled={!canCheckout || !canOperate || handoff !== null}
      onClick={() => void startHandoff("checkout", null, "worktree")}
    >
      {label}
    </MenuItem>
  );
}
