import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  typedRoutes: true,
  reactCompiler: true,
  experimental: {
    typedEnv: true,
  },
  allowedDevOrigins: ["10.79.162.200"],
};

export default nextConfig;
