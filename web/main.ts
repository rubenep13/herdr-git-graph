import { App } from "./app.ts";

const root = document.getElementById("app");
if (root) void new App(root).start();
