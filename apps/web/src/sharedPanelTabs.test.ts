import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { Atom, AtomRegistry } from "effect/reactivity";
import { expect, it } from "vite-plus/test";

import {
  selectThreadRightPanelState,
  sharedRightPanelRef,
  useRightPanelStore,
} from "./rightPanelStore";
import { subscribeSharedPanelTabs } from "./sharedPanelTabs";

type PanelThread = Pick<EnvironmentThreadShell, "environmentId" | "id" | "lineage">;

function thread(id: string, parent: string | null = null): PanelThread {
  return {
    environmentId: EnvironmentId.make("local"),
    id: ThreadId.make(id),
    lineage: {
      parentThreadId: parent ? ThreadId.make(parent) : null,
      relationshipToParent: parent ? "fork" : null,
      rootThreadId: ThreadId.make("source"),
    },
  };
}

function setup(initial: ReadonlyArray<ReturnType<typeof thread>>) {
  const tasks: Array<() => void> = [];
  const registry = AtomRegistry.make({
    scheduleTask: (task) => {
      tasks.push(task);
      return () => {};
    },
  });
  const threads = Atom.make(initial);
  const stop = subscribeSharedPanelTabs(registry, threads);
  return {
    update(next: typeof initial) {
      registry.set(threads, next);
      for (let task = tasks.shift(); task !== undefined; task = tasks.shift()) task();
    },
    [Symbol.dispose]() {
      stop();
      registry.dispose();
    },
  };
}

it("links existing nested forks at startup and keeps tab changes shared after reload", async () => {
  useRightPanelStore.setState({ byThreadKey: {} });
  const source = scopeThreadRef(EnvironmentId.make("local"), ThreadId.make("source"));
  const fork = scopeThreadRef(EnvironmentId.make("local"), ThreadId.make("fork"));
  const nested = scopeThreadRef(EnvironmentId.make("local"), ThreadId.make("nested"));
  const store = useRightPanelStore.getState();
  store.openFile(source, "source.ts");
  store.openFile(fork, "fork.ts");
  store.openBrowser(nested, "nested-browser");
  const { storage, name } = useRightPanelStore.persist.getOptions();
  const unlinked = await storage!.getItem(name!);
  const shells = [thread("nested", "fork"), thread("fork", "source"), thread("source")];
  using sync = setup(shells);
  const read = (ref: typeof source) =>
    selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, ref);
  expect(sharedRightPanelRef(nested)).toEqual(source);
  expect(read(source).surfaces.map((surface) => surface.id)).toEqual([
    "file:source.ts",
    "file:fork.ts",
    "browser:nested-browser",
  ]);
  store.open(nested, "files");
  expect(read(source).activeSurfaceId).toBe("files");
  store.closeSurface(fork, "file:source.ts");
  expect(read(source).surfaces.some((surface) => surface.id === "file:source.ts")).toBe(false);
  const saved = await storage!.getItem(name!);
  useRightPanelStore.setState({ byThreadKey: {} });
  await storage!.setItem(name!, saved!);
  await useRightPanelStore.persist.rehydrate();
  sync.update([...shells]);
  expect(read(nested)).toBe(read(source));
  expect(read(nested).activeSurfaceId).toBe("files");
  expect(read(source).surfaces).toHaveLength(3);
  await storage!.setItem(name!, unlinked!);
  await useRightPanelStore.persist.rehydrate();
  expect(read(nested)).toBe(read(source));
  expect(read(source).surfaces).toHaveLength(3);
  expect(read(source).surfaces.some((surface) => surface.id === "file:source.ts")).toBe(true);
});

it("waits for missing parents and preserves existing links while excluding side chats and subagents", () => {
  useRightPanelStore.setState({ byThreadKey: {} });
  const source = scopeThreadRef(EnvironmentId.make("local"), ThreadId.make("source"));
  const fork = scopeThreadRef(EnvironmentId.make("local"), ThreadId.make("fork"));
  const unrelated = scopeThreadRef(EnvironmentId.make("local"), ThreadId.make("unrelated"));
  const store = useRightPanelStore.getState();
  using sync = setup([thread("fork", "source")]);
  expect(sharedRightPanelRef(fork)).toEqual(fork);
  store.sharePanel(fork, unrelated);
  sync.update([
    thread("source"),
    thread("fork", "source"),
    {
      ...thread("side", "source"),
      lineage: { ...thread("side", "source").lineage, sideChat: true },
    },
    {
      ...thread("agent", "source"),
      lineage: { ...thread("agent", "source").lineage, relationshipToParent: "subagent" },
    },
    { ...thread("remote", "source"), environmentId: EnvironmentId.make("remote") },
    thread("late", "source"),
  ]);
  expect(sharedRightPanelRef(fork)).toEqual(unrelated);
  expect(
    sharedRightPanelRef(scopeThreadRef(EnvironmentId.make("local"), ThreadId.make("late"))),
  ).toEqual(source);
  for (const ref of [
    scopeThreadRef(EnvironmentId.make("local"), ThreadId.make("side")),
    scopeThreadRef(EnvironmentId.make("local"), ThreadId.make("agent")),
    scopeThreadRef(EnvironmentId.make("remote"), ThreadId.make("remote")),
  ]) {
    expect(sharedRightPanelRef(ref)).toEqual(ref);
  }
});
