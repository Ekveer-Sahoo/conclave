#!/usr/bin/env node
import { shutdownWebServer, startWebServer } from "./http/server.js";

const server = startWebServer(Number(process.env.CONCLAVE_PORT ?? 4317));

let shuttingDown = false;
async function onSignal(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`Conclave web: received ${signal}, shutting down...`);
  try {
    await shutdownWebServer(server);
    process.exit(0);
  } catch (error) {
    console.error("Conclave web: error during shutdown", error);
    process.exit(1);
  }
}
process.on("SIGTERM", () => void onSignal("SIGTERM"));
process.on("SIGINT", () => void onSignal("SIGINT"));
