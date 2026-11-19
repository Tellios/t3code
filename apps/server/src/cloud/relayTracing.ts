import * as HostProcess from "@t3tools/shared/HostProcess";
import {
  nodeProcessRuntimeAttributes,
  processServiceInstanceId,
} from "@t3tools/shared/observability";
import { isRelayTracingEnabled } from "@t3tools/shared/otelEnvironment";
import * as RelayTracing from "@t3tools/shared/relayTracing";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ServerConfig from "../config.ts";
import * as ManagedPolicy from "../policy/ManagedPolicy.ts";
import { resolveRelayClientTracingConfig } from "./publicConfig.ts";

/** Relay traces leave the machine for T3 Connect, so a policy with `telemetry: false` stops them. */
export const relayLayer = (
  resource: Omit<RelayTracing.RelayClientTracingResource, "serviceInstanceId">,
  tracingConfig?: RelayTracing.RelayClientTracingConfig,
) =>
  Layer.unwrap(
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      const policy = yield* ManagedPolicy.ManagedPolicy;
      const env = yield* HostProcess.Environment;
      const awaitingShellConsent = env.T3CODE_DESKTOP_SHELL_DISCOVERY_PENDING === "1";
      const isEnabled = () =>
        env.T3CODE_DESKTOP_SHELL_DISCOVERY_PENDING !== "1" && isRelayTracingEnabled(env);
      const canTrace =
        ManagedPolicy.deniedBy(policy, "telemetry") === undefined &&
        (awaitingShellConsent || isEnabled());
      return RelayTracing.layer(
        canTrace ? (tracingConfig ?? resolveRelayClientTracingConfig(env)) : null,
        {
          ...resource,
          serviceInstanceId: processServiceInstanceId(config.otelEnvironment.resourceAttributes),
        },
        awaitingShellConsent ? { isEnabled } : undefined,
      );
    }),
  );

export const layerHeadlessRelayClient = relayLayer({
  serviceName: "t3code-server",
  runtime: "node",
  attributes: nodeProcessRuntimeAttributes(),
  client: "headless-cli",
});

export const layerServerRelayBroker = relayLayer({
  serviceName: "t3code-server",
  runtime: "node",
  attributes: nodeProcessRuntimeAttributes(),
  client: "environment-server",
  component: "relay-broker",
});
