import { SendEmailCommand, SESv2Client } from "@aws-sdk/client-sesv2";
import { Config, Context, Effect, Layer, Option, Schema } from "effect";

export interface EmailMessage {
  readonly to: string;
  readonly subject: string;
  readonly text: string;
  readonly html?: string | undefined;
}

export type SendEmail = (message: EmailMessage) => Promise<void>;

export interface SesEmailSenderConfig {
  readonly fromEmail: string;
  readonly client: Pick<SESv2Client, "send">;
}

/** Builds a promise-based sender backed by AWS SES v2. */
export const createSesEmailSender =
  (config: SesEmailSenderConfig): SendEmail =>
  async (message) => {
    await config.client.send(
      new SendEmailCommand({
        FromEmailAddress: config.fromEmail,
        Destination: { ToAddresses: [message.to] },
        Content: {
          Simple: {
            Subject: { Data: message.subject, Charset: "UTF-8" },
            Body: {
              Text: { Data: message.text, Charset: "UTF-8" },
              ...(message.html ? { Html: { Data: message.html, Charset: "UTF-8" } } : {}),
            },
          },
        },
      }),
    );
  };

export class EmailSendError extends Schema.TaggedError<EmailSendError>()("EmailSendError", {
  to: Schema.String,
  subject: Schema.String,
  cause: Schema.Defect(),
}) {}

export class EmailService extends Context.Service<
  EmailService,
  {
    readonly send: (message: EmailMessage) => Effect.Effect<void, EmailSendError>;
  }
>()("@metamorph/api/services/EmailService") {
  static readonly layer = Layer.effect(
    EmailService,
    Effect.gen(function* () {
      const region = yield* Config.String("AWS_REGION").pipe(Config.withDefault("us-east-1"));
      const profile = yield* Config.option(Config.String("AWS_PROFILE"));
      const fromEmail = yield* Config.String("SES_FROM_EMAIL");

      const client = yield* Effect.acquireRelease(
        Effect.sync(
          () =>
            new SESv2Client({
              region,
              ...(Option.isSome(profile) && profile.value !== "" ? { profile: profile.value } : {}),
            }),
        ),
        (c) => Effect.sync(() => c.destroy()),
      );
      const sender = createSesEmailSender({ fromEmail, client });

      const send = Effect.fn("EmailService.send")(function* (message: EmailMessage) {
        yield* Effect.tryPromise({
          try: () => sender(message),
          catch: (cause) => new EmailSendError({ to: message.to, subject: message.subject, cause }),
        });
      });

      return EmailService.of({ send });
    }),
  );
}
