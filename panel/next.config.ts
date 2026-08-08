import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // The panel is reached through nginx at https://jamasp.mahdanian.xyz.
  // Server Actions reject POSTs whose Origin doesn't match the forwarded
  // host, so the public hostname has to be declared explicitly — otherwise
  // pages render fine and every mutating button fails.
  experimental: {
    serverActions: {
      allowedOrigins: ["jamasp.mahdanian.xyz"],
    },
  },
};

export default nextConfig;
