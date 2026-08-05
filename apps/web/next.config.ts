import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Let Next.js compile our workspace packages (TypeScript source).
  transpilePackages: ["@svl/domain", "@svl/integrations"],
};

export default nextConfig;
