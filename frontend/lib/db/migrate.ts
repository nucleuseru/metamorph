import "@/lib/env-config";

import { migrate } from "drizzle-orm/neon-http/migrator";
import path from "node:path";
import { db } from ".";

migrate(db, {
  migrationsFolder: path.join(process.cwd(), "drizzle"),
});
