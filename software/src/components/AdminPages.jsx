import { useUiShell } from "../state/uiShellStore.js";
import {
  deletePanelUserFromStore,
  deleteRfidItemFromStore,
  deleteRfidUserFromStore,
  editPanelUser,
  editRfidItem,
  editRfidUser,
  exportBackupFromStore,
  refreshPanelUsers,
  refreshRfidItems,
  refreshRfidUsers,
  resetPanelUserFormState,
  resetRfidItemFormState,
  resetRfidUserFormState,
  setPanelUserFormField,
  setRfidItemFormField,
  setAdminListFilter,
  setRfidUserFormField,
  submitPanelUserFormFromStore,
  submitRfidItemFormFromStore,
  submitRfidUserFormFromStore,
  toggleRfidUserLocker,
  useAdminLists
} from "../state/adminListsStore.js";
import {
  getRfidAssignmentViewModel,
  handleRfidAssignmentButtonFromStore,
  useRfidAssignment
} from "../state/rfidAssignmentStore.js";

const RFID_ITEM_TYPE_LABELS = {
  brelok: "Brelok",
  karta: "Karta",
  inne: "Inne",
  klucz_master: "Klucz master",
  karta_master: "Karta master"
};

const PANEL_ROLE_LABELS = {
  master: "Master",
  admin: "Administrator",
  operator: "Operator",
  viewer: "Podgląd"
};

