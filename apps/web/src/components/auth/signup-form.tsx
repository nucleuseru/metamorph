"use client";

import { EnvelopeSimpleIcon, WarningCircleIcon } from "@phosphor-icons/react";
import Link from "next/link";
import { useState, type FormEvent } from "react";

import { AuthDivider } from "@/components/auth/auth-divider";
import { GoogleButton } from "@/components/auth/google-button";
import { PasswordInput } from "@/components/auth/password-input";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import {
  authClient,
  getAppOrigin,
  MAX_PASSWORD_LENGTH,
  MIN_PASSWORD_LENGTH,
} from "@/lib/auth-client";

interface FieldErrors {
  name?: string;
  email?: string;
  password?: string;
  confirmPassword?: string;
}

export function SignupForm() {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [isPending, setIsPending] = useState(false);
  const [submittedEmail, setSubmittedEmail] = useState<string | null>(null);
  const [resendState, setResendState] = useState<"idle" | "sending" | "sent">("idle");

  function validate(): FieldErrors {
    const errors: FieldErrors = {};
    if (!name.trim()) {
      errors.name = "Name is required.";
    }
    const trimmedEmail = email.trim();
    if (!trimmedEmail) {
      errors.email = "Email is required.";
    } else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmedEmail)) {
      errors.email = "Enter a valid email address.";
    }
    if (password.length < MIN_PASSWORD_LENGTH) {
      errors.password = `Password must be at least ${MIN_PASSWORD_LENGTH} characters.`;
    } else if (password.length > MAX_PASSWORD_LENGTH) {
      errors.password = `Password must be at most ${MAX_PASSWORD_LENGTH} characters.`;
    }
    if (confirmPassword !== password) {
      errors.confirmPassword = "Passwords do not match.";
    }
    return errors;
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFormError(null);

    const errors = validate();
    setFieldErrors(errors);
    if (Object.keys(errors).length > 0) {
      return;
    }

    setIsPending(true);
    try {
      const trimmedEmail = email.trim();
      const { error } = await authClient.signUp.email({
        name: name.trim(),
        email: trimmedEmail,
        password,
        callbackURL: `${getAppOrigin()}/`,
      });

      if (error) {
        setFormError(error.message ?? "Unable to create account.");
        return;
      }

      setSubmittedEmail(trimmedEmail);
    } catch {
      setFormError("Unable to create account right now. Please try again.");
    } finally {
      setIsPending(false);
    }
  }

  async function handleResend() {
    if (!submittedEmail) return;
    setFormError(null);
    setResendState("sending");
    try {
      const { error } = await authClient.sendVerificationEmail({
        email: submittedEmail,
        callbackURL: `${getAppOrigin()}/`,
      });
      if (error) {
        setFormError(error.message ?? "Unable to resend verification email.");
        setResendState("idle");
        return;
      }
      setResendState("sent");
    } catch {
      setFormError("Unable to resend verification email. Please try again.");
      setResendState("idle");
    }
  }

  if (submittedEmail) {
    return (
      <Card size="lg">
        <CardHeader className="gap-2">
          <div className="mb-1 flex size-10 items-center justify-center rounded-full bg-accent-soft text-accent-foreground">
            <EnvelopeSimpleIcon className="size-5" />
          </div>
          <CardTitle>Check your email</CardTitle>
          <CardDescription>
            We sent a verification link to <span className="text-foreground">{submittedEmail}</span>
            . Open the link to activate your account.
          </CardDescription>
        </CardHeader>

        <CardContent className="flex flex-col gap-4">
          {formError && (
            <Alert variant="destructive">
              <WarningCircleIcon />
              <AlertTitle>Resend failed</AlertTitle>
              <AlertDescription>{formError}</AlertDescription>
            </Alert>
          )}

          <Button
            type="button"
            variant="outline"
            size="lg"
            className="w-full"
            disabled={resendState === "sending" || resendState === "sent"}
            onClick={handleResend}
          >
            {resendState === "sending" && <Spinner data-icon="inline-start" />}
            {resendState === "sent" ? "Verification email sent" : "Resend verification email"}
          </Button>
        </CardContent>

        <CardFooter className="justify-center">
          <Link
            href="/login"
            className="text-sm text-muted-foreground transition-colors hover:text-accent-foreground"
          >
            Back to sign in
          </Link>
        </CardFooter>
      </Card>
    );
  }

  return (
    <Card size="lg">
      <CardHeader className="gap-2">
        <CardTitle>Create your account</CardTitle>
        <CardDescription>Get started with Metamorph in seconds.</CardDescription>
      </CardHeader>

      <CardContent className="flex flex-col gap-6">
        <GoogleButton onError={setFormError} disabled={isPending} />

        <AuthDivider />

        {formError && (
          <Alert variant="destructive">
            <WarningCircleIcon />
            <AlertTitle>Sign up failed</AlertTitle>
            <AlertDescription>{formError}</AlertDescription>
          </Alert>
        )}

        <form onSubmit={handleSubmit} noValidate className="flex flex-col gap-6">
          <FieldGroup>
            <Field data-invalid={fieldErrors.name ? true : undefined}>
              <FieldLabel htmlFor="signup-name">Name</FieldLabel>
              <Input
                id="signup-name"
                type="text"
                autoComplete="name"
                placeholder="Ada Lovelace"
                value={name}
                onChange={(event) => {
                  setName(event.target.value);
                  if (fieldErrors.name) {
                    setFieldErrors((prev) => ({ ...prev, name: undefined }));
                  }
                }}
                aria-invalid={fieldErrors.name ? true : undefined}
                disabled={isPending}
              />
              {fieldErrors.name && <FieldError>{fieldErrors.name}</FieldError>}
            </Field>

            <Field data-invalid={fieldErrors.email ? true : undefined}>
              <FieldLabel htmlFor="signup-email">Email</FieldLabel>
              <Input
                id="signup-email"
                type="email"
                autoComplete="email"
                placeholder="you@example.com"
                value={email}
                onChange={(event) => {
                  setEmail(event.target.value);
                  if (fieldErrors.email) {
                    setFieldErrors((prev) => ({ ...prev, email: undefined }));
                  }
                }}
                aria-invalid={fieldErrors.email ? true : undefined}
                disabled={isPending}
              />
              {fieldErrors.email && <FieldError>{fieldErrors.email}</FieldError>}
            </Field>

            <Field data-invalid={fieldErrors.password ? true : undefined}>
              <FieldLabel htmlFor="signup-password">Password</FieldLabel>
              <PasswordInput
                id="signup-password"
                autoComplete="new-password"
                placeholder="Create a password"
                value={password}
                onChange={(event) => {
                  setPassword(event.target.value);
                  if (fieldErrors.password) {
                    setFieldErrors((prev) => ({ ...prev, password: undefined }));
                  }
                }}
                aria-invalid={fieldErrors.password ? true : undefined}
                disabled={isPending}
              />
              <FieldDescription>
                Must be at least {MIN_PASSWORD_LENGTH} characters.
              </FieldDescription>
              {fieldErrors.password && <FieldError>{fieldErrors.password}</FieldError>}
            </Field>

            <Field data-invalid={fieldErrors.confirmPassword ? true : undefined}>
              <FieldLabel htmlFor="signup-confirm-password">Confirm password</FieldLabel>
              <PasswordInput
                id="signup-confirm-password"
                autoComplete="new-password"
                placeholder="Repeat your password"
                value={confirmPassword}
                onChange={(event) => {
                  setConfirmPassword(event.target.value);
                  if (fieldErrors.confirmPassword) {
                    setFieldErrors((prev) => ({ ...prev, confirmPassword: undefined }));
                  }
                }}
                aria-invalid={fieldErrors.confirmPassword ? true : undefined}
                disabled={isPending}
              />
              {fieldErrors.confirmPassword && (
                <FieldError>{fieldErrors.confirmPassword}</FieldError>
              )}
            </Field>
          </FieldGroup>

          <Button type="submit" size="lg" className="w-full" disabled={isPending}>
            {isPending && <Spinner data-icon="inline-start" />}
            Create account
          </Button>
        </form>
      </CardContent>

      <CardFooter className="justify-center">
        <p className="text-sm text-muted-foreground">
          Already have an account?{" "}
          <Link
            href="/login"
            className="text-foreground underline-offset-4 hover:text-accent-foreground hover:underline"
          >
            Sign in
          </Link>
        </p>
      </CardFooter>
    </Card>
  );
}
