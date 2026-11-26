import { scopeThreadRef, scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { isListedThreadLineage, type ScopedThreadRef } from "@t3tools/contracts";
import type { Atom, AtomRegistry } from "effect/reactivity";

import { useRightPanelStore } from "./rightPanelStore";

type SharedPanelThread = Pick<
  EnvironmentThreadShell,
  "environmentId" | "id" | "lineage" | "worktreePath" | "createdAt" | "delegatedFrom"
>;

/** Forks share their parent's panel; threads in the same worktree share its first thread's. */
export function subscribeSharedPanelTabs(
  registry: AtomRegistry.AtomRegistry,
  threadsAtom: Atom.Atom<ReadonlyArray<SharedPanelThread>>,
): () => void {
  const reconcile = (threads: ReadonlyArray<SharedPanelThread>) => {
    const available = new Set(
      threads.map((thread) => scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id))),
    );
    const worktreeAnchors = new Map<string, SharedPanelThread>();
    for (const thread of threads) {
      if (!isListedThreadLineage(thread.lineage) || thread.delegatedFrom != null) continue;
      if (!thread.worktreePath) continue;
      const key = `${thread.environmentId}\u0000${thread.worktreePath}`;
      const anchor = worktreeAnchors.get(key);
      if (!anchor || thread.createdAt < anchor.createdAt) worktreeAnchors.set(key, thread);
    }
    const share = (ref: ScopedThreadRef, source: ScopedThreadRef) => {
      const store = useRightPanelStore.getState();
      if (store.byThreadKey[scopedThreadKey(ref)]?.sharedWithThreadKey) return;
      store.sharePanel(ref, source);
    };
    for (const thread of threads) {
      const { lineage } = thread;
      const ref = scopeThreadRef(thread.environmentId, thread.id);
      if (lineage.relationshipToParent === "fork" && !lineage.sideChat && lineage.parentThreadId) {
        const parent = scopeThreadRef(thread.environmentId, lineage.parentThreadId);
        if (available.has(scopedThreadKey(parent))) share(ref, parent);
      }
      if (!isListedThreadLineage(lineage) || thread.delegatedFrom != null) continue;
      if (!thread.worktreePath) continue;
      const anchor = worktreeAnchors.get(`${thread.environmentId}\u0000${thread.worktreePath}`);
      if (anchor && anchor.id !== thread.id) {
        share(ref, scopeThreadRef(anchor.environmentId, anchor.id));
      }
    }
  };
  const stopHydration = useRightPanelStore.persist.onFinishHydration(() =>
    reconcile(registry.get(threadsAtom)),
  );
  const unsubscribe = registry.subscribe(threadsAtom, reconcile, { immediate: true });
  return () => {
    unsubscribe();
    stopHydration();
  };
}
