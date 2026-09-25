import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // The panel is reached through nginx at https://jamasp.mkagent.co.
  // Server Actions reject POSTs whose Origin doesn't match the forwarded
  // host, so the public hostname has to be declared explicitly — otherwise
  // pages render fine and every mutating button fails.
  //
  // jamasp.mahdanian.xyz was the original hostname and now only 301s to the
  // one above, so nothing should POST from it. It stays listed for the
  // transition: a page loaded before the cutover still carries the old
  // Origin, and browsers do not reliably follow a 301 for a POST, so without
  // it that already-open tab's buttons fail with nothing in the log to
  // explain why. Safe to drop once no such tab can plausibly be open.
  experimental: {
    serverActions: {
      allowedOrigins: ["jamasp.mkagent.co", "jamasp.mahdanian.xyz"],
    },
  },
  // Dev-only, no effect on `next start`: the fixture webServer (and the
  // Playwright config's baseURL) both address the dev server as
  // 127.0.0.1, which Next.js treats as a different origin from the
  // "localhost" it was initialized with. Left unset, dev-only requests
  // from that origin — the HMR websocket, and critically the client
  // runtime's own hydration handshake — are silently blocked: pages still
  // render (the SSR HTML arrives fine), but React never attaches, so
  // every click-driven test (the More sheet, the theme toggle) fails with
  // no console error to point at. Discovered because mobile.spec.ts is the
  // first E2E spec that clicks anything.
  allowedDevOrigins: ["127.0.0.1"],
};

export default nextConfig;
