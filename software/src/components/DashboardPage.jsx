import { useEffect, useMemo, useRef, useState } from "react";
import {
  copyActiveCode,
  deactivateActiveCode,
  pruneExpiredActiveCodes,
  useActiveCodes
} from "../state/activeCodesStore.js";
import { useAlerts } from "../state/alertsStore.js";
import {
  openLockerDetailsFromStore,
  openLockerFromStore,
  refreshLockersFromStore,
  releaseAllLockersFromStore,
  useLockers
} from "../state/lockersStore.js";
import {
  refreshRemoteActions,
  useRemoteActions
} from "../state/remoteActionsStore.js";
import {
  clearLogsFromStore,
  exportLogsFromStore,
  openLogDetailsFromStore,
  refreshLogs,
  resetLogFilters,
  setLogFilter,
  useLogs
} from "../state/logsStore.js";
import { useAdminLists } from "../state/adminListsStore.js";
import {
  copyGeneratedCode,
  generateCodeFromStore,
  setCodeGeneratorField,
  useCodeGenerator
} from "../state/codeGeneratorStore.js";
import {
  getSystemStatusModel,
  useSystemStatus
} from "../state/systemStatusStore.js";
import { useUiShell } from "../state/uiShellStore.js";

function MetricCard({ label, valueId, initialValue, help }) {
  return (
    <article className="metric-card">
      <span className="metric-label">{label}</span>
      <strong id={valueId} className="metric-value">{initialValue}</strong>
      <small className="metric-help">{help}</small>
    </article>
  );
}

function ReadyLockersMetricCard() {
  const { lockers } = useLockers();
  const readyLockers = lockers.filter(locker => locker.hasTag && locker.isDoorClosed).length;
  const totalLockers = lockers.length || 3;

  return (
    <MetricCard label="Skrytki gotowe" valueId="metricReadyLockers" initialValue={`${readyLockers}/${totalLockers}`} help="Gotowe operacyjnie" />
  );
}

function ActiveCodesMetricCard() {
  const { activeCodes } = useActiveCodes();

  return (
    <MetricCard label="Aktywne kody" valueId="metricActiveCodes" initialValue={String(activeCodes.length)} help="Trwające dostępy" />
  );
}

function RfidUsersMetricCard() {
  const { rfidUsers } = useAdminLists();

  return (
    <MetricCard label="Użytkownicy RFID" valueId="metricRfidUsers" initialValue={String(rfidUsers.length)} help="Przypisane osoby" />
  );
}

function RfidItemsMetricCard() {
  const { rfidItems } = useAdminLists();

  return (
    <MetricCard label="Przedmioty RFID" valueId="metricRfidItems" initialValue={String(rfidItems.length)} help="Zmapowane UID" />
  );
}

function StatusSummaryTile({ accent = false, label, metaId, status, valueId }) {
  return (
    <article className={`status-summary-tile${accent ? " accent" : ""}`} data-state={status.state}>
      <span className="status-summary-label">{label}</span>
      <strong id={valueId} className="status-summary-value">{status.value}</strong>
      <small id={metaId} className="status-summary-meta">{status.meta}</small>
    </article>
  );
}

