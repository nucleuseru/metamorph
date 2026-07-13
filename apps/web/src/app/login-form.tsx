"use client";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { auth } from "@/lib/auth-client";
import {
  ArrowRight,
  Eye,
  EyeSlash,
  Spinner,
  Terminal,
} from "@phosphor-icons/react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";

export function LoginForm() {
  const router = useRouter();
  const [mode, setMode] = useState<"signin" | "signup">("signin");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    // Validation
    const trimmedUsername = username.trim();
    if (trimmedUsername.length < 3) {
      setError("Username must be at least 3 characters.");
      return;
    }
    if (password.length < 6) {
      setError("Password must be at least 6 characters.");
      return;
    }
    if (mode === "signup" && password !== confirmPassword) {
      setError("Passwords do not match.");
      return;
    }

    setIsLoading(true);
    const email = trimmedUsername.includes("@")
      ? trimmedUsername.toLowerCase()
      : `${trimmedUsername.toLowerCase()}@metamorph.local`;

    try {
      if (mode === "signin") {
        const res = await auth.signIn.username({
          password,
          username: trimmedUsername,
        });

        if (res.error) {
          setError(
            res.error.message ||
              "Failed to sign in. Please verify credentials.",
          );
          toast.error(res.error.message || "Authentication failed");
        } else {
          toast.success("System access granted. Redirecting...");
          router.push("/tts");
          router.refresh();
        }
      } else {
        const res = await auth.signUp.email({
          email,
          password,
          name: trimmedUsername,
          username: trimmedUsername,
        });

        if (res.error) {
          setError(res.error.message || "Failed to create account.");
          toast.error(res.error.message || "Registration failed");
        } else {
          toast.success("Account created successfully. Logging in...");
          router.push("/tts");
          router.refresh();
        }
      }
    } catch (err: any) {
      setError(err.message || "An unexpected error occurred.");
      toast.error(err.message || "Operation failed");
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div
      className="relative flex min-h-screen flex-col items-center justify-center bg-zinc-50 p-4 font-mono dark:bg-zinc-950"
      style={{
        backgroundImage:
          "radial-gradient(var(--color-border) 1px, transparent 1px)",
        backgroundSize: "24px 24px",
      }}
    >
      {/* Background soft glow decoration */}
      <div className="absolute top-1/4 left-1/2 -z-10 h-72 w-72 -translate-x-1/2 rounded-full bg-zinc-200/40 blur-3xl dark:bg-zinc-900/20" />

      <div className="w-full max-w-md border border-zinc-200 bg-white shadow-xl shadow-zinc-200/30 backdrop-blur-md dark:border-zinc-800 dark:bg-zinc-900/60 dark:shadow-none">
        {/* Terminal Title Bar */}
        <div className="flex items-center justify-between border-b border-zinc-200 bg-zinc-50 px-4 py-2.5 dark:border-zinc-800 dark:bg-zinc-900/40">
          <div className="flex items-center gap-1.5 font-mono text-[10px] font-bold tracking-wider text-zinc-400 uppercase">
            <Terminal className="size-3.5 text-zinc-500" />
            <span>METAMORPH SYSTEM ACCESS</span>
          </div>
          <div className="flex gap-1.5">
            <span className="size-2 rounded-full bg-zinc-200 dark:bg-zinc-800" />
            <span className="size-2 rounded-full bg-zinc-200 dark:bg-zinc-800" />
            <span className="size-2 rounded-full bg-zinc-200 dark:bg-zinc-800" />
          </div>
        </div>

        {/* Auth Mode Tabs */}
        <div className="flex border-b border-zinc-200 text-xs dark:border-zinc-800">
          <button
            type="button"
            onClick={() => {
              setMode("signin");
              setError(null);
            }}
            disabled={isLoading}
            className={`flex-1 py-3 text-center font-bold transition-all ${
              mode === "signin"
                ? "border-r border-zinc-200 bg-white text-zinc-900 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-50"
                : "border-r border-b border-zinc-200 bg-zinc-50/50 text-zinc-400 hover:bg-zinc-50 hover:text-zinc-600 dark:border-zinc-800 dark:bg-zinc-900/20 dark:text-zinc-600 dark:hover:bg-zinc-900/30 dark:hover:text-zinc-400"
            }`}
          >
            SIGN IN
          </button>
          <button
            disabled
            type="button"
            onClick={() => {
              setMode("signup");
              setError(null);
            }}
            className={`flex-1 py-3 text-center font-bold transition-all ${
              mode === "signup"
                ? "bg-white text-zinc-900 dark:bg-zinc-900 dark:text-zinc-50"
                : "border-b border-zinc-200 bg-zinc-50/50 text-zinc-400 hover:bg-zinc-50 hover:text-zinc-600 dark:border-zinc-800 dark:bg-zinc-900/20 dark:text-zinc-600 dark:hover:bg-zinc-900/30 dark:hover:text-zinc-400"
            }`}
          >
            CREATE ACCOUNT
          </button>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4 p-6">
          {error && (
            <div className="border border-red-200 bg-red-50/50 p-3 text-xs text-red-700 dark:border-red-900/30 dark:bg-red-950/20 dark:text-red-400">
              <div className="mb-0.5 font-bold">ERROR_LOG:</div>
              <div>{error}</div>
            </div>
          )}

          <div className="space-y-1.5">
            <Label
              htmlFor="username"
              className="text-[10px] font-bold tracking-wider text-zinc-500 uppercase"
            >
              Username
            </Label>
            <div className="relative">
              <span className="absolute top-2.5 left-3 text-xs text-zinc-400 select-none">{`>`}</span>
              <Input
                id="username"
                type="text"
                placeholder="Enter username"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                disabled={isLoading}
                className="h-9 border-zinc-200 pr-3 pl-7 hover:border-zinc-300 dark:border-zinc-800 dark:hover:border-zinc-700"
                required
              />
            </div>
          </div>

          <div className="space-y-1.5">
            <Label
              htmlFor="password"
              className="text-[10px] font-bold tracking-wider text-zinc-500 uppercase"
            >
              Password
            </Label>
            <div className="relative">
              <Input
                id="password"
                type={showPassword ? "text" : "password"}
                placeholder="••••••••"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                disabled={isLoading}
                className="h-9 border-zinc-200 pr-10 hover:border-zinc-300 dark:border-zinc-800 dark:hover:border-zinc-700"
                required
              />
              <button
                type="button"
                onClick={() => setShowPassword(!showPassword)}
                tabIndex={-1}
                className="absolute top-2.5 right-3 text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-200"
              >
                {showPassword ? (
                  <EyeSlash className="size-4" />
                ) : (
                  <Eye className="size-4" />
                )}
              </button>
            </div>
          </div>

          {mode === "signup" && (
            <div className="space-y-1.5">
              <Label
                htmlFor="confirm-password"
                className="text-[10px] font-bold tracking-wider text-zinc-500 uppercase"
              >
                Confirm Password
              </Label>
              <div className="relative">
                <Input
                  id="confirm-password"
                  type={showPassword ? "text" : "password"}
                  placeholder="••••••••"
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  disabled={isLoading}
                  className="h-9 border-zinc-200 pr-10 hover:border-zinc-300 dark:border-zinc-800 dark:hover:border-zinc-700"
                  required
                />
              </div>
            </div>
          )}

          <div className="pt-2">
            <Button
              type="submit"
              disabled={isLoading}
              className="flex h-9 w-full items-center justify-center gap-1.5 bg-zinc-900 text-xs font-bold tracking-wider text-zinc-50 uppercase transition-all hover:bg-zinc-800 dark:bg-zinc-50 dark:text-zinc-950 dark:hover:bg-zinc-200"
            >
              {isLoading ? (
                <>
                  <Spinner className="size-3.5 animate-spin" />
                  <span>PROCESSING...</span>
                </>
              ) : (
                <>
                  <span>
                    {mode === "signin" ? "AUTHENTICATE" : "REGISTER ACCOUNT"}
                  </span>
                  <ArrowRight className="size-3.5" />
                </>
              )}
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}
