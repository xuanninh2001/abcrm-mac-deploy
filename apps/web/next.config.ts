import type { NextConfig } from "next";

const config: NextConfig = {
  // The browser only talks to this app; API calls go server-side to ABCRM_API_URL with the session's token.
  poweredByHeader: false,
  reactStrictMode: true,
  async headers() {
    return [{
      source: "/:path*",
      headers: [
        { key: "X-Frame-Options", value: "DENY" },
        { key: "X-Content-Type-Options", value: "nosniff" },
        { key: "Referrer-Policy", value: "same-origin" },
      ],
    }];
  },
};
export default config;
