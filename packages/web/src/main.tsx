import "./styles/tokens.css";
import "./styles/base.css";
import "./styles/components.css";
import "./styles/layout.css";
import { render } from "preact";
import { App } from "./app.js";
import "./state/prefs.js";

const root = document.getElementById("app");
if (root) render(<App />, root);
