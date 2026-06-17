import "./ui/styles.css";
import { mountApp } from "./ui/app.js";

// Expose the store on window for e2e tests / debugging / AI tooling hooks.
declare global {
  interface Window {
    flowloom?: ReturnType<typeof mountApp>;
  }
}

const root = document.getElementById("app");
if (root) {
  window.flowloom = mountApp(root);
}
