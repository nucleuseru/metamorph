import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  typedRoutes: true,
  reactCompiler: true,
  experimental: {
    typedEnv: true,
    serverActions: {
      bodySizeLimit: "10mb",
    },
  },
  allowedDevOrigins: ["10.79.162.200"],
};

export default nextConfig;
