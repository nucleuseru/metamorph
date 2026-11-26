"use client";

import { WarningCircleIcon } from "@phosphor-icons/react";
import Link from "next/link";
import { useRouter } from "next/navigation";
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
import { Field, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { authClient, getAppOrigin } from "@/lib/auth-client";

interface FieldErrors {
  email?: string;
  password?: string;
}

export function LoginForm() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [needsVerification, setNeedsVerification] = useState(false);
  const [resendState, setResendState] = useState<"idle" | "sending" | "sent">("idle");
  const [isPending, setIsPending] = useState(false);

  function validate(): FieldErrors {
    const errors: FieldErrors = {};
    const trimmedEmail = email.trim();
    if (!trimmedEmail) {
      errors.email = "Email is required.";
    } else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmedEmail)) {
      errors.email = "Enter a valid email address.";
    }
    if (!password) {
      errors.password = "Password is required.";
    }
    return errors;
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFormError(null);
    setNeedsVerification(false);
    setResendState("idle");

    const errors = validate();
    setFieldErrors(errors);
    if (Object.keys(errors).length > 0) {
      return;
    }

    setIsPending(true);
    try {
      const { error } = await authClient.signIn.email({
        email: email.trim(),
        password,
        callbackURL: `${getAppOrigin()}/`,
      });

      if (error) {
        if (error.code === "EMAIL_NOT_VERIFIED" || error.status === 403) {
          setNeedsVerification(true);
          setFormError("Verify your email address before signing in.");
        } else {
          setFormError(error.message ?? "Invalid email or password.");
        }
        return;
      }

      router.push("/");
      router.refresh();
    } catch {
      setFormError("Unable to sign in right now. Please try again.");
    } finally {
      setIsPending(false);
    }
  }

  async function handleResendVerification() {
    setResendState("sending");
    try {
      const { error } = await authClient.sendVerificationEmail({
        email: email.trim(),
        callbackURL: `${getAppOrigin()}/`,
      });
      if (error) {
        setFormError(error.message ?? "Could not resend verification email.");
        setResendState("idle");
        return;
      }
      setResendState("sent");
    } catch {
      setFormError("Could not resend verification email. Please try again.");
      setResendState("idle");
    }
  }

  return (
    <Card size="lg">
      <CardHeader className="gap-2">
        <CardTitle>Sign in to Metamorph</CardTitle>
        <CardDescription>Welcome back. Enter your credentials to continue.</CardDescription>
      </CardHeader>

      <CardContent className="flex flex-col gap-6">
        <GoogleButton onError={setFormError} disabled={isPending} />

        <AuthDivider />

        {formError && (
          <Alert variant="destructive">
            <WarningCircleIcon />
            <AlertTitle>{needsVerification ? "Email not verified" : "Sign in failed"}</AlertTitle>
            <AlertDescription className="flex flex-col gap-3">
              <p>{formError}</p>
              {needsVerification && (
                <div className="flex items-center gap-3">
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={resendState === "sending" || resendState === "sent"}
                    onClick={handleResendVerification}
                  >
                    {resendState === "sending" && <Spinner data-icon="inline-start" />}
                    {resendState === "sent"
                      ? "Verification email sent"
                      : "Resend verification email"}
                  </Button>
                </div>
              )}
            </AlertDescription>
          </Alert>
        )}

        <form onSubmit={handleSubmit} noValidate className="flex flex-col gap-6">
          <FieldGroup>
            <Field data-invalid={fieldErrors.email ? true : undefined}>
              <FieldLabel htmlFor="login-email">Email</FieldLabel>
              <Input
                id="login-email"
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
              <div className="flex items-center justify-between gap-2">
                <FieldLabel htmlFor="login-password">Password</FieldLabel>
                <Link
                  href="/forgot-password"
                  className="text-xs text-muted-foreground transition-colors hover:text-accent-foreground"
                >
                  Forgot password?
                </Link>
              </div>
              <PasswordInput
                id="login-password"
                autoComplete="current-password"
                placeholder="Enter your password"
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
              {fieldErrors.password && <FieldError>{fieldErrors.password}</FieldError>}
            </Field>
          </FieldGroup>

          <Button type="submit" size="lg" className="w-full" disabled={isPending}>
            {isPending && <Spinner data-icon="inline-start" />}
            Sign in
          </Button>
        </form>
      </CardContent>

      <CardFooter className="justify-center">
        <p className="text-sm text-muted-foreground">
          Don&apos;t have an account?{" "}
          <Link
            href="/signup"
            className="text-foreground underline-offset-4 hover:text-accent-foreground hover:underline"
          >
            Create one
          </Link>
        </p>
      </CardFooter>
    </Card>
  );
}
