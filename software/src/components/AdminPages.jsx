import { useUiShell } from "../state/uiShellStore.js";

function SnapshotCard({ label, valueId, help }) {
  return (
    <article className="snapshot-card">
      <span className="snapshot-label">{label}</span>
      <strong id={valueId} className="snapshot-value">0</strong>
      <small className="snapshot-help">{help}</small>
    </article>
  );
}

function SectionCopy({ title, children, cardTitle = false }) {
  return (
    <div className="section-copy">
      <h2 className={cardTitle ? "card-title" : undefined}>{title}</h2>
      <p>{children}</p>
    </div>
  );
}

function SearchField({ id, label, placeholder }) {
  return (
    <label className="field mini-field search-field">
      <span className="field-label">{label}</span>
      <input id={id} type="search" placeholder={placeholder} />
    </label>
  );
}

function RfidUsersPage({ activePage }) {
  return (
    <section id="usersPage" className={`page${activePage === "users" ? " active" : ""}`}>
      <div className="users-layout">
        <div className="users-sidebar">
          <div className="card form-card">
            <SectionCopy title="Użytkownicy RFID" cardTitle>
              Dodawaj osoby, przypisuj ich tagi RFID i wskazuj, które skrytki mogą otwierać po przyłożeniu karty.
            </SectionCopy>

            <form id="rfidUserForm" className="auth-form" data-rfid-admin-only>
              <input id="rfidUserId" type="hidden" />

              <label className="field">
                <span className="field-label">Nazwa użytkownika</span>
                <input id="rfidUserName" type="text" placeholder="np. Jan Kowalski" required />
              </label>

              <label className="field">
                <span className="field-label">ID taga RFID</span>
                <input id="rfidUserTagId" type="text" placeholder="np. 04A1B2C3D4" required />
              </label>

              <div className="field">
                <span className="field-label">Skrytki z dostępem</span>
                <div className="checkbox-grid">
                  <label className="checkbox-card"><input type="checkbox" name="allowedLocker" value="1" /> <span>Skrytka 1</span></label>
                  <label className="checkbox-card"><input type="checkbox" name="allowedLocker" value="2" /> <span>Skrytka 2</span></label>
                  <label className="checkbox-card"><input type="checkbox" name="allowedLocker" value="3" /> <span>Skrytka 3</span></label>
                </div>
              </div>

              <button id="rfidUserSubmit" type="submit">Dodaj użytkownika</button>
              <button id="rfidUserReset" className="secondary-button" type="button">Wyczyść formularz</button>
            </form>
            <p className="field-help hidden" data-rfid-readonly-note>
              Masz dostęp do podglądu. Dodawanie i edycja użytkowników RFID są dostępne dla ról master i administrator.
            </p>
          </div>
        </div>

        <div className="users-main">
          <div className="section-snapshot">
            <SnapshotCard label="Użytkownicy" valueId="rfidUsersSnapshotCount" help="Konta RFID w systemie" />
            <SnapshotCard label="Dostęp" valueId="rfidUsersSnapshotAccess" help="Łączne przypisania do skrytek" />
          </div>
          <div className="card">
            <div className="section-header">
              <SectionCopy title="Lista użytkowników">
                Przeglądaj i edytuj przypisania kart RFID do skrytek oraz przygotuj konfigurację pod czytnik użytkownika.
              </SectionCopy>
              <div className="section-actions">
                <span id="rfidUsersCount" className="panel-counter">0</span>
                <button id="refreshRfidUsersButton" className="secondary-button" type="button">Odśwież listę</button>
              </div>
            </div>
            <div className="list-toolbar">
              <SearchField id="rfidUsersSearch" label="Szukaj użytkownika" placeholder="nazwa, tag, skrytka..." />
            </div>
            <div id="rfidUsersList" className="users-list" />
          </div>
        </div>
      </div>
    </section>
  );
}

