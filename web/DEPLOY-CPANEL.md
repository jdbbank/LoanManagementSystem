# Deploying the web app to cPanel

cPanel serves the built frontend with Apache; it does not use `nginx.conf` and cannot
apply that file's `/api` reverse proxy. Set the API URL before building so browser
requests go directly to the backend:

```powershell
$env:VITE_API_BASE_URL = "https://bioservice.jdbbank.com.la:12064/api"
npm run build -w web
```

Upload the **contents** of `web/dist` to the cPanel document root (for example,
`public_html`), including `index.html` and the `assets` folder. Put this `.htaccess`
in that same document root so direct navigation to frontend routes loads the SPA:

```apache
<IfModule mod_rewrite.c>
  RewriteEngine On
  RewriteBase /
  RewriteCond %{REQUEST_FILENAME} !-f
  RewriteCond %{REQUEST_FILENAME} !-d
  RewriteRule ^ index.html [L]
</IfModule>
```

After deployment, check the browser Network panel for `POST
https://bioservice.jdbbank.com.la:12064/api/auth/login`. It should return a JSON
response; an HTML response usually means the frontend was built without the API URL
or the request is reaching the cPanel document root instead of the backend. The
backend must be reachable over HTTPS from the browser.

For deployments that already proxy `/api` on the same origin (such as the Nginx
configuration), leave `VITE_API_BASE_URL` unset; the app continues to use `/api`.
