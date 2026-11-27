import type { SessionEvent } from "@metamorph/shared";
import { Context, Effect, Layer, PubSub, Stream } from "effect";

export interface OrchestratorEventBusShape {
  readonly publish: (event: SessionEvent) => Effect.Effect<void>;
  readonly subscribe: (sessionId: string) => Stream.Stream<SessionEvent>;
  readonly subscribeAll: Stream.Stream<SessionEvent>;
}

export class OrchestratorEventBus extends Context.Service<
  OrchestratorEventBus,
  OrchestratorEventBusShape
>()("@metamorph/orchestrator/OrchestratorEventBus") {
  static readonly layer = Layer.effect(
    OrchestratorEventBus,
    Effect.gen(function* () {
      const pubsub = yield* PubSub.bounded<SessionEvent>({
        capacity: 256,
        replay: 32,
      });

      yield* Effect.addFinalizer(() => PubSub.shutdown(pubsub));

      const publish = Effect.fn("OrchestratorEventBus.publish")(function* (event: SessionEvent) {
        yield* PubSub.publish(pubsub, event);
      });

      const subscribeAll = Stream.fromPubSub(pubsub);

      const subscribe = (sessionId: string): Stream.Stream<SessionEvent> =>
        subscribeAll.pipe(Stream.filter((event) => event.sessionId === sessionId));

      return OrchestratorEventBus.of({
        publish,
        subscribe,
        subscribeAll,
      });
    }),
  );
}
