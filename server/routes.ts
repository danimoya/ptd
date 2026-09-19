import type { Express } from "express";
import { createServer } from "http";
import { registerAuthRoutes } from "./auth";
import { registerOrgRoutes } from "./orgs";
import { registerTokenRoutes } from "./tokens";
import { registerAgentSignup } from "./agentSignup";
import { registerMcp } from "./mcp";
import { registerDiscovery } from "./discovery";
import { initializeWebSocket } from "./websocket";
import { apiLimiter } from "./rate-limit";
import { registerActionsHttp } from "./actionsHttp";
import { registerPlanRoutes } from "./plan/routes";
import { registerTrackRoutes } from "./track/routes";
import { registerOverviewRoutes } from "./overview/routes";
import "./actions";

export function registerRoutes(app: Express) {
  const httpServer = createServer(app);
  app.get("/api/health", (_req, res) => res.json({ status: "ok" }));
  app.use("/api", apiLimiter);
  initializeWebSocket(httpServer);
  registerAuthRoutes(app);
  registerOrgRoutes(app);
  registerTokenRoutes(app);
  registerAgentSignup(app);
  registerDiscovery(app);
  registerMcp(app);
  registerActionsHttp(app);
  registerPlanRoutes(app);
  registerTrackRoutes(app);
  registerOverviewRoutes(app);
  return httpServer;
}
