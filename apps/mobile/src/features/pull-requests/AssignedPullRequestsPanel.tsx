import { useAtomValue } from "@effect/atom-react";
import {
  assignedPullRequestProjects,
  assignedPullRequestTargets,
  uniqueAssignedPullRequests,
} from "@t3tools/client-runtime/state/pull-requests";
import { AuthOrchestrationOperateScope, AuthSourceControlWriteScope } from "@t3tools/contracts";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import { useState } from "react";
import { useFocusEffect } from "@react-navigation/native";
import { Linking, Pressable, View } from "react-native";
import { AppText as Text } from "../../components/ui/AppText";
import { SymbolView } from "../../components/ui/AppSymbol";
import { Menu } from "../../components/ui/Menu";
import * as Dialog from "../../components/ui/Dialog";
import { useProjects, useServerConfigs } from "../../state/entities";
import { useEnvironmentsWithScope } from "../../state/session";
import { useAtomQueryRunner } from "../../state/use-atom-query-runner";
import { sourceControlClients } from "@t3tools/client-runtime/source-control-clients";
import { composerPullRequests } from "../../state/pull-requests";
import { useAtomCommand } from "../../state/use-atom-command";
import { gitEnvironment } from "../../state/git";
import { settlePromise, squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import {
  createNewTaskDraft,
  updateComposerDraftSettings,
  waitForComposerDraftsLoaded,
} from "../../state/use-composer-drafts";
import { useOpenWorkspaceDetail } from "../layout/useOpenWorkspaceDetail";
import { usePullRequestList } from "./usePullRequestList";
import { usePullRequestListActions } from "./usePullRequestListActions";
import type { EnvironmentPullRequestListEntry } from "./pullRequestList";
import type { MenuProps } from "../../components/ui/Menu.types";

export function AssignedPullRequestsPanel() {
  const targets = assignedPullRequestTargets(useProjects(), useServerConfigs());
  const list = usePullRequestList(targets);
  const [expanded, setExpanded] = useState(true);
  const [visibleCount, setVisibleCount] = useState(10);
  const entries = uniqueAssignedPullRequests(list.entries);
  useFocusEffect(() => {
    if (!expanded || !targets.length) return;
    const timer = setInterval(list.onRefresh, 5 * 60_000);
    return () => clearInterval(timer);
  });

  const actions = usePullRequestListActions(
    targets.map((target) => target.environmentId),
    list.updateEntry,
  );
  if (targets.length === 0) return null;
  return (
    <View className="px-2 pb-2">
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded }}
        onPress={() => setExpanded(!expanded)}
        className="flex-row items-center gap-2 px-2 py-3"
      >
        <Text className="flex-1 text-xs text-muted-foreground">
          Pull Requests · {entries.length}
          {list.hasMore ? "+" : ""}
        </Text>
        <SymbolView
          name={expanded ? "chevron.down" : "chevron.right"}
          size={12}
          tintColorClassName="accent-muted-foreground"
        />
      </Pressable>
      {expanded ? (
        <View>
          {list.isPending ? (
            <Text className="px-2 py-2 text-xs text-muted-foreground">Loading pull requests…</Text>
          ) : null}
          {list.data.errors.length > 0 ? (
            <Pressable onPress={list.onRefresh} accessibilityRole="button">
              <Text className="px-2 py-2 text-xs text-destructive">
                {list.data.errors.map((error) => error.message).join(" ")} Tap to retry.
              </Text>
            </Pressable>
          ) : null}
          {!list.isPending && !entries.length && !list.data.errors.length ? (
            <Text className="px-2 py-2 text-xs text-muted-foreground">
              No open PRs assigned to you.
            </Text>
          ) : null}
          {entries.slice(0, visibleCount).map((entry) => (
            <AssignedPullRequestRow
              key={`${entry.host}:${entry.repository}:${entry.number}`}
              entry={entry}
              select={actions.select}
              busy={actions.busyKey !== null}
            />
          ))}
          <Pressable accessibilityRole="button" onPress={list.onRefresh} disabled={list.refreshing}>
            <Text className="px-2 py-2 text-xs text-muted-foreground">Refresh</Text>
          </Pressable>
          {entries.length > visibleCount || list.hasMore ? (
            <Pressable
              accessibilityRole="button"
              onPress={() => {
                setVisibleCount(visibleCount + 10);
                if (entries.length <= visibleCount) list.loadMore();
              }}
            >
              <Text className="px-2 py-2 text-xs text-primary">Show more</Text>
            </Pressable>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}

function AssignedPullRequestRow({
  entry,
  select,
  busy,
}: {
  entry: EnvironmentPullRequestListEntry;
  select: (entry: EnvironmentPullRequestListEntry, action: string) => void;
  busy: boolean;
}) {
  const [preparing, setPreparing] = useState(false);
  const projects = assignedPullRequestProjects(entry, useProjects(), useServerConfigs());
  const target = {
    environmentId: entry.environmentId,
    input: {
      projectId: entry.projectId,
      host: entry.host,
      repository: entry.repository,
      number: entry.number,
    },
  };
  const readChecks = useAtomQueryRunner(composerPullRequests.checks, {
    reportFailure: false,
    refresh: true,
  });
  const openCiLogs = async () => {
    const result = await readChecks(target);
    if (result._tag === "Failure") {
      const error = squashAtomCommandFailure(result);
      Dialog.alert("Couldn't load CI logs", error instanceof Error ? error.message : "Try again.");
      return;
    }
    const checks = (result.value?.checks ?? []).filter(
      (check) => (check.status === "failure" || check.status === "cancelled") && check.url !== null,
    );
    if (checks.length === 1 && checks[0]?.url) {
      await Linking.openURL(checks[0].url);
      return;
    }
    Dialog.alert(
      "CI logs",
      checks.length ? "Choose a failed check." : "No failed check links are available.",
      [
        ...checks.map((check) => ({
          text: check.name,
          onPress: () => {
            if (check.url) void Linking.openURL(check.url);
          },
        })),
        { text: "Cancel", style: "cancel" },
      ],
    );
  };
  const writable = useAtomValue(composerPullRequests.runAction.permissionAtom(entry.environmentId));
  const checkoutEnvironments = useEnvironmentsWithScope(projects, AuthSourceControlWriteScope);
  const operateEnvironments = useEnvironmentsWithScope(projects, AuthOrchestrationOperateScope);
  const prepare = useAtomCommand(gitEnvironment.preparePullRequestThread, { reportFailure: false });
  const openDetail = useOpenWorkspaceDetail();
  const createThread = async (project: EnvironmentProject) => {
    if (
      preparing ||
      !checkoutEnvironments.has(project.environmentId) ||
      !operateEnvironments.has(project.environmentId)
    )
      return;
    setPreparing(true);
    const outcome = await settlePromise(async () => {
      const result = await prepare({
        environmentId: project.environmentId,
        input: { cwd: project.workspaceRoot, reference: entry.url, mode: "worktree" },
      });
      if (result._tag === "Failure") throw squashAtomCommandFailure(result);
      if (!result.value.isOnPullRequestHead)
        throw new Error(
          "The checkout is not on the pull request head. Open the PR to inspect its checkout.",
        );
      await waitForComposerDraftsLoaded();
      const draftId = createNewTaskDraft({
        environmentId: project.environmentId,
        projectId: project.id,
      });
      updateComposerDraftSettings(draftId, {
        workspaceSelection: {
          mode: "worktree",
          branch: result.value.branch,
          worktreePath: result.value.worktreePath,
          startFromOrigin: false,
        },
      });
      openDetail({ name: "Thread", params: { draft: { draftId, title: entry.title } } });
    });
    setPreparing(false);
    if (outcome._tag === "Failure") {
      const error = squashAtomCommandFailure(outcome);
      Dialog.alert(
        "Couldn't create a thread",
        error instanceof Error ? error.message : "Try again.",
      );
    }
  };
  const hostActions = sourceControlClients.get(entry.provider).changeRequestActions;
  const can = (action: "ready" | "close") => writable && !busy && hostActions.has(action);
  const menu: MenuProps["actions"] = [
    ...(entry.isDraft
      ? [{ id: "ready", title: "Mark ready for review", attributes: { disabled: !can("ready") } }]
      : []),
    ...(entry.checksState === "failing" ? [{ id: "ci", title: "Go to CI logs" }] : []),
    { id: "open", title: "Open" },
    { id: "provider", title: "Open in Browser" },
    {
      id: "create",
      title: preparing ? "Preparing checkout…" : "Create thread",
      attributes: { disabled: !projects.length || preparing },
      ...(projects.length > 1
        ? {
            subactions: projects.map((project, index) => ({
              id: `create:${index}`,
              title: `${project.title} · ${project.workspaceRoot}`,
              attributes: {
                disabled:
                  !checkoutEnvironments.has(project.environmentId) ||
                  !operateEnvironments.has(project.environmentId),
              },
            })),
          }
        : {
            attributes: {
              disabled:
                !projects[0] ||
                !checkoutEnvironments.has(projects[0].environmentId) ||
                !operateEnvironments.has(projects[0].environmentId) ||
                preparing,
            },
          }),
    },
    { id: "close", title: "Close PR", attributes: { destructive: true, disabled: !can("close") } },
  ];
  return (
    <Menu
      actions={menu}
      onPressAction={({ nativeEvent }) => {
        const action = nativeEvent.event;
        if (action === "create" || action.startsWith("create:")) {
          const project = projects[action === "create" ? 0 : Number(action.slice(7))];
          if (project) void createThread(project);
        } else if (action === "ci") void openCiLogs();
        else select(entry, action);
      }}
    >
      <View className="px-2 py-2">
        <Text numberOfLines={1} className="text-sm text-foreground">
          {entry.title}
        </Text>
        <Text numberOfLines={1} className="text-xs text-muted-foreground">
          {entry.repository} #{entry.number}
        </Text>
        <Text className="text-xs text-muted-foreground">
          {entry.isDraft ? "Draft" : "Open"} · CI {entry.checksState ?? "unknown"} ·{" "}
          {entry.reviewDecision === "approved"
            ? "Approved"
            : entry.reviewDecision === "changes-requested"
              ? "Changes requested"
              : entry.reviewDecision === "review-required"
                ? "Not approved"
                : "Review unknown"}
        </Text>
      </View>
    </Menu>
  );
}
