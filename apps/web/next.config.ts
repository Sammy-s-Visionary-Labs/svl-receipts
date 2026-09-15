import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Let Next.js compile our workspace packages (TypeScript source).
  transpilePackages: ["@svl/domain", "@svl/integrations"],
  redirects() {
    if (process.env.VERCEL_ENV !== "production") return [];
    return [
      {
        source: "/:path*",
        has: [{ type: "host", value: "svl-receipts-web-git-worker-web-app-svl1\\.vercel\\.app" }],
        destination: "https://svl-receipts-web.vercel.app/:path*",
        permanent: false,
      },
    ];
  },
};

export default nextConfig;
