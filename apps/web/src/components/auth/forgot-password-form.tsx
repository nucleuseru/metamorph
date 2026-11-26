"use client";

import { EnvelopeSimpleIcon, WarningCircleIcon } from "@phosphor-icons/react";
import Link from "next/link";
import { useState, type FormEvent } from "react";

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
import { Field, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { authClient, getAppOrigin } from "@/lib/auth-client";

export function ForgotPasswordForm() {
  const [email, setEmail] = useState("");
  const [emailError, setEmailError] = useState<string | undefined>();
  const [formError, setFormError] = useState<string | null>(null);
  const [isPending, setIsPending] = useState(false);
  const [submittedEmail, setSubmittedEmail] = useState<string | null>(null);

  function validate(): string | undefined {
    const trimmedEmail = email.trim();
    if (!trimmedEmail) {
      return "Email is required.";
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmedEmail)) {
      return "Enter a valid email address.";
    }
    return undefined;
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFormError(null);

    const validationError = validate();
    setEmailError(validationError);
    if (validationError) {
      return;
    }

    setIsPending(true);
    try {
      const trimmedEmail = email.trim();
      const { error } = await authClient.requestPasswordReset({
        email: trimmedEmail,
        redirectTo: `${getAppOrigin()}/reset-password`,
      });

      if (error) {
        setFormError(error.message ?? "Unable to request password reset.");
        return;
      }

      setSubmittedEmail(trimmedEmail);
    } catch {
      setFormError("Unable to request password reset right now. Please try again.");
    } finally {
      setIsPending(false);
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
            If an account exists for <span className="text-foreground">{submittedEmail}</span>, we
            sent a password reset link.
          </CardDescription>
        </CardHeader>

        <CardContent className="flex flex-col gap-3">
          <Button
            type="button"
            variant="outline"
            size="lg"
            className="w-full"
            onClick={() => {
              setSubmittedEmail(null);
              setEmail("");
            }}
          >
            Try another email
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
        <CardTitle>Reset your password</CardTitle>
        <CardDescription>
          Enter the email address associated with your account and we&apos;ll send you a link to
          reset your password.
        </CardDescription>
      </CardHeader>

      <CardContent className="flex flex-col gap-6">
        {formError && (
          <Alert variant="destructive">
            <WarningCircleIcon />
            <AlertTitle>Request failed</AlertTitle>
            <AlertDescription>{formError}</AlertDescription>
          </Alert>
        )}

        <form onSubmit={handleSubmit} noValidate className="flex flex-col gap-6">
          <FieldGroup>
            <Field data-invalid={emailError ? true : undefined}>
              <FieldLabel htmlFor="forgot-email">Email</FieldLabel>
              <Input
                id="forgot-email"
                type="email"
                autoComplete="email"
                placeholder="you@example.com"
                value={email}
                onChange={(event) => {
                  setEmail(event.target.value);
                  if (emailError) {
                    setEmailError(undefined);
                  }
                }}
                aria-invalid={emailError ? true : undefined}
                disabled={isPending}
              />
              {emailError && <FieldError>{emailError}</FieldError>}
            </Field>
          </FieldGroup>

          <Button type="submit" size="lg" className="w-full" disabled={isPending}>
            {isPending && <Spinner data-icon="inline-start" />}
            Send reset link
          </Button>
        </form>
      </CardContent>

      <CardFooter className="justify-center">
        <p className="text-sm text-muted-foreground">
          Remember your password?{" "}
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
