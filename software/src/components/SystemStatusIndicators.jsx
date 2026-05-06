import {
  getSystemStatusModel,
  useSystemStatus
} from "../state/systemStatusStore.js";

function StatusIndicator({ ariaLabel, id, label, service, status }) {
  return (
    <button id={id} className={`status-indicator is-${status.state}`} type="button" data-service={service} aria-label={ariaLabel}>
      <span className="status-dot" />
      <span className="status-label">{label}</span>
      <span className="status-popover">
        <strong>{status.title}</strong>
        <small>{status.summary}</small>
        {status.lines.length > 0 && (
          <div className="status-lines">
            {status.lines.map(line => (
              <span className="status-line" key={line}>{line}</span>
            ))}
          </div>
        )}
      </span>
    </button>
  );
}

export function SystemStatusIndicators() {
  const status = useSystemStatus();
  const model = getSystemStatusModel(status);

  return (
    <div id="systemStatus" className="system-status" aria-label="Status systemu">
      <StatusIndicator
        id="serverStatus"
        service="server"
        label="API"
        status={model.indicators.server}
        ariaLabel="Status połączenia z serwerem"
      />
      <StatusIndicator
        id="databaseStatus"
        service="database"
        label="DB"
        status={model.indicators.database}
        ariaLabel="Status połączenia z bazą danych"
      />
      <StatusIndicator
        id="esp32Status"
        service="esp32"
        label="ESP32"
        status={model.indicators.esp32}
        ariaLabel="Status połączenia z ESP32"
      />
    </div>
  );
}
