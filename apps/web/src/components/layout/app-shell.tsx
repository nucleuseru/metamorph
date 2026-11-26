"use client";

import { BroadcastIcon, MaskHappyIcon, SignOutIcon } from "@phosphor-icons/react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState, type ReactNode } from "react";

import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { useActiveSession } from "@/hooks/use-api";
import { authClient } from "@/lib/auth-client";
import { cn } from "@/lib/utils";

const NAV_ITEMS = [
  { href: "/studio", label: "Studio", icon: BroadcastIcon },
  { href: "/characters", label: "Characters", icon: MaskHappyIcon },
] as const;

export function AppShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const { data: session, isPending } = authClient.useSession();
  const { data: activeSession } = useActiveSession(Boolean(session));
  const [isSigningOut, setIsSigningOut] = useState(false);

  useEffect(() => {
    if (!isPending && !session) {
      router.replace("/");
    }
  }, [isPending, session, router]);

  async function handleSignOut() {
    setIsSigningOut(true);
    try {
      await authClient.signOut();
      router.replace("/");
    } finally {
      setIsSigningOut(false);
    }
  }

  return (
    <div className="relative flex min-h-svh flex-col bg-background text-foreground">
      <header className="sticky top-0 z-40 border-b border-border bg-background/95 backdrop-blur-sm">
        <div className="mx-auto flex h-16 max-w-6xl items-center justify-between gap-4 px-4 sm:px-6 lg:px-8">
          <div className="flex items-center gap-6 lg:gap-8">
            <Link
              href="/studio"
              className="text-lg font-semibold tracking-[-0.03em] text-foreground transition-colors hover:text-accent-foreground"
            >
              Metamorph
            </Link>

            <nav aria-label="Primary" className="flex items-center gap-4 sm:gap-6">
              {NAV_ITEMS.map(({ href, label, icon: Icon }) => {
                const isActive = pathname === href || pathname.startsWith(`${href}/`);
                const showLiveDot = href === "/studio" && Boolean(activeSession);
                return (
                  <Link
                    key={href}
                    href={href}
                    className={cn(
                      "inline-flex items-center gap-1.5 py-1 text-xs leading-4 transition-colors",
                      isActive
                        ? "font-semibold text-foreground"
                        : "font-normal text-muted-foreground hover:text-foreground",
                    )}
                  >
                    <Icon className={cn("size-4", isActive && "text-primary")} />
                    <span>{label}</span>
                    {showLiveDot ? (
                      <span
                        aria-label="Live session active"
                        className="size-2 animate-pulse rounded-full bg-primary"
                      />
                    ) : null}
                  </Link>
                );
              })}
            </nav>
          </div>

          <div className="flex items-center gap-3">
            {session ? (
              <>
                <span className="hidden text-xs font-medium text-muted-foreground md:inline">
                  {session.user.name || session.user.email}
                </span>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  disabled={isSigningOut}
                  onClick={handleSignOut}
                >
                  {isSigningOut ? (
                    <Spinner data-icon="inline-start" />
                  ) : (
                    <SignOutIcon data-icon="inline-start" />
                  )}
                  <span className="hidden sm:inline">Sign out</span>
                </Button>
              </>
            ) : null}
          </div>
        </div>
      </header>

      <main className="relative z-10 mx-auto w-full max-w-6xl flex-1 px-4 py-8 sm:px-6 sm:py-10 lg:px-8">
        {children}
      </main>
    </div>
  );
}
