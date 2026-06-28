import type { PermissionDecision, PermissionScope } from "@wcc/shared";
import type { PendingPermission } from "../session-model.js";
import { DiffView } from "./DiffView.js";

/** The approval gate: shows the proposed tool + diff, and the signed-decision buttons. */
export function PermissionPrompt({
  pending,
  onDecide,
}: {
  pending: PendingPermission;
  onDecide: (requestId: string, decision: PermissionDecision, scope?: PermissionScope) => void;
}) {
  const path =
    typeof pending.input === "object" && pending.input && "path" in pending.input
      ? String((pending.input as { path: unknown }).path)
      : undefined;

  return (
    <div className="permission">
      <div className="permission-head">
        <span className="permission-title">Approve {pending.toolName}?</span>
        {path && <span className="permission-path">{path}</span>}
      </div>
      {pending.diff && <DiffView unified={pending.diff.unified} />}
      <div className="permission-actions">
        <button className="btn approve" onClick={() => onDecide(pending.requestId, "approve")}>
          Approve once
        </button>
        <button className="btn approve-session" onClick={() => onDecide(pending.requestId, "approve", "session")}>
          Approve for session
        </button>
        <button className="btn deny" onClick={() => onDecide(pending.requestId, "deny")}>
          Deny
        </button>
      </div>
    </div>
  );
}
