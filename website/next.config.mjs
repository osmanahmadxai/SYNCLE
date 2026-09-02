/** @type {import('next').NextConfig} */
const nextConfig = {
  // fully static: `next build` emits ./out, which Vercel serves as plain files.
  // no server runtime, so nothing to keep warm and nothing to pay for.
  output: 'export',
  // the static export has no image optimizer behind it
  images: { unoptimized: true },
  reactStrictMode: true,
  poweredByHeader: false,
};
export default nextConfig;
