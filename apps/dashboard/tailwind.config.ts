import type { Config } from 'tailwindcss';

const config: Config = {
  content: ['./src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        navy: {
          DEFAULT: '#0f1a2e',
          light: '#1a2742',
        },
        cream: {
          DEFAULT: '#faf6f1',
          warm: '#f5ede4',
        },
        orange: {
          DEFAULT: '#f97316',
          deep: '#ea580c',
        },
        severity: {
          critical: '#dc2626',
          high: '#f97316',
          medium: '#eab308',
          low: '#3b82f6',
        },
        'severity-bg': {
          critical: '#fef2f2',
          high: '#fff7ed',
          medium: '#fefce8',
          low: '#eff6ff',
        },
        status: {
          success: '#10b981',
          fixing: '#eab308',
          failed: '#dc2626',
          open: '#6b7280',
          wontfix: '#94a3b8',
        },
        border: {
          DEFAULT: '#e8e0d6',
          light: '#f0ebe4',
        },
        'gray-text': '#6b7280',
        'gray-muted': '#94a3b8',
      },
    },
  },
  plugins: [],
};

export default config;
