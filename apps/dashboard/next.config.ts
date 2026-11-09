import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  output: 'standalone',
  transpilePackages: ['@sutura/common'],
  // pg, @node-rs/argon2, and nodemailer ship native bindings or use dynamic
  // requires; exclude them from Next's server bundler so they're loaded at
  // runtime from node_modules.
  serverExternalPackages: ['pg', '@node-rs/argon2', 'nodemailer'],
};

export default nextConfig;
