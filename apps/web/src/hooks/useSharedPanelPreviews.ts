import { useAtomValue } from "@effect/atom-react";
import { parseScopedThreadKey, scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";

import {
  previewStateAtom,
  useThreadPreviewState,
  type ThreadPreviewState,
} from "../previewStateStore";
import {
  selectSharedPanelThreadKeys,
  sharedRightPanelRef,
  useRightPanelStore,
} from "../rightPanelStore";

const sharedPanelPreviewsAtom = Atom.family((key: string) => {
  const keys = JSON.parse(key) as string[];
  const threadRefs = keys.flatMap((key) => {
    const ref = parseScopedThreadKey(key);
    return ref ? [ref] : [];
  });
  return Atom.make((get) => {
    const states = threadRefs.map((ref) => get(previewStateAtom(scopedThreadKey(ref))));
    return {
      threadRefs,
      serverEpoch: states.find((state) => state.serverEpoch !== null)?.serverEpoch ?? null,
      sessions: states.reduce<ThreadPreviewState["sessions"]>(
        (sessions, state) => Object.assign(sessions, state.sessions),
        {},
      ),
      desktopByTabId: states.reduce<ThreadPreviewState["desktopByTabId"]>(
        (overlays, state) => Object.assign(overlays, state.desktopByTabId),
        {},
      ),
    };
  });
});

export function useSharedPanelPreviews(ref: ScopedThreadRef | null) {
  const keys = useRightPanelStore((state) =>
    JSON.stringify(ref ? selectSharedPanelThreadKeys(state.byThreadKey, ref) : []),
  );
  const shared = useAtomValue(sharedPanelPreviewsAtom(keys));
  const previewState = useThreadPreviewState(ref ? sharedRightPanelRef(ref) : null);
  return { threadRefs: shared.threadRefs, previewState: { ...previewState, ...shared } };
}
