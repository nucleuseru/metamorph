"use client";

import { CheckCircleIcon, WarningCircleIcon } from "@phosphor-icons/react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useState, type FormEvent } from "react";

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
import { Spinner } from "@/components/ui/spinner";
import { authClient, MAX_PASSWORD_LENGTH, MIN_PASSWORD_LENGTH } from "@/lib/auth-client";

interface FieldErrors {
  newPassword?: string;
  confirmPassword?: string;
}

export function ResetPasswordForm() {
  const searchParams = useSearchParams();
  const token = searchParams.get("token");
  const urlError = searchParams.get("error");

  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [isPending, setIsPending] = useState(false);
  const [isSuccess, setIsSuccess] = useState(false);

  if (urlError || !token) {
    return (
      <Card size="lg">
        <CardHeader className="gap-2">
          <CardTitle>Reset link unavailable</CardTitle>
          <CardDescription>This password reset link is invalid or has expired.</CardDescription>
        </CardHeader>

        <CardContent className="flex flex-col gap-6">
          <Alert variant="destructive">
            <WarningCircleIcon />
            <AlertTitle>Invalid or expired token</AlertTitle>
            <AlertDescription>Request a new password reset link to continue.</AlertDescription>
          </Alert>

          <Button
            size="lg"
            className="w-full"
            render={<Link href="/forgot-password" />}
            nativeButton={false}
          >
            Request a new link
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

  if (isSuccess) {
    return (
      <Card size="lg">
        <CardHeader className="gap-2">
          <div className="mb-1 flex size-10 items-center justify-center rounded-full bg-accent-soft text-accent-foreground">
            <CheckCircleIcon className="size-5" />
          </div>
          <CardTitle>Password updated</CardTitle>
          <CardDescription>
            Your password has been reset. You can now sign in with your new password.
          </CardDescription>
        </CardHeader>

        <CardContent>
          <Button size="lg" className="w-full" render={<Link href="/login" />} nativeButton={false}>
            Continue to sign in
          </Button>
        </CardContent>
      </Card>
    );
  }

  function validate(): FieldErrors {
    const errors: FieldErrors = {};
    if (newPassword.length < MIN_PASSWORD_LENGTH) {
      errors.newPassword = `Password must be at least ${MIN_PASSWORD_LENGTH} characters.`;
    } else if (newPassword.length > MAX_PASSWORD_LENGTH) {
      errors.newPassword = `Password must be at most ${MAX_PASSWORD_LENGTH} characters.`;
    }
    if (confirmPassword !== newPassword) {
      errors.confirmPassword = "Passwords do not match.";
    }
    return errors;
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFormError(null);

    const errors = validate();
    setFieldErrors(errors);
    if (Object.keys(errors).length > 0 || !token) {
      return;
    }

    setIsPending(true);
    try {
      const { error } = await authClient.resetPassword({
        newPassword,
        token,
      });

      if (error) {
        setFormError(error.message ?? "Unable to reset password.");
        return;
      }

      setIsSuccess(true);
    } catch {
      setFormError("Unable to reset password right now. Please try again.");
    } finally {
      setIsPending(false);
    }
  }

  return (
    <Card size="lg">
      <CardHeader className="gap-2">
        <CardTitle>Set new password</CardTitle>
        <CardDescription>Choose a new password for your Metamorph account.</CardDescription>
      </CardHeader>

      <CardContent className="flex flex-col gap-6">
        {formError && (
          <Alert variant="destructive">
            <WarningCircleIcon />
            <AlertTitle>Reset failed</AlertTitle>
            <AlertDescription>{formError}</AlertDescription>
          </Alert>
        )}

        <form onSubmit={handleSubmit} noValidate className="flex flex-col gap-6">
          <FieldGroup>
            <Field data-invalid={fieldErrors.newPassword ? true : undefined}>
              <FieldLabel htmlFor="reset-password">New password</FieldLabel>
              <PasswordInput
                id="reset-password"
                autoComplete="new-password"
                placeholder="Enter a new password"
                value={newPassword}
                onChange={(event) => {
                  setNewPassword(event.target.value);
                  if (fieldErrors.newPassword) {
                    setFieldErrors((prev) => ({ ...prev, newPassword: undefined }));
                  }
                }}
                aria-invalid={fieldErrors.newPassword ? true : undefined}
                disabled={isPending}
              />
              <FieldDescription>
                Must be at least {MIN_PASSWORD_LENGTH} characters.
              </FieldDescription>
              {fieldErrors.newPassword && <FieldError>{fieldErrors.newPassword}</FieldError>}
            </Field>

            <Field data-invalid={fieldErrors.confirmPassword ? true : undefined}>
              <FieldLabel htmlFor="reset-confirm-password">Confirm password</FieldLabel>
              <PasswordInput
                id="reset-confirm-password"
                autoComplete="new-password"
                placeholder="Repeat your new password"
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
            Update password
          </Button>
        </form>
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
