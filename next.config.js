/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  webpack: (config) => {
    // yahoo-finance2 ships Deno-only test files inside esm/tests/. Exclude them.
    config.module = config.module || {};
    config.module.rules = config.module.rules || [];
    config.module.rules.push({
      test: /yahoo-finance2[\\/]esm[\\/]tests[\\/]/,
      use: "null-loader",
    });
    return config;
  },
};
module.exports = nextConfig;
