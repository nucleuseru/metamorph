"use client";

import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { authClient } from "@/lib/auth-client";
import { useStore } from "better-auth/react";
import { LoaderCircleIcon, User2Icon } from "lucide-react";
import { useActionState, useEffect } from "react";

export default function Header() {
  const { data, isPending } = useStore(authClient.useSession);

  const [, signIn, isSigningIn] = useActionState(async () => {
    await authClient.signIn.social({ provider: "google" });
  }, null);

  const [, signOut, isSigningOut] = useActionState(async () => {
    await authClient.signOut();
  }, null);

  const isLoading = isPending || isSigningIn || isSigningOut;

  return (
    <header>
      <div className="flex justify-between items-center p-4 max-w-6xl mx-auto">
        <h1 className="font-bold text-lg tracking-widest">Metamorph</h1>

        <DropdownMenu>
          <DropdownMenuTrigger>
            {isLoading ? (
              <LoaderCircleIcon className="size-8 p-1 animate-spin" />
            ) : (
              <Avatar key={data?.user.image ? "image" : "fallback"}>
                {data?.user.image && (
                  <AvatarImage src={data.user.image} alt="profile" />
                )}
                <AvatarFallback>
                  <User2Icon className="size-6" />
                </AvatarFallback>
              </Avatar>
            )}
          </DropdownMenuTrigger>
          <DropdownMenuContent asChild>
            <form>
              <DropdownMenuLabel>Account</DropdownMenuLabel>
              <DropdownMenuSeparator />
              <DropdownMenuItem>Add credit</DropdownMenuItem>
              <DropdownMenuSeparator />
              {data ? (
                <DropdownMenuItem
                  disabled={isLoading}
                  variant="destructive"
                  asChild
                >
                  <button className="w-full" formAction={signOut}>
                    Log out
                  </button>
                </DropdownMenuItem>
              ) : (
                <DropdownMenuItem disabled={isLoading} asChild>
                  <button className="w-full" formAction={signIn}>
                    Sign in
                  </button>
                </DropdownMenuItem>
              )}
            </form>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      <OneTapSignIn isLoading={isLoading} isAuthenticated={!!data} />
    </header>
  );
}

function OneTapSignIn({
  isLoading,
  isAuthenticated,
}: {
  isLoading: boolean;
  isAuthenticated: boolean;
}) {
  useEffect(() => {
    if (isLoading || isAuthenticated) return;

    // authClient.oneTap();
  }, [isLoading, isAuthenticated]);

  return null;
}
