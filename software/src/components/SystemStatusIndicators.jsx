function StatusIndicator({ id, service, label, title, summary, ariaLabel }) {
  return (
    <button id={id} className="status-indicator" type="button" data-service={service} aria-label={ariaLabel}>
      <span className="status-dot" />
      <span className="status-label">{label}</span>
      <span className="status-popover">
        <strong>{title}</strong>
        <small>{summary}</small>
      </span>
    </button>
  );
}

export function SystemStatusIndicators() {
  return (
    <div id="systemStatus" className="system-status" aria-label="Status systemu">
      <StatusIndicator
        id="serverStatus"
        service="server"
        label="API"
        title="Serwer"
        summary="Łączenie..."
        ariaLabel="Status połączenia z serwerem"
      />
      <StatusIndicator
        id="databaseStatus"
        service="database"
        label="DB"
        title="Baza danych"
        summary="Oczekiwanie na status..."
        ariaLabel="Status połączenia z bazą danych"
      />
      <StatusIndicator
        id="esp32Status"
        service="esp32"
        label="ESP32"
        title="ESP32"
        summary="Oczekiwanie na heartbeat..."
        ariaLabel="Status połączenia z ESP32"
      />
    </div>
  );
}
