import {
  closeLockerDetailsFromStore,
  openLockerFromStore,
  refreshLockerDetailsFromStore,
  useLockers
} from "../state/lockersStore.js";
import { openLogDetailsFromStore } from "../state/logsStore.js";
import { useUiShell } from "../state/uiShellStore.js";

const RFID_ITEM_TYPE_LABELS = {
  brelok: "Brelok",
  karta: "Karta",
  inne: "Inne",
  klucz_master: "Klucz master",
  karta_master: "Karta master"
};

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
  RFID_TAG_ASSIGNMENT_STARTED: log => ({ text: `Rozpoczęto nadawanie taga RFID${log.itemName ? ` dla ${log.itemName}` : ""}`, className: "log-info" }),
  RFID_TAG_ASSIGNMENT_COMPLETED: log => ({ text: `Nadano tag RFID${formatLogItemLabel(log)}`, className: "log-success" }),
  RFID_TAG_ASSIGNMENT_FAILED: () => ({ text: "Nie udało się nadać taga RFID", className: "log-error" }),
  RFID_TAG_ASSIGNMENT_CANCELLED: log => ({ text: `Anulowano nadawanie taga RFID${log.itemName ? ` dla ${log.itemName}` : ""}`, className: "log-warning" })
};

function getItemTypeLabel(itemType) {
  return RFID_ITEM_TYPE_LABELS[itemType] || "Inne";
}

function formatLogItemLabel(log) {
  if (log.itemKnown && log.itemName) {
    const typeLabel = log.itemType ? getItemTypeLabel(log.itemType).toLowerCase() : "przedmiot";
    return ` · ${typeLabel}: ${log.itemName}`;
  }

  if (log.tagId) {
    return ` · obcy obiekt: ${log.tagId}`;
  }

  return "";
}

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

function describeDetectedItem(data) {
  if (!data?.hasTag) {
    return {
      title: "Brak przedmiotu",
      meta: "Czytnik RFID nie wykrywa teraz żadnego taga w skrytce."
    };
  }

  if (data.detectedItemKnown && data.detectedItemName) {
    const itemType = data.detectedItemType ? getItemTypeLabel(data.detectedItemType) : "Przedmiot RFID";
    return {
      title: `${itemType}: ${data.detectedItemName}`,
      meta: `UID ${data.detectedTagId || "brak danych"}`
    };
  }

  if (data.detectedTagId) {
    return {
      title: `Obcy obiekt: ${data.detectedTagId}`,
      meta: "Tag nie znajduje się na liście zdefiniowanych przedmiotów RFID."
    };
  }

  return {
    title: "Przedmiot RFID obecny",
    meta: "System nie otrzymał jeszcze UID tego przedmiotu."
  };
}

function LockerDetailTile({ label, state, value }) {
  return (
    <article className={`locker-detail-tile state-${state}`}>
      <span>{label}</span>
      <strong>{value}</strong>
    </article>
  );
}

function LockerHistoryItem({ log }) {
  const presentation = getLogPresentation(log);

  return (
    <button
      type="button"
      className={`locker-history-item ${presentation.className}`}
      onClick={() => openLogDetailsFromStore(log, presentation.text)}
    >
      <strong>{presentation.text}</strong>
      <span>{log.timestamp ? new Date(log.timestamp).toLocaleString("pl-PL") : "brak daty"}</span>
    </button>
  );
}

export function LockerDetailsOverlay() {
  const { lockerDetails } = useLockers();
  const { canOperateLockers } = useUiShell();
  const locker = lockerDetails.locker;
  const detectedItem = describeDetectedItem(locker);
  const summary = locker
    ? [
      locker.hasTag ? "Klucz jest wykryty" : "Brak wykrytego klucza",
      locker.isDoorClosed ? "drzwiczki są zamknięte" : "drzwiczki są otwarte"
    ].join(", ")
    : "Aktualny stan komory i ostatnie zdarzenia.";

  return (
    <div
      id="lockerDetailsOverlay"
      className={`confirm-overlay${lockerDetails.open ? "" : " hidden"}`}
      role="dialog"
      aria-modal="true"
      aria-labelledby="lockerDetailsTitle"
      onClick={event => {
        if (event.target.id === "lockerDetailsOverlay") {
          closeLockerDetailsFromStore();
        }
      }}
    >
      <div className="confirm-dialog locker-details-dialog">
        <span className="eyebrow">Szczegóły skrytki</span>
        <h2 id="lockerDetailsTitle">{locker ? `Skrytka S${locker.locker}` : "Skrytka"}</h2>
        <p id="lockerDetailsSummary">{summary}</p>
        <div id="lockerDetailsStatus" className="locker-details-status">
          {locker ? (
            <>
              <LockerDetailTile label="Stan" value={getLockerSeverityLabel(locker)} state={getLockerSeverity(locker)} />
              <LockerDetailTile label="Klucz" value={locker.hasTag ? "Obecny" : "Brak"} state={locker.hasTag ? "ok" : "critical"} />
              <LockerDetailTile label="Drzwi" value={locker.isDoorClosed ? "Zamknięte" : "Otwarte"} state={locker.isDoorClosed ? "ok" : "warn"} />
            </>
          ) : null}
        </div>
        <div id="lockerDetailsItem" className="locker-details-item">
          <strong>{detectedItem.title}</strong>
          <span>{detectedItem.meta}</span>
        </div>
        <div className="locker-details-history">
          <div className="locker-details-history-header">
            <strong>Ostatnie zdarzenia</strong>
            <button id="lockerDetailsRefresh" className="secondary-button" type="button" onClick={refreshLockerDetailsFromStore}>Odśwież</button>
          </div>
          <div id="lockerDetailsLogs" className="locker-details-logs">
            {lockerDetails.loading ? (
              <div className="empty-state compact-empty">
                <strong>Ładowanie</strong>
                <p>Pobieram ostatnie zdarzenia skrytki.</p>
              </div>
            ) : lockerDetails.error ? (
              <div className="empty-state compact-empty">
                <strong>Nie udało się pobrać logów</strong>
                <p>{lockerDetails.error}</p>
              </div>
            ) : lockerDetails.recentLogs.length === 0 ? (
              <div className="empty-state compact-empty">
                <strong>Brak historii</strong>
                <p>Nie ma jeszcze logów dla tej skrytki.</p>
              </div>
            ) : lockerDetails.recentLogs.map(log => (
              <LockerHistoryItem key={log._id || log.id || `${log.timestamp}-${log.event}`} log={log} />
            ))}
          </div>
        </div>
        <div className="confirm-actions">
          {canOperateLockers && locker ? (
            <button id="lockerDetailsOpen" type="button" data-operation-only onClick={async () => {
              await openLockerFromStore(locker.locker);
              await refreshLockerDetailsFromStore();
            }}
            >
              Otwórz skrytkę
            </button>
          ) : null}
          <button id="lockerDetailsClose" className="secondary-button" type="button" onClick={closeLockerDetailsFromStore}>Zamknij</button>
        </div>
      </div>
    </div>
  );
}
