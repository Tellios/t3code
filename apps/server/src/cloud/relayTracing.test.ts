import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import type { ManagedPolicyDocument } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as RelayTracing from "@t3tools/shared/relayTracing";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { FetchHttpClient, HttpClient, HttpClientResponse } from "effect/http";

import * as ServerConfig from "../config.ts";
import * as ManagedPolicy from "../policy/ManagedPolicy.ts";
import { relayLayer } from "./relayTracing.ts";

const tracingLayer = (env: NodeJS.ProcessEnv, policy?: ManagedPolicyDocument) =>
  relayLayer(
    { serviceName: "t3code-server", runtime: "node", client: "environment-server" },
    { tracesUrl: "https://traces.example.com", tracesDataset: "relay", tracesToken: "token" },
  ).pipe(
    Layer.provide(ManagedPolicy.layerTest(policy)),
    Layer.provide(Layer.succeed(HostProcess.Environment, env)),
    Layer.provide(
      ServerConfig.layerTest(process.cwd(), { prefix: "t3-relay-tracing-" }).pipe(
        Layer.provide(NodeServices.layer),
      ),
    ),
  );

const tracesTo = (env: NodeJS.ProcessEnv, policy?: ManagedPolicyDocument) =>
  Effect.service(RelayTracing.RelayClientTracer).pipe(
    Effect.provide(tracingLayer(env, policy).pipe(Layer.provide(FetchHttpClient.layer))),
    Effect.map(Option.isSome),
  );

it.effect("requires opt-in for relay tracing to T3 Connect and respects managed policy", () =>
  Effect.gen(function* () {
    const optedIn = { T3CODE_TELEMETRY_ENABLED: "true" };
    assert.isFalse(yield* tracesTo({}));
    assert.isFalse(yield* tracesTo({ T3CODE_TELEMETRY_ENABLED: "false" }));
    assert.isTrue(yield* tracesTo(optedIn));
    assert.isFalse(
      yield* tracesTo(optedIn, {
        schemaVersion: 1,
        organization: "Example Corp",
        limits: { telemetry: false },
      }),
    );
  }),
);

it.effect("exports desktop relay spans only after the login shell confirms opt-in", () =>
  Effect.gen(function* () {
    const env: NodeJS.ProcessEnv = { T3CODE_DESKTOP_SHELL_DISCOVERY_PENDING: "1" };
    const payloads: Array<string> = [];
    const client = HttpClient.make((request) =>
      Effect.sync(() => {
        if (request.body._tag === "Uint8Array") {
          payloads.push(new TextDecoder().decode(request.body.body));
        }
        return HttpClientResponse.fromWeb(request, new Response(null, { status: 202 }));
      }),
    );

    yield* Effect.gen(function* () {
      yield* Effect.void.pipe(
        Effect.withSpan("relay.before-shell"),
        RelayTracing.withRelayClientTracing,
      );
      delete env.T3CODE_DESKTOP_SHELL_DISCOVERY_PENDING;
      yield* Effect.void.pipe(
        Effect.withSpan("relay.without-opt-in"),
        RelayTracing.withRelayClientTracing,
      );
      env.T3CODE_TELEMETRY_ENABLED = "true";
      yield* Effect.void.pipe(
        Effect.withSpan("relay.opted-in"),
        RelayTracing.withRelayClientTracing,
      );
    }).pipe(
      Effect.provide(
        tracingLayer(env).pipe(Layer.provide(Layer.succeed(HttpClient.HttpClient, client))),
      ),
    );

    assert.lengthOf(payloads, 1);
    assert.include(payloads[0], '"name":"relay.opted-in"');
    assert.notInclude(payloads[0], "relay.before-shell");
    assert.notInclude(payloads[0], "relay.without-opt-in");
  }),
);
