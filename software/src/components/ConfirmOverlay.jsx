export function ConfirmOverlay() {
  return (
    <div id="confirmOverlay" className="confirm-overlay hidden" role="dialog" aria-modal="true" aria-labelledby="confirmTitle">
      <div className="confirm-dialog">
        <span className="eyebrow">Potwierdzenie akcji</span>
        <h2 id="confirmTitle">Potwierdź operację</h2>
        <p id="confirmMessage">Ta akcja wymaga potwierdzenia.</p>
        <div className="confirm-actions">
          <button id="confirmCancel" className="secondary-button" type="button">Anuluj</button>
          <button id="confirmAccept" className="danger" type="button">Potwierdź</button>
        </div>
      </div>
    </div>
  );
}
