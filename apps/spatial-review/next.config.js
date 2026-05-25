const path = require("path");

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Pin tracing root so Next.js doesn't see the parent code-lens-aI lockfile
  // and warn about multiple workspaces. This app intentionally has its own
  // package.json — it's a separate runtime from the CLI.
  outputFileTracingRoot: path.join(__dirname),
};

module.exports = nextConfig;
