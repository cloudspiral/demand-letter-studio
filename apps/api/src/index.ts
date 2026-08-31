import { buildApp } from "./server";
import { config } from "./config";
import { createCollaborationServer } from "./collaboration";

const app = await buildApp();
const collaboration = createCollaborationServer();
await app.listen({ host: "127.0.0.1", port: config.port });
await collaboration.listen();

const shutdown = async () => {
  await collaboration.destroy();
  await app.close();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
