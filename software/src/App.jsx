import panelMarkup from "./panelMarkup.html?raw";

export function App() {
  return <div dangerouslySetInnerHTML={{ __html: panelMarkup }} />;
}