function RfidItemsPage({ activePage }) {
  return (
    <section id="itemsPage" className={`page${activePage === "items" ? " active" : ""}`}>
      <div className="users-layout">
        <div className="users-sidebar">
          <div className="card form-card">
            <SectionCopy title="Przedmioty RFID" cardTitle>
              Dodawaj własne przedmioty rozpoznawane po UID taga RFID. System pokaże ich nazwę i typ w logach oraz w statusie skrytek.
            </SectionCopy>

            <form id="rfidItemForm" className="auth-form" data-rfid-admin-only>
              <input id="rfidItemId" type="hidden" />

              <label className="field">
                <span className="field-label">Nazwa przedmiotu</span>
                <input id="rfidItemName" type="text" placeholder="np. Klucz do magazynu" required />
              </label>

              <label className="field">
                <span className="field-label">UID taga RFID</span>
                <div className="inline-field">
                  <input id="rfidItemTagId" type="text" placeholder="np. 04A1B2C3D4" required />
                  <button id="assignRfidTagButton" className="secondary-button" type="button">Nadaj tag</button>
                </div>
                <small id="rfidAssignmentStatus" className="field-help">
                  Możesz wpisać ID ręcznie albo uruchomić nadawanie na master readerze.
                </small>
              </label>

              <label className="field">
                <span className="field-label">Typ</span>
                <select id="rfidItemType" required>
                  <option value="brelok">Brelok</option>
                  <option value="karta">Karta</option>
                  <option value="inne">Inne</option>
                  <option value="klucz_master" data-master-option>Klucz master</option>
                  <option value="karta_master" data-master-option>Karta master</option>
                </select>
              </label>

              <button id="rfidItemSubmit" type="submit">Dodaj przedmiot</button>
              <button id="rfidItemReset" className="secondary-button" type="button">Wyczyść formularz</button>
            </form>
            <p className="field-help hidden" data-rfid-readonly-note>
              Masz dostęp do podglądu. Dodawanie zwykłych przedmiotów RFID wymaga roli administrator, a tagów master roli master.
            </p>
          </div>
        </div>

        <div className="users-main">
          <div className="section-snapshot">
            <SnapshotCard label="Przedmioty" valueId="rfidItemsSnapshotCount" help="Własne obiekty RFID" />
            <SnapshotCard label="Typy" valueId="rfidItemsSnapshotTypes" help="Aktywne kategorie" />
          </div>
          <div className="card">
            <div className="section-header">
              <SectionCopy title="Lista przedmiotów">
                Tu zarządzasz mapowaniem UID tagów na czytelne nazwy i typy przedmiotów.
              </SectionCopy>
              <div className="section-actions">
                <span id="rfidItemsCount" className="panel-counter">0</span>
                <button id="refreshRfidItemsButton" className="secondary-button" type="button">Odśwież listę</button>
              </div>
            </div>
            <div className="list-toolbar">
              <SearchField id="rfidItemsSearch" label="Szukaj przedmiotu" placeholder="nazwa, UID, typ..." />
            </div>
            <div id="rfidItemsList" className="users-list" />
          </div>
        </div>
      </div>
    </section>
  );
}

function PanelUsersPage({ activePage }) {
  return (
    <section id="panelUsersPage" className={`page${activePage === "panelUsers" ? " active" : ""}`}>
      <div className="users-layout">
        <div className="users-sidebar">
          <div className="card form-card">
            <SectionCopy title="Użytkownicy panelu" cardTitle>
              Tylko użytkownik master może dodawać, usuwać i edytować konta oraz role dostępu do panelu.
            </SectionCopy>

            <form id="panelUserForm" className="auth-form">
              <input id="panelUserId" type="hidden" />

              <label className="field">
                <span className="field-label">Nazwa wyświetlana</span>
                <input id="panelUserDisplayName" type="text" placeholder="np. Jan Kowalski" required />
              </label>

              <label className="field">
                <span className="field-label">Login</span>
                <input id="panelUserUsername" type="text" placeholder="np. admin" required />
              </label>

              <label className="field">
                <span className="field-label">Hasło</span>
                <input id="panelUserPassword" type="password" placeholder="Minimum 6 znaków" />
                <small className="field-help">Przy edycji zostaw puste, jeśli hasło ma pozostać bez zmian.</small>
              </label>

              <label className="field">
                <span className="field-label">Rola</span>
                <select id="panelUserRole" required>
                  <option value="master">Master</option>
                  <option value="admin">Administrator</option>
                  <option value="operator">Operator</option>
                  <option value="viewer">Podgląd</option>
                </select>
              </label>

              <button id="panelUserSubmit" type="submit">Dodaj użytkownika</button>
              <button id="panelUserReset" className="secondary-button" type="button">Wyczyść formularz</button>
            </form>
          </div>
        </div>

        <div className="users-main">
          <div className="section-snapshot">
            <SnapshotCard label="Konta panelu" valueId="panelUsersSnapshotCount" help="Wszyscy operatorzy" />
            <SnapshotCard label="Master" valueId="panelUsersSnapshotMasters" help="Uprawnienia najwyższe" />
          </div>
          <div className="card">
            <div className="section-header">
              <SectionCopy title="Lista kont panelu">
                Konta są teraz trzymane poza zmiennymi środowiskowymi i można nimi zarządzać z poziomu panelu.
              </SectionCopy>
              <div className="section-actions">
                <span id="panelUsersCount" className="panel-counter">0</span>
                <button id="backupExportButton" className="secondary-button" type="button">Backup JSON</button>
                <button id="refreshPanelUsersButton" className="secondary-button" type="button">Odśwież listę</button>
              </div>
            </div>
            <div className="list-toolbar">
              <SearchField id="panelUsersSearch" label="Szukaj konta" placeholder="nazwa, login, rola..." />
            </div>
            <div id="panelUsersList" className="users-list" />
          </div>
        </div>
      </div>
    </section>
  );
}

export function AdminPages() {
  const { activePage } = useUiShell();

  return (
    <>
      <RfidUsersPage activePage={activePage} />
      <RfidItemsPage activePage={activePage} />
      <PanelUsersPage activePage={activePage} />
    </>
  );
}
