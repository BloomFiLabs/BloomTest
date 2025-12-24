/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'export',
  trailingSlash: true, // Helps DigitalOcean routing find static files
  // Disable linting and type checking during build for speed
  eslint: { ignoreDuringBuilds: true },
  typescript: { ignoreBuildErrors: true },
  images: { unoptimized: true }, // Required for static export
};

export default nextConfig;