function SnapshotCard({ label, valueId, value, help }) {
  return (
    <article className="snapshot-card">
      <span className="snapshot-label">{label}</span>
      <strong id={valueId} className="snapshot-value">{value}</strong>
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

function SearchField({ id, label, name, placeholder, value }) {
  return (
    <label className="field mini-field search-field">
      <span className="field-label">{label}</span>
      <input id={id} type="search" name={name} value={value} onChange={event => setAdminListFilter(name, event.target.value)} placeholder={placeholder} />
    </label>
  );
}

function getAllowedLockers(user) {
  return Array.isArray(user.allowedLockers) ? user.allowedLockers : [];
}

function getItemTypeLabel(itemType) {
  return RFID_ITEM_TYPE_LABELS[itemType] || "Inne";
}

function getPanelRoleLabel(role) {
  return PANEL_ROLE_LABELS[role] || "Podgląd";
}

function isMasterRfidItem(item) {
  return ["klucz_master", "karta_master"].includes(item?.itemType);
}

function matchesSearch(values, query) {
  const normalizedQuery = query.trim().toLowerCase();

  if (!normalizedQuery) {
    return true;
  }

  return values
    .filter(value => value !== null && value !== undefined)
    .some(value => String(value).toLowerCase().includes(normalizedQuery));
}

function EmptyListState({ children }) {
  return (
    <div className="empty-state">
      <strong>Brak danych</strong>
      <p>{children}</p>
    </div>
  );
}

function RfidUserCard({ user, canManage }) {
  const allowedLockers = getAllowedLockers(user);

  return (
    <div className="user-card">
      <div className="user-card-header">
        <div>
          <h3 className="user-card-title">{user.name}</h3>
          <div className="user-tag-chip">Tag RFID: {user.tagId}</div>
        </div>
        <div className="user-card-actions">
          {canManage ? (
            <>
              <button className="secondary-button" type="button" onClick={() => editRfidUser(user)}>Edytuj</button>
              <button className="danger" type="button" onClick={() => deleteRfidUserFromStore(user)}>Usuń</button>
            </>
          ) : null}
        </div>
      </div>
      <div className="user-lockers">
        {allowedLockers.map(locker => (
          <span className="user-locker-chip" key={locker}>S{locker}</span>
        ))}
      </div>
      <p className="user-card-copy">
        {canManage
          ? `Dostęp do ${allowedLockers.length} ${allowedLockers.length === 1 ? "skrytki" : "skrytek"}. UID użytkownika jest gotowe do użycia na czytniku.`
          : `Tryb podglądu. Dostęp do ${allowedLockers.length} ${allowedLockers.length === 1 ? "skrytki" : "skrytek"}.`}
      </p>
    </div>
  );
}

function RfidItemCard({ item, canManage, canManageMaster }) {
  const canEditItem = canManage && (!isMasterRfidItem(item) || canManageMaster);

  return (
    <div className="user-card">
      <div className="user-card-header">
        <div>
          <h3 className="user-card-title">{item.name}</h3>
          <div className="user-tag-chip">UID: {item.tagId}</div>
        </div>
        <div className="user-card-actions">
          {canEditItem ? (
            <>
              <button className="secondary-button" type="button" onClick={() => editRfidItem(item)}>Edytuj</button>
              <button className="danger" type="button" onClick={() => deleteRfidItemFromStore(item)}>Usuń</button>
            </>
          ) : null}
        </div>
      </div>
      <div className="user-lockers">
        <span className={`user-locker-chip${isMasterRfidItem(item) ? " master-rfid-chip" : ""}`}>{getItemTypeLabel(item.itemType)}</span>
      </div>
      <p className="user-card-copy">
        {isMasterRfidItem(item)
          ? (canManageMaster
            ? `Administracyjny tag RFID. Przyłożenie UID ${item.tagId} daje dostęp master do skrytek.`
            : "Administracyjny tag RFID. Szczegóły i edycja są dostępne tylko dla roli master.")
          : (canManage
            ? `Typ: ${getItemTypeLabel(item.itemType)}. UID ${item.tagId} będzie widoczne w logach i statusie skrytek jako znany przedmiot.`
            : `Tryb podglądu. Typ: ${getItemTypeLabel(item.itemType)}, UID: ${item.tagId}.`)}
      </p>
    </div>
  );
}

function PanelUserCard({ currentUsername, user }) {
  const roleDescriptions = {
    master: "Pełny dostęp: konta panelu, konfiguracja RFID, tagi master i operacje na skrytkach.",
    admin: "Dostęp administracyjny: konfiguracja RFID, logi i codzienna obsługa skrytek.",
    operator: "Dostęp operacyjny: generowanie kodów, otwieranie skrytek i dezaktywacja dostępów.",
    viewer: "Tryb podglądu: bez możliwości wykonywania operacji ani zmian konfiguracji."
  };

  return (
    <div className="user-card">
      <div className="user-card-header">
        <div>
          <h3 className="user-card-title">{user.displayName}</h3>
          <div className="user-tag-chip">@{user.username}</div>
        </div>
        <div className="user-card-actions">
          <button className="secondary-button" type="button" onClick={() => editPanelUser(user)}>Edytuj</button>
          <button className="danger" type="button" disabled={currentUsername === user.username} onClick={() => deletePanelUserFromStore(user)}>Usuń</button>
        </div>
      </div>
      <div className="user-lockers">
        <span className="user-locker-chip">{getPanelRoleLabel(user.role)}</span>
      </div>
      <p className="user-card-copy">{roleDescriptions[user.role] || roleDescriptions.viewer}</p>
    </div>
  );
}

function RfidUsersPage({ activePage }) {
  const { filters, forms, rfidUsers } = useAdminLists();
  const { canManageRfid } = useUiShell();
  const rfidUserForm = forms.rfidUser;
  const visibleUsers = rfidUsers.filter(user => matchesSearch([
    user.name,
    user.tagId,
    ...getAllowedLockers(user).map(locker => `s${locker}`),
    ...getAllowedLockers(user).map(locker => `skrytka ${locker}`)
  ], filters.rfidUsers));
  const totalAccessAssignments = rfidUsers.reduce((sum, user) => sum + getAllowedLockers(user).length, 0);

  return (
    <section id="usersPage" className={`page${activePage === "users" ? " active" : ""}`}>
      <div className="users-layout">
        <div className="users-sidebar">
          <div className="card form-card">
            <SectionCopy title="Użytkownicy RFID" cardTitle>
              Dodawaj osoby, przypisuj ich tagi RFID i wskazuj, które skrytki mogą otwierać po przyłożeniu karty.
            </SectionCopy>

            <form id="rfidUserForm" className={`auth-form${canManageRfid ? "" : " hidden"}`} onSubmit={event => {
              event.preventDefault();
              submitRfidUserFormFromStore();
            }}
            >
              <input id="rfidUserId" type="hidden" value={rfidUserForm.id} readOnly />

              <label className="field">
                <span className="field-label">Nazwa użytkownika</span>
                <input
                  id="rfidUserName"
                  type="text"
                  placeholder="np. Jan Kowalski"
                  required
                  value={rfidUserForm.name}
                  onChange={event => setRfidUserFormField("name", event.target.value)}
                />
              </label>

              <label className="field">
                <span className="field-label">ID taga RFID</span>
                <input
                  id="rfidUserTagId"
                  type="text"
                  placeholder="np. 04A1B2C3D4"
                  required
                  value={rfidUserForm.tagId}
                  onChange={event => setRfidUserFormField("tagId", event.target.value)}
                />
              </label>

              <div className="field">
                <span className="field-label">Skrytki z dostępem</span>
                <div className="checkbox-grid">
                  {[1, 2, 3].map(locker => (
                    <label className="checkbox-card" key={locker}>
                      <input
                        type="checkbox"
                        name="allowedLocker"
                        value={locker}
                        checked={rfidUserForm.allowedLockers.includes(locker)}
                        onChange={() => toggleRfidUserLocker(locker)}
                      />
                      <span>Skrytka {locker}</span>
                    </label>
                  ))}
                </div>
              </div>

              <button id="rfidUserSubmit" type="submit" disabled={rfidUserForm.submitting}>
                {rfidUserForm.submitting ? "Zapisywanie..." : rfidUserForm.id ? "Zapisz zmiany" : "Dodaj użytkownika"}
              </button>
              <button id="rfidUserReset" className="secondary-button" type="button" onClick={resetRfidUserFormState}>Wyczyść formularz</button>
            </form>
            <p className={`field-help${canManageRfid ? " hidden" : ""}`}>
              Masz dostęp do podglądu. Dodawanie i edycja użytkowników RFID są dostępne dla ról master i administrator.
            </p>
          </div>
        </div>

        <div className="users-main">
          <div className="section-snapshot">
            <SnapshotCard label="Użytkownicy" valueId="rfidUsersSnapshotCount" value={rfidUsers.length} help="Konta RFID w systemie" />
            <SnapshotCard label="Dostęp" valueId="rfidUsersSnapshotAccess" value={totalAccessAssignments} help="Łączne przypisania do skrytek" />
          </div>
          <div className="card">
            <div className="section-header">
              <SectionCopy title="Lista użytkowników">
                Przeglądaj i edytuj przypisania kart RFID do skrytek oraz przygotuj konfigurację pod czytnik użytkownika.
              </SectionCopy>
              <div className="section-actions">
                <span id="rfidUsersCount" className="panel-counter">{rfidUsers.length}</span>
                <button id="refreshRfidUsersButton" className="secondary-button" type="button" onClick={refreshRfidUsers}>Odśwież listę</button>
              </div>
            </div>
            <div className="list-toolbar">
              <SearchField id="rfidUsersSearch" name="rfidUsers" label="Szukaj użytkownika" value={filters.rfidUsers} placeholder="nazwa, tag, skrytka..." />
            </div>
            <div id="rfidUsersList" className="users-list">
              {rfidUsers.length === 0 ? (
                <EmptyListState>Dodaj pierwszą osobę i przypisz jej skrytki, aby przygotować dostęp kartą RFID.</EmptyListState>
              ) : visibleUsers.length === 0 ? (
                <EmptyListState>Nie znaleziono użytkowników pasujących do wyszukiwania.</EmptyListState>
              ) : visibleUsers.map(user => (
                <RfidUserCard key={user._id || user.tagId} user={user} canManage={canManageRfid} />
              ))}
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

function RfidItemsPage({ activePage }) {
  const { filters, forms, rfidItems } = useAdminLists();
  const { canAccessPanelUsers, canManageRfid } = useUiShell();
  const rfidAssignment = useRfidAssignment();
  const rfidItemForm = forms.rfidItem;
  const assignmentView = getRfidAssignmentViewModel(rfidAssignment);
  const visibleItems = rfidItems.filter(item => matchesSearch([
    item.name,
    item.tagId,
    item.itemType,
    getItemTypeLabel(item.itemType)
  ], filters.rfidItems));
  const itemTypes = new Set(rfidItems.map(item => item.itemType)).size;

  return (
    <section id="itemsPage" className={`page${activePage === "items" ? " active" : ""}`}>
      <div className="users-layout">
        <div className="users-sidebar">
          <div className="card form-card">
            <SectionCopy title="Przedmioty RFID" cardTitle>
              Dodawaj własne przedmioty rozpoznawane po UID taga RFID. System pokaże ich nazwę i typ w logach oraz w statusie skrytek.
            </SectionCopy>

            <form id="rfidItemForm" className={`auth-form${canManageRfid ? "" : " hidden"}`} onSubmit={event => {
              event.preventDefault();
              submitRfidItemFormFromStore();
            }}
            >
              <input id="rfidItemId" type="hidden" value={rfidItemForm.id} readOnly />

              <label className="field">
                <span className="field-label">Nazwa przedmiotu</span>
                <input
                  id="rfidItemName"
                  type="text"
                  placeholder="np. Klucz do magazynu"
                  required
                  value={rfidItemForm.name}
                  onChange={event => setRfidItemFormField("name", event.target.value)}
                />
              </label>

              <label className="field">
                <span className="field-label">UID taga RFID</span>
                <div className="inline-field">
                  <input
                    id="rfidItemTagId"
                    type="text"
                    placeholder="np. 04A1B2C3D4"
                    required
                    value={rfidItemForm.tagId}
                    onChange={event => setRfidItemFormField("tagId", event.target.value)}
                  />
                  <button
                    id="assignRfidTagButton"
                    className={`secondary-button${assignmentView.buttonDanger ? " danger" : ""}`}
                    type="button"
                    disabled={assignmentView.buttonDisabled}
                    onClick={handleRfidAssignmentButtonFromStore}
                  >
                    {assignmentView.buttonLabel}
                  </button>
                </div>
                <small id="rfidAssignmentStatus" className="field-help">
                  {assignmentView.statusText}
                </small>
              </label>

              <label className="field">
                <span className="field-label">Typ</span>
                <select id="rfidItemType" required value={rfidItemForm.itemType} onChange={event => setRfidItemFormField("itemType", event.target.value)}>
                  <option value="brelok">Brelok</option>
                  <option value="karta">Karta</option>
                  <option value="inne">Inne</option>
                  {canAccessPanelUsers ? <option value="klucz_master">Klucz master</option> : null}
                  {canAccessPanelUsers ? <option value="karta_master">Karta master</option> : null}
                </select>
              </label>

              <button id="rfidItemSubmit" type="submit" disabled={rfidItemForm.submitting}>
                {rfidItemForm.submitting ? "Zapisywanie..." : rfidItemForm.id ? "Zapisz zmiany" : "Dodaj przedmiot"}
              </button>
              <button id="rfidItemReset" className="secondary-button" type="button" onClick={resetRfidItemFormState}>Wyczyść formularz</button>
            </form>
            <p className={`field-help${canManageRfid ? " hidden" : ""}`}>
              Masz dostęp do podglądu. Dodawanie zwykłych przedmiotów RFID wymaga roli administrator, a tagów master roli master.
            </p>
          </div>
        </div>

        <div className="users-main">
          <div className="section-snapshot">
            <SnapshotCard label="Przedmioty" valueId="rfidItemsSnapshotCount" value={rfidItems.length} help="Własne obiekty RFID" />
            <SnapshotCard label="Typy" valueId="rfidItemsSnapshotTypes" value={itemTypes} help="Aktywne kategorie" />
          </div>
          <div className="card">
            <div className="section-header">
              <SectionCopy title="Lista przedmiotów">
                Tu zarządzasz mapowaniem UID tagów na czytelne nazwy i typy przedmiotów.
              </SectionCopy>
              <div className="section-actions">
                <span id="rfidItemsCount" className="panel-counter">{rfidItems.length}</span>
                <button id="refreshRfidItemsButton" className="secondary-button" type="button" onClick={refreshRfidItems}>Odśwież listę</button>
              </div>
            </div>
            <div className="list-toolbar">
              <SearchField id="rfidItemsSearch" name="rfidItems" label="Szukaj przedmiotu" value={filters.rfidItems} placeholder="nazwa, UID, typ..." />
            </div>
            <div id="rfidItemsList" className="users-list">
              {rfidItems.length === 0 ? (
                <EmptyListState>Dodaj pierwszy przedmiot RFID, aby system mógł pokazywać czytelne nazwy zamiast samych UID.</EmptyListState>
              ) : visibleItems.length === 0 ? (
                <EmptyListState>Nie znaleziono przedmiotów pasujących do wyszukiwania.</EmptyListState>
              ) : visibleItems.map(item => (
                <RfidItemCard key={item._id || item.tagId} item={item} canManage={canManageRfid} canManageMaster={canAccessPanelUsers} />
              ))}
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

function PanelUsersPage({ activePage }) {
  const { filters, forms, panelUsers } = useAdminLists();
  const { canAccessPanelUsers, currentUsername } = useUiShell();
  const panelUserForm = forms.panelUser;
  const visibleUsers = panelUsers.filter(user => matchesSearch([
    user.displayName,
    user.username,
    user.role,
    getPanelRoleLabel(user.role)
  ], filters.panelUsers));
  const masterUsers = panelUsers.filter(user => user.role === "master").length;

  return (
    <section id="panelUsersPage" className={`page${activePage === "panelUsers" ? " active" : ""}`}>
      <div className="users-layout">
        <div className="users-sidebar">
          <div className="card form-card">
            <SectionCopy title="Użytkownicy panelu" cardTitle>
              Tylko użytkownik master może dodawać, usuwać i edytować konta oraz role dostępu do panelu.
            </SectionCopy>

            <form id="panelUserForm" className="auth-form" onSubmit={event => {
              event.preventDefault();
              submitPanelUserFormFromStore();
            }}
            >
              <input id="panelUserId" type="hidden" value={panelUserForm.id} readOnly />

              <label className="field">
                <span className="field-label">Nazwa wyświetlana</span>
                <input
                  id="panelUserDisplayName"
                  type="text"
                  placeholder="np. Jan Kowalski"
                  required
                  value={panelUserForm.displayName}
                  onChange={event => setPanelUserFormField("displayName", event.target.value)}
                />
              </label>

              <label className="field">
                <span className="field-label">Login</span>
                <input
                  id="panelUserUsername"
                  type="text"
                  placeholder="np. admin"
                  required
                  value={panelUserForm.username}
                  onChange={event => setPanelUserFormField("username", event.target.value)}
                />
              </label>

              <label className="field">
                <span className="field-label">Hasło</span>
                <input
                  id="panelUserPassword"
                  type="password"
                  placeholder="Minimum 6 znaków"
                  required={!panelUserForm.id}
                  value={panelUserForm.password}
                  onChange={event => setPanelUserFormField("password", event.target.value)}
                />
                <small className="field-help">Przy edycji zostaw puste, jeśli hasło ma pozostać bez zmian.</small>
              </label>

              <label className="field">
                <span className="field-label">Rola</span>
                <select id="panelUserRole" required value={panelUserForm.role} onChange={event => setPanelUserFormField("role", event.target.value)}>
                  <option value="master">Master</option>
                  <option value="admin">Administrator</option>
                  <option value="operator">Operator</option>
                  <option value="viewer">Podgląd</option>
                </select>
              </label>

              <button id="panelUserSubmit" type="submit" disabled={panelUserForm.submitting || !canAccessPanelUsers}>
                {panelUserForm.submitting ? "Zapisywanie..." : panelUserForm.id ? "Zapisz zmiany" : "Dodaj użytkownika"}
              </button>
              <button id="panelUserReset" className="secondary-button" type="button" onClick={resetPanelUserFormState}>Wyczyść formularz</button>
            </form>
          </div>
        </div>

        <div className="users-main">
          <div className="section-snapshot">
            <SnapshotCard label="Konta panelu" valueId="panelUsersSnapshotCount" value={panelUsers.length} help="Wszyscy operatorzy" />
            <SnapshotCard label="Master" valueId="panelUsersSnapshotMasters" value={masterUsers} help="Uprawnienia najwyższe" />
          </div>
          <div className="card">
            <div className="section-header">
              <SectionCopy title="Lista kont panelu">
                Konta są teraz trzymane poza zmiennymi środowiskowymi i można nimi zarządzać z poziomu panelu.
              </SectionCopy>
              <div className="section-actions">
                <span id="panelUsersCount" className="panel-counter">{panelUsers.length}</span>
                <button id="backupExportButton" className="secondary-button" type="button" onClick={exportBackupFromStore}>Backup JSON</button>
                <button id="refreshPanelUsersButton" className="secondary-button" type="button" onClick={refreshPanelUsers}>Odśwież listę</button>
              </div>
            </div>
            <div className="list-toolbar">
              <SearchField id="panelUsersSearch" name="panelUsers" label="Szukaj konta" value={filters.panelUsers} placeholder="nazwa, login, rola..." />
            </div>
            <div id="panelUsersList" className="users-list">
              {panelUsers.length === 0 ? (
                <EmptyListState>Nie ma jeszcze dodatkowych kont panelu. Możesz utworzyć operatorów i nadać im role.</EmptyListState>
              ) : visibleUsers.length === 0 ? (
                <EmptyListState>Nie znaleziono kont pasujących do wyszukiwania.</EmptyListState>
              ) : visibleUsers.map(user => (
                <PanelUserCard key={user._id || user.username} currentUsername={currentUsername} user={user} />
              ))}
            </div>
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
