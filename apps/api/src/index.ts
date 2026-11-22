import { NodeRuntime } from "@effect/platform-node";
import { Layer } from "effect";
import { HttpServerLayer } from "./server.ts";

Layer.launch(HttpServerLayer).pipe(NodeRuntime.runMain);