function HeroCard() {
  const codeGenerator = useCodeGenerator();
  const { canOperateLockers } = useUiShell();
  const generateButtonLabel = codeGenerator.isSubmitting
    ? (codeGenerator.recipientEmail.trim() ? "Generowanie i wysyłka..." : "Generowanie...")
    : (codeGenerator.recipientEmail.trim() ? "Generuj i wyślij" : "Generuj");

  return (
    <div className="card hero-card">
      <div className="hero-header">
        <div>
          <div className="hero-brand">
            <img src="/assets/safekeys-logo.svg" alt="SafeKeys logo" />
            <span>SafeKeys</span>
          </div>
          <span className="eyebrow">Realtime Key Security</span>
          <h1 className="hero-title">Zarządzanie dostępem do kluczy w jednym panelu.</h1>
          <p className="hero-subtitle">
            SafeKeys łączy generowanie kodów, monitoring RFID i podgląd zdarzeń LIVE w jednym nowoczesnym centrum operacyjnym.
          </p>
        </div>
        <div className="hero-badge">SafeKeys LIVE</div>
      </div>

      <div className="field-grid">
        <label className="field">
          <span className="field-label">Wybierz skrytkę</span>
          <select id="locker" value={codeGenerator.locker} onChange={event => setCodeGeneratorField("locker", event.target.value)}>
            <option value="1">Skrytka 1</option>
            <option value="2">Skrytka 2</option>
            <option value="3">Skrytka 3</option>
          </select>
        </label>

        <label className="field">
          <span className="field-label">Czas aktywności</span>
          <select id="hours" value={codeGenerator.hours} onChange={event => setCodeGeneratorField("hours", event.target.value)}>
            <option value="2">2h</option>
            <option value="4">4h</option>
            <option value="6">6h</option>
            <option value="8">8h</option>
            <option value="12">12h</option>
            <option value="24">24h</option>
          </select>
        </label>

        <label className="field">
          <span className="field-label">Akcja</span>
          {canOperateLockers ? (
            <button id="generateButton" type="button" disabled={codeGenerator.isSubmitting} onClick={generateCodeFromStore}>{generateButtonLabel}</button>
          ) : (
            <button id="generateButton" type="button" disabled>Brak uprawnień</button>
          )}
        </label>
      </div>

      <label className="field email-field" data-advanced-only="true">
        <span className="field-label">Wyślij kod na e-mail</span>
        <input
          id="recipientEmail"
          type="email"
          inputMode="email"
          autoComplete="email"
          value={codeGenerator.recipientEmail}
          onChange={event => setCodeGeneratorField("recipientEmail", event.target.value)}
          placeholder="np. operator@firma.pl"
        />
        <small className="field-help">
          Opcjonalnie. Jeśli podasz adres, SafeKeys spróbuje wysłać kod automatycznie zaraz po wygenerowaniu.
        </small>
      </label>

      <div className="generated-output">
        <div className="generated-output-header">
          <small>Ostatnio wygenerowany kod</small>
          <button
            id="copyGeneratedCodeButton"
            className={`inline-copy-button${codeGenerator.hasGeneratedCode ? "" : " hidden"}`}
            type="button"
            onClick={copyGeneratedCode}
          >
            Kopiuj
          </button>
          <span
            id="generatedDeliveryStatus"
            className={`delivery-status${codeGenerator.deliveryStatus.label ? ` ${codeGenerator.deliveryStatus.variant}` : " hidden"}`}
          >
            {codeGenerator.deliveryStatus.label}
          </span>
        </div>
        <h3 id="generatedCode" className="generated-code">{codeGenerator.generatedCode}</h3>
        <p id="generatedCodeMeta" className="generated-meta">
          {codeGenerator.generatedMeta}
        </p>
      </div>

      <div className="hero-metrics">
        <ReadyLockersMetricCard />
        <ActiveCodesMetricCard />
        <RfidUsersMetricCard />
        <RfidItemsMetricCard />
      </div>
    </div>
  );
}

function getLockerSeverity(locker) {
  if (locker.hasTag && locker.isDoorClosed) {
    return "ok";
  }
  if (!locker.hasTag && !locker.isDoorClosed) {
    return "critical";
  }
  if (!locker.hasTag) {
    return "warn";
  }
  return "info";
}

function getLockerSeverityLabel(locker) {
  const severity = getLockerSeverity(locker);
  if (severity === "ok") return "OK";
  if (severity === "critical") return "Błąd";
  if (severity === "warn") return "Ostrzeżenie";
  return "Info";
}

