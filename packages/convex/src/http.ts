import { httpRouter } from "convex/server";
import { authComponent, createAuth } from "./betterAuth/auth";
import { runpodWebhook } from "./webhook";

const http = httpRouter();

authComponent.registerRoutes(http, createAuth);

http.route({
  method: "POST",
  path: "/webhook/runpod",
  handler: runpodWebhook,
});

export default http;
