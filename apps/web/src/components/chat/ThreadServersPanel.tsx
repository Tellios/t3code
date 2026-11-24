import { useAtomValue } from "@effect/atom-react";
import { thrownErrorMessage } from "@t3tools/client-runtime/errors";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  AuthPreviewOperateScope,
  AuthTerminalOperateScope,
  nxtvironInstanceActions,
  type DiscoveredLocalServer,
  type EnvironmentId,
  type NxtvironInstance,
  type NxtvironInstanceAction,
  type ThreadId,
} from "@t3tools/contracts";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { isLoopbackHost } from "@t3tools/shared/preview";
import { msg, T, useGT, useMessages, Var } from "gt-react";
import { m } from "~/i18n/messages";
import {
  CableIcon,
  ChevronDownIcon,
  ChevronUpIcon,
  GlobeIcon,
  PlayIcon,
  RotateCwIcon,
  SquareIcon,
  Trash2Icon,
} from "lucide-react";
import { type MouseEvent, type ReactNode, useState } from "react";

import {
  resolveExternalServerUrl,
  tunnelsEnvironmentLoopback,
} from "../../browser/browserTargetResolver";
import { readLocalApi } from "../../localApi";
import { cn, isMacPlatform } from "../../lib/utils";
import { useThreadDiscoveredPorts, useThreadNxtvironInstances } from "../../portDiscoveryState";
import { useEnvironment } from "../../state/environments";
import {
  canForwardPorts,
  findPortForward,
  forwardedUrl,
  forwardPort,
  stopPortForward,
  useForwardLocality,
  usePortForwards,
} from "../../state/portForwards";
import { previewEnvironment } from "../../state/preview";
import { useEnvironmentScope } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";
import { openDiscoveredPort } from "../preview/openDiscoveredPort";
import { Spinner } from "../ui/spinner";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { ThreadDetailsControl } from "./ThreadDetailsControl";
import { ThreadDetailsSection } from "./ThreadDetailsSection";
import { THREAD_DETAILS_PANEL_ICON_CLASS } from "./threadDetailsPanelStyles";

const SERVER_PAGE_COUNT = 4;

interface ServerRowAction {
  readonly id: string;
  readonly label: string;
  readonly tooltip: string;
  readonly destructive: boolean;
  readonly icon: NxtvironInstanceAction;
  readonly run: () => Promise<void>;
}

interface ServerRow {
  readonly key: string;
  readonly title: string;
  readonly subtitle: string;
  /** `null` rows can't be opened, such as a stopped nxtviron instance. */
  readonly url: string | null;
  readonly port: number | null;
  readonly actions: ReadonlyArray<ServerRowAction>;
}

const serverKey = (server: DiscoveredLocalServer) => `${server.pid}:${server.port}`;

const nxtvironPort = (instance: NxtvironInstance) =>
  instance.ports.http ?? Object.values(instance.ports)[0] ?? null;

const NXTVIRON_STATE_LABEL: Record<NxtvironInstance["state"], string> = {
  running: msg("Running", { $context: "dev environment instance state" }),
  stopped: msg("Paused", { $context: "dev environment instance state" }),
  missing: msg("Missing", { $context: "dev environment instance state" }),
  unavailable: msg("Unavailable", { $context: "dev environment instance state" }),
};

const NXTVIRON_ACTION_COPY: Record<
  NxtvironInstanceAction,
  { readonly label: string; readonly tooltip: string; readonly failure: string }
> = {
  stop: {
    label: msg("Stop {ref}"),
    tooltip: msg("Stop instance"),
    failure: msg("Could not stop instance"),
  },
  resume: {
    label: msg("Resume {ref}"),
    tooltip: msg("Resume instance"),
    failure: msg("Could not resume instance"),
  },
  restart: {
    label: msg("Restart {ref}"),
    tooltip: msg("Restart instance"),
    failure: msg("Could not restart instance"),
  },
  delete: {
    label: msg("Delete {ref}"),
    tooltip: msg("Delete instance"),
    failure: msg("Could not delete instance"),
  },
};

const ACTION_ICONS = {
  stop: SquareIcon,
  resume: PlayIcon,
  restart: RotateCwIcon,
  delete: Trash2Icon,
} as const;

interface ThreadServersPanelProps {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}

/** Local servers the thread's terminals, agent, or nxtviron started. Hidden while none exist. */
export function ThreadServersPanel(props: ThreadServersPanelProps) {
  return <ThreadServersList key={`${props.environmentId}:${props.threadId}`} {...props} />;
}