function LockerChamber({ locker, canOperate }) {
  return (
    <article className={`locker-chamber state-${getLockerSeverity(locker)}`}>
      <div className="chamber-header">
        <h3 className="locker-name">S{locker.locker}</h3>
        <span className="chamber-severity">{getLockerSeverityLabel(locker)}</span>
      </div>
      <div className="chamber-icons">
        <span className={`state-icon ${locker.hasTag ? "good" : "bad"}`} title="Stan klucza">
          <span>Klucz</span>
          <strong>{locker.hasTag ? "obecny" : "brak"}</strong>
        </span>
        <span className={`state-icon ${locker.isDoorClosed ? "good" : "warn"}`} title="Stan drzwi">
          <span>Drzwi</span>
          <strong>{locker.isDoorClosed ? "zamknięte" : "otwarte"}</strong>
        </span>
      </div>
      <div className="locker-actions">
        {canOperate ? (
          <button type="button" onClick={() => openLockerFromStore(locker.locker)}>Otwórz</button>
        ) : null}
        <button className="secondary-button" type="button" onClick={() => openLockerDetailsFromStore(locker)}>Szczegóły</button>
      </div>
    </article>
  );
}

function LockerMapCard() {
  const { lockers } = useLockers();
  const { canOperateLockers } = useUiShell();

  return (
    <div className="card locker-map-card">
      <div className="section-header">
        <div className="section-copy">
          <h2 className="card-title">Mapa fizyczna skrytek</h2>
          <p>Kompaktowy regał 3 komór z czytelnym stanem i szybkimi akcjami operatora.</p>
        </div>
        <div className="locker-toolbar">
          <button id="refreshLockersButton" className="secondary-button" type="button" onClick={refreshLockersFromStore}>Odśwież status</button>
          {canOperateLockers ? (
            <button id="releaseAllLockersButton" className="danger" type="button" data-operation-only onClick={releaseAllLockersFromStore}>
              Zwolnij wszystkie
            </button>
          ) : null}
        </div>
      </div>
      <div id="lockers" className="lockers">
        <div className="lockers-rack">
          {lockers.map(locker => (
            <LockerChamber key={locker.locker} locker={locker} canOperate={canOperateLockers} />
          ))}
        </div>
      </div>
    </div>
  );
}

function AlertsCard() {
  const { alerts } = useAlerts();

  return (
    <div className="card alerts-card">
      <div className="section-header">
        <div className="section-copy">
          <h2 className="card-title">Alerty operacyjne</h2>
          <p>Priorytetowe sygnały, które warto sprawdzić przed codzienną obsługą systemu.</p>
        </div>
        <span id="alertsCount" className="panel-counter">{alerts.length}</span>
      </div>
      <div id="alertsList" className="alerts-list">
        {alerts.length === 0 ? (
          <div className="alert-item is-info">
            <strong>System wygląda zdrowo</strong>
            <span>Nie ma teraz alertów wymagających reakcji.</span>
          </div>
        ) : alerts.map((alert, index) => (
          <article className={`alert-item is-${alert.severity || "info"}`} key={alert.id || `${alert.title}-${index}`}>
            <strong>{alert.title}</strong>
            <span>{alert.detail}</span>
            <small>{alert.action}</small>
          </article>
        ))}
      </div>
    </div>
  );
}

function StatusSummaryCard() {
  const systemStatus = useSystemStatus();
  const model = getSystemStatusModel(systemStatus);

  return (
    <div className="card status-summary-card">
      <div className="section-copy">
        <h2 className="card-title">Stan systemu</h2>
        <p>Najważniejsze sygnały techniczne i szybki ogląd gotowości całej platformy.</p>
      </div>
      <div className="status-summary-grid">
        <StatusSummaryTile label="API" valueId="summaryServerState" metaId="summaryServerMeta" status={model.summary.server} />
        <StatusSummaryTile label="Baza danych" valueId="summaryDatabaseState" metaId="summaryDatabaseMeta" status={model.summary.database} />
        <StatusSummaryTile label="Urządzenie" valueId="summaryDeviceState" metaId="summaryDeviceMeta" status={model.summary.device} />
        <StatusSummaryTile label="Ostatni kontakt" valueId="summaryHeartbeat" metaId="summaryHeartbeatMeta" status={model.summary.heartbeat} accent />
      </div>
    </div>
  );
}

