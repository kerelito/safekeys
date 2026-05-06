import {
  closeLogDetails,
  useFeedback
} from "../state/feedbackStore.js";

export function LogDetailsOverlay() {
  const { logDetails } = useFeedback();

  return (
    <div
      id="logDetailsOverlay"
      className={`confirm-overlay${logDetails.open ? "" : " hidden"}`}
      role="dialog"
      aria-modal="true"
      aria-labelledby="logDetailsTitle"
      onClick={event => {
        if (event.target.id === "logDetailsOverlay") {
          closeLogDetails();
        }
      }}
    >
      <div className="confirm-dialog log-details-dialog">
        <span className="eyebrow">Szczegóły zdarzenia</span>
        <h2 id="logDetailsTitle">Log systemowy</h2>
        <p id="logDetailsSummary">{logDetails.summary}</p>
        <dl id="logDetailsList" className="log-details-list">
          {logDetails.details.map(([label, value]) => (
            <div key={`${label}-${value}`}>
              <dt>{label}</dt>
              <dd>{value}</dd>
            </div>
          ))}
        </dl>
        <div className="confirm-actions">
          <button id="logDetailsClose" className="secondary-button" type="button" onClick={closeLogDetails}>Zamknij</button>
        </div>
      </div>
    </div>
  );
}
