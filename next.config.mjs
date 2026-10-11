/** @type {import('next').NextConfig} */
const nextConfig = {
  // Lets a production build run beside a dev server (NEXT_DIST_DIR=.next-build npm run build).
  distDir: process.env.NEXT_DIST_DIR || ".next",
  // The dashboard only reads files the worker writes; keep native modules out of the bundle.
  serverExternalPackages: ["onnxruntime-node", "sharp", "spectrum-ts"],
  outputFileTracingExcludes: { "*": ["data/**", "replay/**", "models/**"] },
};
export default nextConfig;
