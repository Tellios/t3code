import type { PreviewSessionSnapshot, ScopedThreadRef } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/reactivity";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import type { OpenPreviewMutation } from "~/browser/openFileInPreview";
import * as previewRuntime from "~/browser/previewRuntime";
import { openTerminalLinkInPreview } from "./openTerminalLinkInPreview";
import { readThreadPreviewState, resetPreviewStateForTests } from "~/previewStateStore";
import { selectThreadRightPanelState, useRightPanelStore } from "~/rightPanelStore";

vi.mock("~/browser/previewRuntime", () => ({
  isPreviewAvailableFor: () => true,
  previewRuntimeFor: () => undefined,
}));

const browserDefaultsMocks = vi.hoisted(() => ({
  resolve: vi.fn(),
}));

vi.mock("~/browser/browserDefaults", () => ({
  resolveBrowserDefaults: browserDefaultsMocks.resolve,
}));

const linkTargetMocks = vi.hoisted(() => ({
  preference: vi.fn<() => "system" | "app">(),
}));

vi.mock("~/browser/browserLinkTarget", () => ({
  resolveBrowserLinkTargetPreference: async () => linkTargetMocks.preference(),
  isWebUrl: (url: string) => /^https?:/u.test(url),
}));

const hydratedDefaults = {
  viewport: { _tag: "fixed", width: 1280, height: 720 } as const,
  profileId: "work",
  zoomFactor: 0.8,
  appearance: "dark",
};

const threadRef = {
  environmentId: "local" as ScopedThreadRef["environmentId"],
  threadId: "thread-1" as ScopedThreadRef["threadId"],
};

beforeEach(() => {
  resetPreviewStateForTests();
  useRightPanelStore.setState({ byThreadKey: {} });
  browserDefaultsMocks.resolve.mockReset();
  browserDefaultsMocks.resolve.mockResolvedValue(hydratedDefaults);
  linkTargetMocks.preference.mockReturnValue("app");
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("openTerminalLinkInPreview", () => {
  it("opens a fork's terminal link in the shared browser session", async () => {
    const forkRef = { ...threadRef, threadId: "fork" as ScopedThreadRef["threadId"] };
    useRightPanelStore.getState().sharePanel(forkRef, threadRef);
    const snapshot: PreviewSessionSnapshot = {
      threadId: threadRef.threadId,
      tabId: "tab-1",
      navStatus: { _tag: "Success", url: "http://localhost:5173/", title: "App" },
      canGoBack: false,
      canGoForward: false,
      updatedAt: "2026-11-16T00:00:00.000Z",
    };
    await openTerminalLinkInPreview({
      url: "http://localhost:5173/",
      threadRef: forkRef,
      openPreview: async ({ input }) =>
        input.threadId === snapshot.threadId
          ? AsyncResult.success(snapshot)
          : AsyncResult.failure(Cause.fail(new Error("Wrong session owner"))),
      fallbackToBrowser: () => {
        throw new Error("Unexpected external browser");
      },
      forceBrowser: false,
    });
    expect(readThreadPreviewState(threadRef).sessions[snapshot.tabId]).toEqual(snapshot);
    expect(readThreadPreviewState(forkRef).sessions).toEqual({});
    const panels = useRightPanelStore.getState().byThreadKey;
    expect(selectThreadRightPanelState(panels, forkRef)).toBe(
      selectThreadRightPanelState(panels, threadRef),
    );
    expect(selectThreadRightPanelState(panels, forkRef).activeSurfaceId).toBe("browser:tab-1");
  });

  it("does not report or fall back when opening the preview is interrupted", async () => {
    const fallbackToBrowser = vi.fn();
    const reportError = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await openTerminalLinkInPreview({
      url: "http://localhost:5173/",
      threadRef,
      openPreview: async () => AsyncResult.failure(Cause.interrupt()),
      fallbackToBrowser,
      forceBrowser: false,
    });

    expect(reportError).not.toHaveBeenCalled();
    expect(fallbackToBrowser).not.toHaveBeenCalled();
  });

  it("opens a server tab with the default zoom and appearance", async () => {
    vi.spyOn(previewRuntime, "previewRuntimeFor").mockReturnValue("server");
    const openPreview = vi.fn<OpenPreviewMutation>(async () =>
      AsyncResult.failure(Cause.interrupt()),
    );

    await openTerminalLinkInPreview({
      url: "https://t3.chat/",
      threadRef,
      openPreview,
      fallbackToBrowser: vi.fn(),
      forceBrowser: false,
    });

    expect(openPreview).toHaveBeenCalledExactlyOnceWith({
      environmentId: threadRef.environmentId,
      input: expect.objectContaining({ runtime: "server", zoomFactor: 0.8, colorScheme: "dark" }),
    });
  });
});
