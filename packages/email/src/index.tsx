import { render } from "react-email";

import { PasswordResetEmail, type PasswordResetEmailProps } from "./emails/password-reset.tsx";
import { VerificationEmail, type VerificationEmailProps } from "./emails/verification.tsx";

export {
  PasswordResetEmail,
  VerificationEmail,
  type PasswordResetEmailProps,
  type VerificationEmailProps,
};

export interface RenderedEmail {
  readonly subject: string;
  readonly html: string;
  readonly text: string;
}

export async function renderVerificationEmail(
  props: VerificationEmailProps,
): Promise<RenderedEmail> {
  const element = <VerificationEmail {...props} />;
  const [html, text] = await Promise.all([render(element), render(element, { plainText: true })]);
  return {
    subject: "Verify your Metamorph email address",
    html,
    text,
  };
}

export async function renderPasswordResetEmail(
  props: PasswordResetEmailProps,
): Promise<RenderedEmail> {
  const element = <PasswordResetEmail {...props} />;
  const [html, text] = await Promise.all([render(element), render(element, { plainText: true })]);
  return {
    subject: "Reset your Metamorph password",
    html,
    text,
  };
}