function formatTimeLeft(expiresAt, now) {
  const msLeft = new Date(expiresAt).getTime() - now;

  if (Number.isNaN(msLeft) || msLeft <= 0) {
    return "Kod wygasł";
  }

  const totalSeconds = Math.floor(msLeft / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  return `Wygasa za ${hours}h ${minutes}m ${seconds}s`;
}

function EmailDeliveryChip({ codeData }) {
  if (!codeData.recipientEmail) {
    return <span className="active-code-note">Kod dostępny tylko w panelu operatora</span>;
  }

  const failedDelivery = Boolean(codeData.emailDeliveryAttempted && !codeData.emailSentAt);

  return (
    <span className={`code-chip ${failedDelivery ? "is-warning" : "is-success"}`} title={codeData.emailDeliveryError || undefined}>
      {failedDelivery ? `E-mail: błąd · ${codeData.recipientEmail}` : `E-mail wysłany · ${codeData.recipientEmail}`}
    </span>
  );
}

function ActiveCodeItem({ codeData, canOperate, now }) {
  return (
    <li id={`code-${codeData.code}`} className="active-code-item">
      <div className="active-code-layout">
        <div className="active-code-content">
          <div className="active-code-header">
            <span className="code-chip">{codeData.code}</span>
            <span className="active-code-locker">Skrytka S{codeData.locker}</span>
          </div>
          <div className="active-code-detail">
            <EmailDeliveryChip codeData={codeData} />
          </div>
          <div className="active-code-footer">
            <span className="timer">{formatTimeLeft(codeData.expiresAt, now)}</span>
            <div className="code-actions">
              <button className="secondary-button code-copy-button" type="button" onClick={() => copyActiveCode(codeData.code)}>Kopiuj</button>
              {canOperate ? (
                <button className="danger" type="button" onClick={() => deactivateActiveCode(codeData.code)}>Wyłącz</button>
              ) : null}
            </div>
          </div>
        </div>
      </div>
    </li>
  );
}

function ActiveCodesCard() {
  const { activeCodes } = useActiveCodes();
  const [now, setNow] = useState(() => Date.now());
  const { canOperateLockers } = useUiShell();

  useEffect(() => {
    const intervalId = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(intervalId);
  }, []);

  useEffect(() => {
    pruneExpiredActiveCodes(now);
  }, [now]);

  const visibleCodes = useMemo(
    () => activeCodes.filter(code => new Date(code.expiresAt).getTime() > now),
    [activeCodes, now]
  );

  return (
    <div className="card compact-card">
      <div className="section-header">
        <div className="section-copy">
          <h2 className="card-title">Aktywne kody</h2>
          <p>Trwające dostępy z odliczaniem i szybką dezaktywacją.</p>
        </div>
        <span id="activeCodesCount" className="panel-counter">{visibleCodes.length}</span>
      </div>
      <ul id="activeCodes" className="stack-list">
        {visibleCodes.length === 0 ? (
          <li className="empty-state">
            <strong>Brak danych</strong>
            <p>Brak aktywnych kodów.</p>
          </li>
        ) : visibleCodes.map(code => (
          <ActiveCodeItem key={code.code} codeData={code} canOperate={canOperateLockers} now={now} />
        ))}
      </ul>
    </div>
  );
}

function formatRelativeTime(value, now = Date.now()) {
  if (!value) {
    return "brak danych";
  }

  const diffMs = now - new Date(value).getTime();
  if (Number.isNaN(diffMs) || diffMs < 0) {
    return "przed chwilą";
  }

  const seconds = Math.floor(diffMs / 1000);
  if (seconds < 5) {
    return "przed chwilą";
  }

  if (seconds < 60) {
    return `${seconds} s temu`;
  }

  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    return `${minutes} min temu`;
  }

  const hours = Math.floor(minutes / 60);
  return `${hours} godz. temu`;
}

