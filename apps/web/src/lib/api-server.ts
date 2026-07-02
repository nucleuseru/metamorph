import "server-only";

import { createTypedApi } from "./utils";

const RUNPOD_API_URL = process.env.RUNPOD_API_URL;
const RUNPOD_API_KEY = process.env.RUNPOD_API_KEY;

if (!RUNPOD_API_URL) {
  throw new Error("RUNPOD_API_URL must be defined");
}

if (!RUNPOD_API_KEY) {
  throw new Error("RUNPOD_API_KEY must be defined");
}

export const runpodApi = createTypedApi({
  baseURL: RUNPOD_API_URL,
  headers: {
    Authorization: `Bearer ${RUNPOD_API_KEY}`,
  },
});