function ThreadServersList(props: ThreadServersPanelProps) {
  const gt = useGT();
  const resolveMessage = useMessages();
  const servers = useThreadDiscoveredPorts(props);
  const instances = useThreadNxtvironInstances(props);
  const canOpen = useEnvironmentScope(props.environmentId, AuthPreviewOperateScope);
  const canStop = useAtomValue(
    previewEnvironment.stopLocalServer.permissionAtom(props.environmentId),
  );
  const canActOnInstances = useAtomValue(
    previewEnvironment.nxtvironInstanceAction.permissionAtom(props.environmentId),
  );
  const environment = useEnvironment(props.environmentId);
  const supportsStop = environment?.serverConfig?.environment.capabilities.localServerStop === true;
  const forwards = usePortForwards();
  const forwardable =
    useEnvironmentScope(props.environmentId, AuthTerminalOperateScope) &&
    environment?.connection.phase === "connected" &&
    canForwardPorts(environment);
  const locality = useForwardLocality(forwardable ? props.environmentId : null);
  const canForward = locality === "remote";
  const openPreview = useAtomCommand(previewEnvironment.open, { reportFailure: false });
  const stopServer = useAtomCommand(previewEnvironment.stopLocalServer, {
    label: "thread server stop",
  });
  const actOnInstance = useAtomCommand(previewEnvironment.nxtvironInstanceAction, {
    label: "thread nxtviron instance action",
  });
  const [pendingKey, setPendingKey] = useState<string | null>(null);
  const [forwardingPort, setForwardingPort] = useState<number | null>(null);
  const [visibleCount, setVisibleCount] = useState(SERVER_PAGE_COUNT);

  const reportFailure = (title: string, error: unknown) => {
    toastManager.add(
      stackedThreadToast({
        type: "error",
        title,
        description: thrownErrorMessage(error, m) ?? String(error),
      }),
    );
  };

  const runPending = async (key: string, task: () => Promise<void>) => {
    if (pendingKey !== null) return;
    setPendingKey(key);
    await task();
    setPendingKey(null);
  };

  const instancePorts = new Set(
    instances
      .filter((instance) => instance.state === "running")
      .flatMap((instance) => Object.values(instance.ports)),
  );
  const rows: ReadonlyArray<ServerRow> = [
    ...servers
      .filter((server) => !instancePorts.has(server.port))
      .map((server): ServerRow => {
        const key = serverKey(server);
        const { pid } = server;
        return {
          key,
          title: `localhost:${server.port}`,
          subtitle: [
            server.terminal === null
              ? gt("Agent", { $context: "who started a dev server" })
              : gt("Terminal", { $context: "who started a dev server" }),
            server.processName,
          ]
            .filter(Boolean)
            .join(" · "),
          url: server.url,
          port: server.port,
          actions:
            canStop && supportsStop && pid !== null
              ? [
                  {
                    id: `${key}:stop`,
                    label: gt("Stop localhost:{port}", { port: server.port }),
                    tooltip: gt("Stop server"),
                    destructive: true,
                    icon: "stop",
                    run: async () => {
                      const result = await stopServer({
                        environmentId: props.environmentId,
                        input: { pid, port: server.port },
                      });
                      if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
                        reportFailure(
                          gt("Could not stop server"),
                          squashAtomCommandFailure(result),
                        );
                      }
                    },
                  },
                ]
              : [],
        };
      }),
    ...instances.map((instance): ServerRow => {
      const key = `nxtviron:${instance.ref}`;
      const port = nxtvironPort(instance);
      const url =
        instance.state !== "running"
          ? null
          : (instance.url ?? (port === null ? null : `http://localhost:${port}`));
      const sameProcess = instances.filter((other) => other.process === instance.process);
      const index = sameProcess.length > 1 ? sameProcess.indexOf(instance) + 1 : null;
      return {
        key,
        title: ["nxtviron", instance.process, index].filter((part) => part !== null).join(" - "),
        subtitle: resolveMessage(NXTVIRON_STATE_LABEL[instance.state]),
        url,
        port: url !== null && isLoopbackHost(new URL(url).hostname) ? port : null,
        actions: canActOnInstances
          ? nxtvironInstanceActions(instance.state).map((action) => {
              const copy = NXTVIRON_ACTION_COPY[action];
              return {
                id: `${key}:${action}`,
                label: resolveMessage(copy.label, { ref: instance.ref }),
                tooltip: resolveMessage(copy.tooltip),
                destructive: action === "stop" || action === "delete",
                icon: action,
                run: async () => {
                  const result = await actOnInstance({
                    environmentId: props.environmentId,
                    input: { ref: instance.ref, action },
                  });
                  if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
                    reportFailure(resolveMessage(copy.failure), squashAtomCommandFailure(result));
                  }
                },
              };
            })
          : [],
      };
    }),
  ];

  if (rows.length === 0) return null;
  const externalClickLabel = isMacPlatform(navigator.platform) ? "⌘-click" : "Ctrl-click";
  const threadRef = scopeThreadRef(props.environmentId, props.threadId);
  const hiddenCount = Math.max(0, rows.length - visibleCount);

  const open = async (url: string, port: number | null, event: MouseEvent<HTMLElement>) => {
    if (event.button > 1) return;
    // Like links: modified and middle clicks go to the system browser.
    if (event.metaKey || event.ctrlKey || event.button === 1) {
      event.preventDefault();
      // This machine's browser reaches another environment's loopback only through a forward.
      // Starting a forward runs the probe; only a confirmed local environment opens directly.
      const forwarding = port !== null && forwardable && locality !== "local";
      const externalUrl = forwarding
        ? await forwardPort(props.environmentId, port).then(
            (forward) => forwardedUrl(forward, url),
            (error: unknown) => {
              reportFailure(gt("Could not forward port {port}", { port }), error);
              return null;
            },
          )
        : resolveExternalServerUrl(props.environmentId, url);
      if (externalUrl === null) return;
      // Without a forward, a remote environment's localhost would open this machine's instead.
      if (
        !forwarding &&
        locality !== "local" &&
        tunnelsEnvironmentLoopback(environment?.entry.target) &&
        isLoopbackHost(new URL(externalUrl).hostname)
      ) {
        reportFailure(
          gt("Unable to open in browser"),
          new Error(
            gt(
              "localhost:{port} runs on another machine, and port forwarding isn't available for it right now.",
              { port: port ?? new URL(url).port },
            ),
          ),
        );
        return;
      }
      await readLocalApi()
        ?.shell.openExternal(externalUrl)
        .catch((error: unknown) => reportFailure(gt("Unable to open in browser"), error));
      return;
    }
    const result = await openDiscoveredPort({ threadRef, port: { url }, openPreview });
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      reportFailure(gt("Unable to open preview"), squashAtomCommandFailure(result));
    }
  };

  const toggleForward = async (port: number, forwarded: boolean) => {
    if (forwardingPort !== null) return;
    setForwardingPort(port);
    await (
      forwarded
        ? stopPortForward(props.environmentId, port)
        : forwardPort(props.environmentId, port)
    ).catch((error: unknown) =>
      reportFailure(gt("Could not forward port {port}", { port }), error),
    );
    setForwardingPort(null);
  };

  return (
    <ThreadDetailsSection
      headingId="thread-details-servers-heading"
      title={gt("Servers", { $context: "thread details section: running dev servers" })}
    >
      <ul className="m-0 list-none p-0">
        {rows.slice(0, visibleCount).map((row, index) => {
          const { url, port } = row;
          const forward =
            port === null ? undefined : findPortForward(forwards, props.environmentId, port);
          const showForward = canForward && port !== null;
          const actionCount = row.actions.length + Number(showForward);
          return (
            <li
              key={row.key}
              data-thread-details-server-overflow={index >= SERVER_PAGE_COUNT || undefined}
              className="group relative flex items-center rounded-lg"
            >
              <Tooltip>
                <TooltipTrigger
                  delay={200}
                  render={
                    <ThreadDetailsControl
                      size="sm"
                      variant="ghost"
                      part="row"
                      tone={url === null ? "muted" : "default"}
                      multiline
                      disabled={!canOpen || url === null}
                      onClick={url === null ? undefined : (event) => void open(url, port, event)}
                      onAuxClick={url === null ? undefined : (event) => void open(url, port, event)}
                    />
                  }
                >
                  <GlobeIcon aria-hidden className={THREAD_DETAILS_PANEL_ICON_CLASS} />
                  {/* The end padding keeps text clear of the action buttons. */}
                  <span
                    className={cn(
                      "flex min-w-0 flex-1 flex-col gap-0.5",
                      actionCount === 1 && "pe-6",
                      actionCount === 2 && "pe-12",
                      actionCount > 2 && "pe-18",
                    )}
                  >
                    <span className="truncate text-sm font-medium leading-4 text-foreground/85">
                      {row.title}
                    </span>
                    <span className="truncate text-2xs font-normal leading-4 text-muted-foreground">
                      {[
                        forward
                          ? gt("Forwarded to :{port}", {
                              $context: "a remote dev server reachable on this machine's port",
                              port: forward.localPort,
                            })
                          : null,
                        row.subtitle,
                      ]
                        .filter(Boolean)
                        .join(" · ")}
                    </span>
                  </span>
                </TooltipTrigger>
                {url === null ? null : (
                  <TooltipPopup side="left">
                    <T>
                      Open in the browser panel. <Var>{externalClickLabel}</Var> for your browser.
                    </T>
                  </TooltipPopup>
                )}
              </Tooltip>
              <ServerRowActions
                actions={row.actions}
                pendingKey={pendingKey}
                forwarded={forward !== undefined}
                forwardControl={
                  showForward ? (
                    <Tooltip>
                      <TooltipTrigger
                        render={
                          <ThreadDetailsControl
                            size="icon-xs"
                            variant="ghost"
                            part="icon"
                            aria-pressed={forward !== undefined}
                            aria-label={
                              forward
                                ? gt("Stop forwarding localhost:{port}", { port })
                                : gt("Forward localhost:{port} to this machine", {
                                    port,
                                  })
                            }
                            disabled={forwardingPort !== null}
                            onClick={() => void toggleForward(port, forward !== undefined)}
                          />
                        }
                      >
                        {forwardingPort === port ? (
                          <Spinner aria-hidden size="xs" />
                        ) : (
                          <CableIcon
                            aria-hidden
                            className={cn("size-3.5", forward && "text-primary")}
                          />
                        )}
                      </TooltipTrigger>
                      <TooltipPopup side="left">
                        {forward ? (
                          <T>
                            Forwarded to localhost:<Var>{forward.localPort}</Var> on this machine.
                            Click to stop.
                          </T>
                        ) : (
                          <T>Forward to this machine, for any app here</T>
                        )}
                      </TooltipPopup>
                    </Tooltip>
                  ) : null
                }
                onRun={(action) => void runPending(action.id, action.run)}
              />
            </li>
          );
        })}
      </ul>
      {rows.length > SERVER_PAGE_COUNT ? (
        <ThreadDetailsControl
          variant="ghost"
          size="sm"
          onClick={() =>
            setVisibleCount(hiddenCount > 0 ? visibleCount + SERVER_PAGE_COUNT : SERVER_PAGE_COUNT)
          }
          part="row"
          tone="muted"
          className="w-full active:scale-100"
        >
          {hiddenCount > 0 ? (
            <ChevronDownIcon aria-hidden className="size-4 shrink-0" />
          ) : (
            <ChevronUpIcon aria-hidden className="size-4 shrink-0" />
          )}
          {hiddenCount > 0 ? (
            <T>
              Show <Var>{Math.min(hiddenCount, SERVER_PAGE_COUNT)}</Var> more
            </T>
          ) : (
            <T>Show less</T>
          )}
        </ThreadDetailsControl>
      ) : null}
    </ThreadDetailsSection>
  );
}