function getRemoteActionTypeLabel(action) {
  if (action.type === "OPEN_LOCKER") {
    return action.locker ? `Otwórz S${action.locker}` : "Otwórz skrytkę";
  }

  if (action.type === "RELEASE_ALL_LOCKERS") {
    return "Zwolnij wszystkie";
  }

  if (action.type === "ASSIGN_RFID_TAG") {
    return "Nadaj tag RFID";
  }

  if (action.type === "CANCEL_RFID_TAG_ASSIGNMENT") {
    return "Anuluj nadawanie RFID";
  }

  return action.type || "Polecenie";
}

function getRemoteActionStatusLabel(status) {
  if (status === "pending") return "Oczekuje";
  if (status === "delivered") return "Dostarczone";
  if (status === "queued") return "W kolejce";
  if (status === "sent") return "Wysłane";
  if (status === "acknowledged") return "Potwierdzone";
  if (status === "applied") return "Wykonane";
  if (status === "failed") return "Błąd";
  return "Nieznany";
}

function RemoteActionsCard() {
  const { remoteActions } = useRemoteActions();
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const intervalId = setInterval(() => setNow(Date.now()), 30000);
    return () => clearInterval(intervalId);
  }, []);

  return (
    <div className="card remote-actions-card">
      <div className="section-header">
        <div className="section-copy">
          <h2 className="card-title">Polecenia do ESP32</h2>
          <p>Kolejka i potwierdzenia ostatnich akcji wysłanych z panelu do urządzenia.</p>
        </div>
        <div className="section-actions">
          <span id="remoteActionsCount" className="panel-counter">{remoteActions.length}</span>
          <button id="refreshRemoteActionsButton" className="secondary-button" type="button" onClick={refreshRemoteActions}>Odśwież</button>
        </div>
      </div>
      <div id="remoteActionsList" className="remote-actions-list">
        {remoteActions.length === 0 ? (
          <div className="empty-state">
            <strong>Brak danych</strong>
            <p>Nie wysłano jeszcze żadnych poleceń do urządzenia.</p>
          </div>
        ) : remoteActions.slice(0, 8).map(action => (
          <article className={`remote-action-item is-${action.status || "queued"}`} key={action._id || action.id || `${action.type}-${action.createdAt}`}>
            <div className="remote-action-main">
              <strong>{getRemoteActionTypeLabel(action)}</strong>
              <span>{formatRelativeTime(action.createdAt, now)}{action.actor ? ` · ${action.actor}` : ""}</span>
            </div>
            <span className="remote-action-status">{getRemoteActionStatusLabel(action.status)}</span>
          </article>
        ))}
      </div>
    </div>
  );
}

function getLogItemTypeLabel(itemType) {
  const labels = {
    brelok: "Brelok",
    karta: "Karta",
    inne: "Inne",
    klucz_master: "Klucz master",
    karta_master: "Karta master"
  };

  return labels[itemType] || "Inne";
}

function formatLogItemLabel(log) {
  if (log.itemKnown && log.itemName) {
    const typeLabel = log.itemType ? getLogItemTypeLabel(log.itemType).toLowerCase() : "przedmiot";
    return ` · ${typeLabel}: ${log.itemName}`;
  }

  if (log.tagId) {
    return ` · obcy obiekt: ${log.tagId}`;
  }

  return "";
}

