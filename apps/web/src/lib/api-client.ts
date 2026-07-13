import "client-only";

import { createApi } from "@/lib/axios";

export const api = createApi({
  timeout: 10000,
});
