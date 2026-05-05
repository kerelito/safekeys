export function LogDetailsOverlay() {
  return (
    <div id="logDetailsOverlay" className="confirm-overlay hidden" role="dialog" aria-modal="true" aria-labelledby="logDetailsTitle">
      <div className="confirm-dialog log-details-dialog">
        <span className="eyebrow">Szczegóły zdarzenia</span>
        <h2 id="logDetailsTitle">Log systemowy</h2>
        <p id="logDetailsSummary">Szczegółowe informacje o zdarzeniu.</p>
        <dl id="logDetailsList" className="log-details-list" />
        <div className="confirm-actions">
          <button id="logDetailsClose" className="secondary-button" type="button">Zamknij</button>
        </div>
      </div>
    </div>
  );
}