function ServerRowActions(props: {
  readonly actions: ReadonlyArray<ServerRowAction>;
  readonly pendingKey: string | null;
  readonly forwarded: boolean;
  readonly forwardControl: ReactNode;
  readonly onRun: (action: ServerRowAction) => void;
}) {
  if (props.actions.length === 0 && props.forwardControl === null) return null;
  return (
    <div
      className={cn(
        "absolute right-1 top-1/2 flex -translate-y-1/2 items-center gap-0.5",
        !props.forwarded &&
          "pointer-events-none opacity-0 group-hover:pointer-events-auto group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:opacity-100 pointer-coarse:pointer-events-auto pointer-coarse:opacity-100 [@media(hover:none)]:pointer-events-auto [@media(hover:none)]:opacity-100",
      )}
    >
      {props.forwardControl}
      {props.actions.map((action) => {
        const Icon = ACTION_ICONS[action.icon];
        return (
          <Tooltip key={action.id}>
            <TooltipTrigger
              render={
                <ThreadDetailsControl
                  size="icon-xs"
                  variant="ghost"
                  part="icon"
                  tone={action.destructive ? "destructive" : "default"}
                  aria-label={action.label}
                  disabled={props.pendingKey !== null}
                  onClick={() => props.onRun(action)}
                />
              }
            >
              {props.pendingKey === action.id ? (
                <Spinner aria-hidden size="xs" />
              ) : (
                <Icon
                  aria-hidden
                  className={cn("size-3", action.icon === "stop" && "fill-current")}
                />
              )}
            </TooltipTrigger>
            <TooltipPopup side="left">{action.tooltip}</TooltipPopup>
          </Tooltip>
        );
      })}
    </div>
  );
}
