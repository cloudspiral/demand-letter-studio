import { buildApp } from "./server";
import { config } from "./config";

const app = await buildApp();
await app.listen({ host: config.host, port: config.port });

const shutdown = async () => {
  await app.close();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
