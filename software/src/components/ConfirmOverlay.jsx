import { useEffect, useRef } from "react";
import {
  closeConfirmDialog,
  useFeedback
} from "../state/feedbackStore.js";

export function ConfirmOverlay() {
  const { confirm } = useFeedback();
  const acceptRef = useRef(null);

  useEffect(() => {
    if (confirm.open) {
      acceptRef.current?.focus();
    }
  }, [confirm.open]);

  return (
    <div
      id="confirmOverlay"
      className={`confirm-overlay${confirm.open ? "" : " hidden"}`}
      role="dialog"
      aria-modal="true"
      aria-labelledby="confirmTitle"
      onClick={event => {
        if (event.target.id === "confirmOverlay") {
          closeConfirmDialog(false);
        }
      }}
    >
      <div className="confirm-dialog">
        <span className="eyebrow">Potwierdzenie akcji</span>
        <h2 id="confirmTitle">{confirm.title}</h2>
        <p id="confirmMessage">{confirm.message}</p>
        <div className="confirm-actions">
          <button id="confirmCancel" className="secondary-button" type="button" onClick={() => closeConfirmDialog(false)}>Anuluj</button>
          <button
            id="confirmAccept"
            ref={acceptRef}
            className={confirm.danger ? "danger" : ""}
            type="button"
            onClick={() => closeConfirmDialog(true)}
          >
            {confirm.confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