const LOG_EVENT_PRESENTERS = {
  LOCKER_OPENED: log => ({ text: `Odblokowano S${log.locker} kod ${log.code}`, className: "log-success" }),
  INVALID_CODE: log => ({ text: `Błędny kod ${log.code}`, className: "log-error" }),
  CODE_GENERATED: log => ({ text: `Wygenerowano kod ${log.code}`, className: "log-info" }),
  CODE_EMAIL_SENT: log => ({ text: `Wysłano kod ${log.code} na ${log.recipientEmail || "e-mail"}`, className: "log-success" }),
  CODE_EMAIL_FAILED: log => ({ text: `Błąd wysyłki kodu ${log.code}${log.recipientEmail ? ` na ${log.recipientEmail}` : ""}`, className: "log-error" }),
  CODE_DEACTIVATED: log => ({ text: `Dezaktywowano kod ${log.code}`, className: "log-warning" }),
  KEY_REMOVED: log => ({ text: `Wyjęty klucz S${log.locker}${formatLogItemLabel(log)}`, className: "log-warning" }),
  KEY_RETURNED: log => ({ text: `Zwrócony klucz S${log.locker}${formatLogItemLabel(log)}`, className: "log-success" }),
  LOCKER_DOOR_OPENED: log => ({ text: `Otwarte drzwiczki S${log.locker}`, className: "log-warning" }),
  LOCKER_DOOR_CLOSED: log => ({ text: `Domknięte drzwiczki S${log.locker}`, className: "log-success" }),
  REMOTE_UNLOCK_REQUESTED: log => ({ text: `Zdalne otwarcie S${log.locker}`, className: "log-info" }),
  REMOTE_RELEASE_ALL_REQUESTED: () => ({ text: "Zwolniono blokadę wszystkich skrytek", className: "log-warning" }),
  DEVICE_OFFLINE_STATE_RECOVERED: log => ({ text: `Przywrócono stan po pracy offline urządzenia${log.details?.changeCount ? ` · zmian: ${log.details.changeCount}` : ""}`, className: "log-warning" }),
  RFID_ACCESS_GRANTED: log => ({ text: `Autoryzowany tag RFID${formatLogItemLabel(log)}`, className: "log-success" }),
  RFID_ACCESS_DENIED: log => ({ text: `Odrzucony tag RFID${formatLogItemLabel(log)}`, className: "log-error" }),
  RFID_USER_CREATED: () => ({ text: "Dodano użytkownika RFID", className: "log-info" }),
  RFID_USER_UPDATED: () => ({ text: "Zaktualizowano użytkownika RFID", className: "log-info" }),
  RFID_USER_DELETED: () => ({ text: "Usunięto użytkownika RFID", className: "log-warning" }),
  RFID_ITEM_CREATED: () => ({ text: "Dodano przedmiot RFID", className: "log-info" }),
  RFID_ITEM_UPDATED: () => ({ text: "Zaktualizowano przedmiot RFID", className: "log-info" }),
  RFID_ITEM_DELETED: () => ({ text: "Usunięto przedmiot RFID", className: "log-warning" }),
  PANEL_USER_CREATED: () => ({ text: "Dodano użytkownika panelu", className: "log-info" }),
  PANEL_USER_UPDATED: () => ({ text: "Zaktualizowano użytkownika panelu", className: "log-info" }),
  PANEL_USER_DELETED: () => ({ text: "Usunięto użytkownika panelu", className: "log-warning" }),
  AUTH_LOGIN: () => ({ text: "Zalogowano operatora", className: "log-success" }),
  AUTH_LOGOUT: () => ({ text: "Wylogowano operatora", className: "log-info" }),
  RFID_TAG_ASSIGNMENT_STARTED: log => ({ text: `Rozpoczęto nadawanie taga RFID${log.itemName ? ` dla ${log.itemName}` : ""}`, className: "log-info" }),
  RFID_TAG_ASSIGNMENT_COMPLETED: log => ({ text: `Nadano tag RFID${formatLogItemLabel(log)}`, className: "log-success" }),
  RFID_TAG_ASSIGNMENT_FAILED: () => ({ text: "Nie udało się nadać taga RFID", className: "log-error" }),
  RFID_TAG_ASSIGNMENT_CANCELLED: log => ({ text: `Anulowano nadawanie taga RFID${log.itemName ? ` dla ${log.itemName}` : ""}`, className: "log-warning" })
};

function getLogPresentation(log) {
  const presenter = LOG_EVENT_PRESENTERS[log.event];
  if (presenter) {
    return presenter(log);
  }

  return {
    text: log.event || "Zdarzenie systemowe",
    className: "log-info"
  };
}

function formatLogTimestamp(value) {
  return value ? new Date(value).toLocaleString() : "brak daty";
}

