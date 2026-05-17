import { httpRouter } from "convex/server";
import { webhookTts } from "./inference";

const http = httpRouter();

http.route({
  path: "/webhook/audio/tts",
  method: "POST",
  handler: webhookTts,
});

export default http;
