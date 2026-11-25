import { buildGateway } from "./app.js";
import { loadConfig } from "./config.js";

const cfg = loadConfig();
const gw = await buildGateway(cfg);
await gw.app.listen({ port: cfg.port, host: "127.0.0.1" });
console.log(`gateway listening on ${cfg.port} (mode ${cfg.mode})`);
if (cfg.recoverOnStart) {
  gw.recover().then(
    () => console.log("recovery scan complete"),
    (e) => console.error("recovery scan failed", e),
  );
}