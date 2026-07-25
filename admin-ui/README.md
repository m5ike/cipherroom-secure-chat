# M5cet admin GUI

Minimal static HTML/JS app that talks to the admin API at `/admin/*`. Bundled
as `admin-ui/public/index.html` so it can be served by either:

* the standalone admin Node service (`server/admin.ts`), or
* a separate Docker container (e.g. `nginx:alpine`) configured to proxy
  `/admin/*` to the admin API service.

The GUI stores its config (base URL + bearer token) in `localStorage` so it
can be hosted at a different origin. Authentication is **only** the bearer
token from `ADMIN_API_TOKEN`. Treat the GUI host like any other admin
console: protect it with TLS and IP/auth restrictions appropriate to your
deployment.

To customise, edit `public/index.html`. Build tooling is intentionally
omitted to keep the footprint small; replace with Vite/React if you need
a richer UX.
