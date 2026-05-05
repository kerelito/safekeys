import { useUiShell } from "../state/uiShellStore.js";

export function MenuDrawer() {
  const { activePage, canAccessPanelUsers, menuOpen, setActivePage } = useUiShell();

  const getMenuLinkClass = page => `menu-link${activePage === page ? " active" : ""}`;

  return (
    <div id="menuDrawer" className={`menu-drawer${menuOpen ? "" : " hidden"}`}>
      <nav>
        <button className={getMenuLinkClass("dashboard")} type="button" data-page="dashboard" onClick={() => setActivePage("dashboard")}>Dashboard</button>
        <button className={getMenuLinkClass("users")} type="button" data-page="users" data-advanced-only="true" onClick={() => setActivePage("users")}>
          Użytkownicy RFID
        </button>
        <button className={getMenuLinkClass("items")} type="button" data-page="items" data-advanced-only="true" onClick={() => setActivePage("items")}>
          Przedmioty RFID
        </button>
        <button
          id="panelUsersMenuLink"
          className={`${getMenuLinkClass("panelUsers")}${canAccessPanelUsers ? "" : " hidden"}`}
          type="button"
          data-page="panelUsers"
          data-advanced-only="true"
          onClick={() => setActivePage("panelUsers")}
        >
          Użytkownicy panelu
        </button>
      </nav>
    </div>
  );
}
