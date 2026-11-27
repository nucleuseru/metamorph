"use client";

import { WarningCircleIcon } from "@phosphor-icons/react";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

import { GoogleButton } from "@/components/auth/google-button";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Spinner } from "@/components/ui/spinner";
import { authClient } from "@/lib/auth-client";

export function HomeAuthView() {
  const router = useRouter();
  const { data: session, isPending } = authClient.useSession();
  const [authError, setAuthError] = useState<string | null>(null);

  useEffect(() => {
    if (!isPending && session) {
      router.replace("/studio");
    }
  }, [isPending, session, router]);

  if (isPending || session) {
    return (
      <main className="relative flex min-h-svh flex-col items-center justify-center bg-background px-6 py-12">
        <Spinner className="size-6 text-muted-foreground" />
      </main>
    );
  }

  return (
    <div className="flex min-h-svh flex-col bg-background">
      <main className="flex flex-1 flex-col items-center justify-center px-6 py-12">
        <div className="flex w-full max-w-[440px] flex-col items-center gap-8 text-center">
          <div className="flex flex-col gap-3">
            <h1 className="text-4xl leading-[1.1] font-semibold tracking-[-1.2px] text-foreground sm:text-5xl">
              Metamorph
            </h1>
            <p className="text-base leading-[22.4px] font-medium text-muted-foreground">
              Transform your look and voice live on camera.
            </p>
          </div>

          <Card size="lg" className="w-full text-left">
            <CardHeader className="gap-1.5">
              <CardTitle>
                <h2>Get started</h2>
              </CardTitle>
              <CardDescription>
                Continue with your Google account to open the studio and start creating.
              </CardDescription>
            </CardHeader>

            <CardContent className="flex flex-col gap-4">
              {authError && (
                <Alert variant="destructive">
                  <WarningCircleIcon />
                  <AlertTitle>Sign in failed</AlertTitle>
                  <AlertDescription>{authError}</AlertDescription>
                </Alert>
              )}

              <GoogleButton onError={setAuthError} className="h-12 gap-2.5 px-5 text-[15px]" />
            </CardContent>

            <CardFooter className="justify-center">
              <p className="text-center text-xs text-muted-foreground">
                One account for everything — sign in or get started in one click.
              </p>
            </CardFooter>
          </Card>
        </div>
      </main>

      <footer className="px-6 py-6 text-center text-xs text-muted-foreground">
        Camera and microphone access are only asked when you start.
      </footer>
    </div>
  );
}
