import { isAuthenticated } from "@/lib/auth-server";
import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { LoginForm } from "./login-form";

export const metadata: Metadata = {
  title: "Access Portal | Metamorph",
  description: "Authenticate to access the Metamorph Synthesizer portal.",
};

export default async function LoginPage() {
  const authenticated = await isAuthenticated();

  if (authenticated) {
    redirect("/tts");
  }

  return <LoginForm />;
}
