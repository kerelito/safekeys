import { useFeedback } from "../state/feedbackStore.js";

export function Toast() {
  const { toast } = useFeedback();

  return (
    <div id="toast" className={`toast${toast.visible ? " show" : ""}${toast.isError ? " is-error" : ""}`}>
      {toast.message}
    </div>
  );
}
