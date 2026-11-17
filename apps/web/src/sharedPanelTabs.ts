import { scopeThreadRef, scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import type { Atom, AtomRegistry } from "effect/reactivity";

import { useRightPanelStore } from "./rightPanelStore";

type ForkPanelThread = Pick<EnvironmentThreadShell, "environmentId" | "id" | "lineage">;

export function subscribeSharedPanelTabs(
  registry: AtomRegistry.AtomRegistry,
  threadsAtom: Atom.Atom<ReadonlyArray<ForkPanelThread>>,
): () => void {
  const reconcile = (threads: ReadonlyArray<ForkPanelThread>) => {
    const available = new Set(
      threads.map((thread) => scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id))),
    );
    for (const thread of threads) {
      const { lineage } = thread;
      if (lineage.relationshipToParent !== "fork" || lineage.sideChat || !lineage.parentThreadId) {
        continue;
      }
      const ref = scopeThreadRef(thread.environmentId, thread.id);
      const parent = scopeThreadRef(thread.environmentId, lineage.parentThreadId);
      const store = useRightPanelStore.getState();
      if (store.byThreadKey[scopedThreadKey(ref)]?.sharedWithThreadKey) continue;
      if (available.has(scopedThreadKey(parent))) store.sharePanel(ref, parent);
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