function LogItem({ log }) {
  const { text, className } = getLogPresentation(log);

  return (
    <li className={className}>
      <div className="log-entry">
        <span className="log-entry-text">{formatLogTimestamp(log.timestamp)} | {text}</span>
        <button
          type="button"
          className="log-details-trigger"
          title="Pokaż szczegóły logu"
          aria-label="Pokaż szczegóły logu"
          onClick={() => openLogDetailsFromStore(log, text)}
        >
          i
        </button>
      </div>
    </li>
  );
}

function LogsCard() {
  const { filters, logEvents, logs } = useLogs();
  const { canManageRfid } = useUiShell();
  const skipInitialFilterRefresh = useRef(true);

  useEffect(() => {
    if (skipInitialFilterRefresh.current) {
      skipInitialFilterRefresh.current = false;
      return undefined;
    }

    const timeoutId = setTimeout(refreshLogs, 250);
    return () => clearTimeout(timeoutId);
  }, [filters.event, filters.locker, filters.q]);

  function handleFilterChange(event) {
    setLogFilter(event.target.name, event.target.value);
  }

  function handleResetFilters() {
    resetLogFilters();
    refreshLogs();
  }

  return (
    <div className="card logs dashboard-logs" data-advanced-only="true">
      <div className="section-header">
        <div className="section-copy">
          <h2>Logi systemowe</h2>
          <p>Zdarzenia i operacje na żywo, zsynchronizowane w czasie rzeczywistym.</p>
        </div>
        <div className="section-actions">
          <span id="logsCount" className="panel-counter">{logs.length}</span>
          <button id="exportLogsButton" className="secondary-button" type="button" onClick={exportLogsFromStore}>Eksport CSV</button>
          {canManageRfid ? (
            <button id="clearLogsButton" className="danger" type="button" data-rfid-admin-only onClick={clearLogsFromStore}>Wyczyść logi</button>
          ) : null}
        </div>
      </div>
      <div className="log-filters">
        <label className="field mini-field">
          <span className="field-label">Typ zdarzenia</span>
          <select id="logEventFilter" name="event" value={filters.event} onChange={handleFilterChange}>
            <option value="">Wszystkie</option>
            {logEvents.map(eventName => (
              <option value={eventName} key={eventName}>{eventName}</option>
            ))}
          </select>
        </label>
        <label className="field mini-field">
          <span className="field-label">Skrytka</span>
          <select id="logLockerFilter" name="locker" value={filters.locker} onChange={handleFilterChange}>
            <option value="">Wszystkie</option>
            <option value="1">Skrytka 1</option>
            <option value="2">Skrytka 2</option>
            <option value="3">Skrytka 3</option>
          </select>
        </label>
        <label className="field mini-field search-field">
          <span className="field-label">Szukaj</span>
          <input id="logSearchInput" name="q" type="search" value={filters.q} onChange={handleFilterChange} placeholder="kod, tag, operator..." />
        </label>
        <button id="logFilterReset" className="secondary-button" type="button" onClick={handleResetFilters}>Reset</button>
      </div>
      <ul id="logs" className="stack-list">
        {logs.length === 0 ? (
          <li className="empty-state">
            <strong>Brak danych</strong>
            <p>Brak logów do wyświetlenia.</p>
          </li>
        ) : logs.map((log, index) => (
          <LogItem key={log._id || log.id || `${log.timestamp}-${log.event}-${index}`} log={log} />
        ))}
      </ul>
    </div>
  );
}

export function DashboardPage() {
  const { activePage } = useUiShell();

  return (
    <section id="dashboardPage" className={`page${activePage === "dashboard" ? " active" : ""}`}>
      <div className="dashboard">
        <div className="dashboard-main">
          <HeroCard />
          <LockerMapCard />
        </div>

        <aside className="dashboard-side" data-advanced-only="true">
          <AlertsCard />
          <StatusSummaryCard />
          <ActiveCodesCard />
          <RemoteActionsCard />
        </aside>

        <LogsCard />
      </div>
    </section>
  );
}
