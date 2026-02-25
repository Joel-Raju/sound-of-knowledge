import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Full Next.js deployment - Vercel handles serverless functions
  compiler: {
    removeConsole: process.env.NODE_ENV === "production" ? {
      exclude: ["error", "warn"],
    } : false,
  },
};

export default nextConfig;
