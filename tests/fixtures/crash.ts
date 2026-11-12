import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { fixture } from "./agent.ts";

const database = process.argv[2];
if (!database) throw new Error("Expected the crash-test database path.");
const f = await fixture({
  storage: await openNodeSqliteStorage(database),
  tokensPerSecond: 1,
  retries: 1,
  answers: [
    "This deliberately slow synthetic response will be interrupted by SIGKILL.",
  ],
});
console.log(JSON.stringify({ event: "ready", url: f.baseUrl }));
const timer = setInterval(() => {
  if (f.faux.state.callCount > 0) {
    console.log(JSON.stringify({ event: "model_started" }));
    clearInterval(timer);
  }
}, 10);
process.on("SIGTERM", () => {
  clearInterval(timer);
  void f.close();
});
