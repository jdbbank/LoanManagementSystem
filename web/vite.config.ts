import react from '@vitejs/plugin-react';
import { defineConfig, loadEnv } from 'vite';

// Only `npm run dev:web` reads this server block; `vite build` ignores it, so the web image never sees it.
export default defineConfig(({ mode }) => {
  // Which machine hosts the API changes per developer, so it lives in web/.env.local (gitignored)
  // or the shell instead of being hardcoded here. Falls back to a backend running on this machine.
  const env = loadEnv(mode, process.cwd(), 'LMS_');
  const devApiTarget = env.LMS_DEV_API_URL ?? process.env.LMS_DEV_API_URL ?? 'http://127.0.0.1:4001';

  return {
    plugins: [react()],
    server: {
      port: 5173,
      // Security Headers สำหรับ Vite Dev Server (Production ให้ตั้งค่าที่ Nginx/Apache แทน)
      headers: {
        // ป้องกัน Clickjacking
        'X-Frame-Options': 'SAMEORIGIN',
        // ป้องกัน MIME-sniffing
        'X-Content-Type-Options': 'nosniff',
        // ควบคุม Referrer ที่ส่งออกไป
        'Referrer-Policy': 'strict-origin-when-cross-origin',
        // ปิดการเข้าถึง Browser APIs ที่ไม่จำเป็น
        'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
        // Content Security Policy สำหรับ Dev
        'Content-Security-Policy': [
          "default-src 'self'",
          "script-src 'self' 'unsafe-inline' 'unsafe-eval'", // unsafe-inline/eval จำเป็นสำหรับ Vite HMR ในช่วง Dev
          "worker-src 'self' blob:", // Vite dev error overlay creates a blob worker
          "media-src 'self' blob:", // ไฟล์ที่ fetch เข้ามาเป็น object URL ทั้งหมด
          "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com", // unsafe-inline จำเป็นสำหรับ MUI/Emotion, googleapis คือ <link rel=stylesheet> ใน index.html
          "img-src 'self' data: blob:", // รูป KYC/Avatar ถูก fetch ผ่าน /api แล้วแสดงด้วย blob: ไม่ใช่ http://
          "font-src 'self' data: https://fonts.gstatic.com",
          "connect-src 'self' ws:", // ws: สำหรับ HMR (port เลื่อนได้ถ้า 5173 ถูก) — /api always goes through the dev proxy, so 'self' already covers it
          "object-src 'none'",
          "frame-ancestors 'self'",
        ].join('; '),
      },
      proxy: {
        '/api': {
          target: devApiTarget,
          changeOrigin: true,
        },
      },
    },
  };
});
