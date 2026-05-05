import { useEffect, useMemo, useState } from "react";
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
  refreshLockers,
  releaseAllLockersFromStore,
  useLockers
} from "../state/lockersStore.js";
import {
  refreshRemoteActions,
  useRemoteActions
} from "../state/remoteActionsStore.js";
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

function StatusSummaryTile({ label, valueId, metaId, initialValue, meta, accent = false }) {
  return (
    <article className={`status-summary-tile${accent ? " accent" : ""}`}>
      <span className="status-summary-label">{label}</span>
      <strong id={valueId} className="status-summary-value">{initialValue}</strong>
      <small id={metaId} className="status-summary-meta">{meta}</small>
    </article>
  );
}

function HeroCard() {
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
          <select id="locker">
            <option value="1">Skrytka 1</option>
            <option value="2">Skrytka 2</option>
            <option value="3">Skrytka 3</option>
          </select>
        </label>

        <label className="field">
          <span className="field-label">Czas aktywności</span>
          <select id="hours">
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
          <button id="generateButton" type="button" data-operation-only>Generuj</button>
        </label>
      </div>

      <label className="field email-field" data-advanced-only="true">
        <span className="field-label">Wyślij kod na e-mail</span>
        <input id="recipientEmail" type="email" inputMode="email" autoComplete="email" placeholder="np. operator@firma.pl" />
        <small className="field-help">
          Opcjonalnie. Jeśli podasz adres, SafeKeys spróbuje wysłać kod automatycznie zaraz po wygenerowaniu.
        </small>
      </label>

      <div className="generated-output">
        <div className="generated-output-header">
          <small>Ostatnio wygenerowany kod</small>
          <button id="copyGeneratedCodeButton" className="inline-copy-button hidden" type="button">Kopiuj</button>
          <span id="generatedDeliveryStatus" className="delivery-status hidden" />
        </div>
        <h3 id="generatedCode" className="generated-code">----</h3>
        <p id="generatedCodeMeta" className="generated-meta">
          Kod pojawi się tutaj po wygenerowaniu. Możesz go zostawić tylko w panelu albo od razu wysłać na e-mail.
        </p>
      </div>

      <div className="hero-metrics">
        <ReadyLockersMetricCard />
        <ActiveCodesMetricCard />
        <MetricCard label="Użytkownicy RFID" valueId="metricRfidUsers" initialValue="0" help="Przypisane osoby" />
        <MetricCard label="Przedmioty RFID" valueId="metricRfidItems" initialValue="0" help="Zmapowane UID" />
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
          <button id="refreshLockersButton" className="secondary-button" type="button" onClick={refreshLockers}>Odśwież status</button>
          <button id="releaseAllLockersButton" className="danger" type="button" data-operation-only onClick={releaseAllLockersFromStore}>
            Zwolnij wszystkie
          </button>
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
  return (
    <div className="card status-summary-card">
      <div className="section-copy">
        <h2 className="card-title">Stan systemu</h2>
        <p>Najważniejsze sygnały techniczne i szybki ogląd gotowości całej platformy.</p>
      </div>
      <div className="status-summary-grid">
        <StatusSummaryTile label="API" valueId="summaryServerState" metaId="summaryServerMeta" initialValue="Sprawdzanie" meta="Oczekiwanie na odpowiedź" />
        <StatusSummaryTile label="Baza danych" valueId="summaryDatabaseState" metaId="summaryDatabaseMeta" initialValue="Sprawdzanie" meta="Oczekiwanie na status" />
        <StatusSummaryTile label="Urządzenie" valueId="summaryDeviceState" metaId="summaryDeviceMeta" initialValue="Sprawdzanie" meta="Brak heartbeat" />
        <StatusSummaryTile label="Ostatni kontakt" valueId="summaryHeartbeat" metaId="summaryHeartbeatMeta" initialValue="brak danych" meta="ESP32 / Socket.IO" accent />
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

function LogsCard() {
  return (
    <div className="card logs dashboard-logs" data-advanced-only="true">
      <div className="section-header">
        <div className="section-copy">
          <h2>Logi systemowe</h2>
          <p>Zdarzenia i operacje na żywo, zsynchronizowane w czasie rzeczywistym.</p>
        </div>
        <div className="section-actions">
          <span id="logsCount" className="panel-counter">0</span>
          <button id="exportLogsButton" className="secondary-button" type="button">Eksport CSV</button>
          <button id="clearLogsButton" className="danger" type="button" data-rfid-admin-only>Wyczyść logi</button>
        </div>
      </div>
      <div className="log-filters">
        <label className="field mini-field">
          <span className="field-label">Typ zdarzenia</span>
          <select id="logEventFilter">
            <option value="">Wszystkie</option>
          </select>
        </label>
        <label className="field mini-field">
          <span className="field-label">Skrytka</span>
          <select id="logLockerFilter">
            <option value="">Wszystkie</option>
            <option value="1">Skrytka 1</option>
            <option value="2">Skrytka 2</option>
            <option value="3">Skrytka 3</option>
          </select>
        </label>
        <label className="field mini-field search-field">
          <span className="field-label">Szukaj</span>
          <input id="logSearchInput" type="search" placeholder="kod, tag, operator..." />
        </label>
        <button id="logFilterReset" className="secondary-button" type="button">Reset</button>
      </div>
      <ul id="logs" className="stack-list" />
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
