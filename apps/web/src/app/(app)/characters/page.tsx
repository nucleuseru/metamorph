import { RequireAuth } from "@/components/auth/require-auth";
import { CharactersView } from "@/components/characters/characters-view";

export default function CharactersPage() {
  return (
    <RequireAuth>
      <CharactersView />
    </RequireAuth>
  );
}
