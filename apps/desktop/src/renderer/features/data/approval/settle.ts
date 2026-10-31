/**
 * Once a target is approved here, other Agent Sessions still asking for it are answered too, so
 * none stays Needs You for what Data already shows approved (F3). Mounted once, with the inbox.
 */
import type { ApprovalRequest } from "@polaris/protocol";
import { useEffect } from "react";
import { useStore } from "zustand";
import { useApp } from "../../../shell/hooks.ts";
import type { HostModel } from "../../../store/hostModel.ts";
import { decide } from "../../needs-you/respond.ts";
import { coveredPending, decisionStore, settleOnce } from "./decide.ts";
import { approveDecision } from "./model.ts";

const pendingOn = (model: HostModel) =>
  [...model.sessions.values()].flatMap(({ session, pendingApprovals }) =>
    pendingApprovals.map((request: ApprovalRequest) => ({ sessionId: session.id, request }))
  );

export const useSettleCoveredApprovals = () => {
  const models = useApp((s) => s.hostModels);
  const decided = useStore(decisionStore, (s) => s.decided);
  const grants = useStore(decisionStore, (s) => s.grants);

  useEffect(() => {
    for (const [hostKey, model] of Object.entries(models))
      for (const { sessionId, request } of coveredPending(hostKey, pendingOn(model), {
        decided,
        grants,
      }))
        if (settleOnce(request.id))
          void decide({ hostKey, sessionId, request }, approveDecision("target"));
  }, [models, decided, grants]);
};
