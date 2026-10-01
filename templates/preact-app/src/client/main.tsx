import { render } from "preact";
import { App } from "./App.js";

const root = document.getElementById("app");
if (root !== null) render(<App />, root);
