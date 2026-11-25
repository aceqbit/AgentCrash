import { buildMock } from "./server.js";

const port = Number(process.env.MOCK_PORT ?? 7101);
const dir = process.env.MOCK_DIR ?? ".run/mock";
const app = buildMock({ dir, replyDelayMs: Number(process.env.MOCK_DELAY_MS ?? 0) });
await app.listen({ port, host: "127.0.0.1" });
console.log(`mock MCP server on ${port}, effects in ${dir}`);