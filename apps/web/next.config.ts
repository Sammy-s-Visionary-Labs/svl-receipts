import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Let Next.js compile our workspace packages (TypeScript source).
  transpilePackages: ["@svl/domain", "@svl/integrations"],
  serverExternalPackages: ["mailparser", "pdfjs-dist", "@napi-rs/canvas"],
  outputFileTracingIncludes: {
    "/api/email-imports{,/**/*}": [
      "./assets/fonts/**/*",
      "../../node_modules/pdfjs-dist/**/*",
      "../../node_modules/@napi-rs/**/*",
    ],
    "/api/admin/email-imports/**/*": [
      "./assets/fonts/**/*",
      "../../node_modules/pdfjs-dist/**/*",
      "../../node_modules/@napi-rs/**/*",
    ],
    "/api/cron/email-imports": [
      "./assets/fonts/**/*",
      "../../node_modules/pdfjs-dist/**/*",
      "../../node_modules/@napi-rs/**/*",
    ],
  },
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
