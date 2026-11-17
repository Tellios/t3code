import type {
  EnvironmentId,
  PreviewCloseInput,
  PreviewSessionSnapshot,
  ScopedThreadRef,
} from "@t3tools/contracts";
import { Atom, AsyncResult } from "effect/reactivity";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import {
  applyPreviewServerSnapshot,
  readThreadPreviewState,
  resetPreviewStateForTests,
} from "~/previewStateStore";

import { useClosedViewStore } from "~/closedViewStore";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import { primaryEnvironmentIdAtom } from "~/state/primaryEnvironment";
import { useRightPanelStore } from "~/rightPanelStore";

import { closePreviewSession } from "./closePreviewSession";

vi.mock("~/env", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/env")>()),
  isElectron: true,
}));
vi.mock("~/state/primaryEnvironment", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/state/primaryEnvironment")>()),
  primaryEnvironmentIdAtom: Atom.make<EnvironmentId | null>(null),
}));

const threadRef = {
  environmentId: "local" as ScopedThreadRef["environmentId"],
  threadId: "thread-1" as ScopedThreadRef["threadId"],
};

const snapshot: PreviewSessionSnapshot = {
  threadId: threadRef.threadId,
  tabId: "tab-1",
  navStatus: {
    _tag: "Success",
    url: "http://localhost:3000/",
    title: "Local app",
  },
  canGoBack: false,
  canGoForward: false,
  updatedAt: "2026-06-18T19:00:00.000Z",
};

const setPrimaryEnvironment = (environmentId: EnvironmentId | null) => {
  if (!Atom.isWritable<EnvironmentId | null, EnvironmentId | null>(primaryEnvironmentIdAtom)) {
    throw new Error("primaryEnvironmentIdAtom is not writable");
  }
  appAtomRegistry.set(primaryEnvironmentIdAtom, environmentId);
};

beforeEach(() => {
  resetPreviewStateForTests();
  setPrimaryEnvironment(null);
  useClosedViewStore.setState({ entries: [] });
  useRightPanelStore.setState({ byThreadKey: {} });
});

describe("closePreviewSession", () => {
  it("closes a fork-owned browser without suppressing the source's session", async () => {
    const forkRef = { ...threadRef, threadId: "fork" as ScopedThreadRef["threadId"] };
    useRightPanelStore.getState().sharePanel(forkRef, threadRef);
    const forkSnapshot = { ...snapshot, threadId: forkRef.threadId, tabId: "fork-browser" };
    applyPreviewServerSnapshot(threadRef, snapshot);
    applyPreviewServerSnapshot(forkRef, forkSnapshot);
    await closePreviewSession({
      closePreview: async () => AsyncResult.success(undefined),
      snapshot: forkSnapshot,
      tabId: forkSnapshot.tabId,
      threadRef: forkRef,
    });
    expect(readThreadPreviewState(forkRef).sessions).toEqual({});
    expect(readThreadPreviewState(threadRef).sessions[snapshot.tabId]).toEqual(snapshot);
    expect(useClosedViewStore.getState().entries).toMatchObject([
      { kind: "browser", threadRef: forkRef, snapshot: forkSnapshot },
    ]);
  });

  it.each([false, true])(
    "suppresses stale server snapshots while the close is in flight, fork=%s",
    async (fork) => {
      const target = { ...threadRef, threadId: "fork" as ScopedThreadRef["threadId"] };
      if (fork) useRightPanelStore.getState().sharePanel(target, threadRef);
      applyPreviewServerSnapshot(threadRef, snapshot);
      let finishClose: (() => void) | undefined;
      const closePreview = vi.fn(
        (_input: PreviewCloseInput) =>
          new Promise<ReturnType<typeof AsyncResult.success<void>>>((resolve) => {
            finishClose = () => resolve(AsyncResult.success(undefined));
          }),
      );

      const closing = closePreviewSession({
        closePreview: ({ input }) => closePreview(input),
        snapshot,
        tabId: snapshot.tabId,
        threadRef: fork ? target : threadRef,
      });

      expect(useClosedViewStore.getState().entries).toEqual([]);
      expect(readThreadPreviewState(threadRef).sessions).toEqual({});
      applyPreviewServerSnapshot(threadRef, snapshot);
      expect(readThreadPreviewState(threadRef).sessions).toEqual({});

      finishClose?.();
      await closing;
      expect(useClosedViewStore.getState().entries).toMatchObject([
        { kind: "browser", threadRef, snapshot },
      ]);
      expect(closePreview).toHaveBeenCalledWith({ threadId: "thread-1", tabId: "tab-1" });
    },
  );

  it("keeps a tab this desktop renders mounted until the server has closed it", async () => {
    setPrimaryEnvironment(threadRef.environmentId);
    const desktopSnapshot = { ...snapshot, runtime: "server" as const };
    applyPreviewServerSnapshot(threadRef, desktopSnapshot);
    let finishClose: (() => void) | undefined;
    const closing = closePreviewSession({
      closePreview: () =>
        new Promise<ReturnType<typeof AsyncResult.success<void>>>((resolve) => {
          finishClose = () => resolve(AsyncResult.success(undefined));
        }),
      snapshot: desktopSnapshot,
      tabId: desktopSnapshot.tabId,
      threadRef,
    });

    expect(readThreadPreviewState(threadRef).sessions).toEqual({ "tab-1": desktopSnapshot });
    finishClose?.();
    await closing;
    expect(readThreadPreviewState(threadRef).sessions).toEqual({});
    applyPreviewServerSnapshot(threadRef, desktopSnapshot);
    expect(readThreadPreviewState(threadRef).sessions).toEqual({});
  });
});
