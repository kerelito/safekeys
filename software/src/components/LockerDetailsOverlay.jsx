export function LockerDetailsOverlay() {
  return (
    <div id="lockerDetailsOverlay" className="confirm-overlay hidden" role="dialog" aria-modal="true" aria-labelledby="lockerDetailsTitle">
      <div className="confirm-dialog locker-details-dialog">
        <span className="eyebrow">Szczegóły skrytki</span>
        <h2 id="lockerDetailsTitle">Skrytka</h2>
        <p id="lockerDetailsSummary">Aktualny stan komory i ostatnie zdarzenia.</p>
        <div id="lockerDetailsStatus" className="locker-details-status" />
        <div id="lockerDetailsItem" className="locker-details-item" />
        <div className="locker-details-history">
          <div className="locker-details-history-header">
            <strong>Ostatnie zdarzenia</strong>
            <button id="lockerDetailsRefresh" className="secondary-button" type="button">Odśwież</button>
          </div>
          <div id="lockerDetailsLogs" className="locker-details-logs" />
        </div>
        <div className="confirm-actions">
          <button id="lockerDetailsOpen" type="button" data-operation-only>Otwórz skrytkę</button>
          <button id="lockerDetailsClose" className="secondary-button" type="button">Zamknij</button>
        </div>
      </div>
    </div>
  );
}
