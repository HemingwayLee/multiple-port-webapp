# multiple-port-webapp

Several webapps behind one nginx (HTTPS on 443) sharing one PostgreSQL container. Each webapp is a React (Vite)
frontend plus a FastAPI backend, each on its own port, each with its own database. Everything hot reloads.

```
browser ── https://host:443 ──► nginx ─┬─ /            landing page (nginx/html)
                                       ├─ /app1/api/*  ► app1-backend:8101  (/api/*)  ─┐
                                       ├─ /app1/*      ► app1-frontend:5101            ├─► db:5432  database app1
                                       ├─ /app2/api/*  ► app2-backend:8102  (/api/*)  ─┤
                                       └─ /app2/*      ► app2-frontend:5102            └─► db:5432  database app2
```

## Run

```bash
cp .env.example .env     # optional, all values have defaults
docker compose -f docker-compose.dev.yml up --build
```

| What           | URL                                   |
| -------------- | ------------------------------------- |
| Landing page   | https://localhost/                    |
| App 1          | https://localhost/app1/               |
| App 1 API docs | https://localhost/app1/api/docs       |
| App 2          | https://localhost/app2/               |
| App 2 API docs | https://localhost/app2/api/docs       |
| Postgres       | localhost:5432 (postgres/postgres; app1/app1 → db app1; app2/app2 → db app2) |

http://localhost redirects to HTTPS. Locally the certificate is self-signed (generated into `nginx/certs/` on first
`up`), so the browser warns once. For a trusted local cert, create one with
[mkcert](https://github.com/FiloSottile/mkcert) as `nginx/certs/fullchain.pem` and `nginx/certs/privkey.pem`.

For debugging, each service is also published on 127.0.0.1 only: frontends at http://localhost:5101/app1/ and
http://localhost:5102/app2/ (Vite proxies their API the same way nginx does), backends at :8101 and :8102.

## How it works

- **Routing is by path.** Each app owns a prefix (`/app1/`). Vite runs with `base: "/app1/"`, so its pages,
  assets and HMR websocket all live under it and nginx passes them through unchanged. Requests to `/app1/api/*`
  have the prefix stripped and go to the backend as `/api/*`. Config: `nginx/conf.d/default.conf` (TLS, headers,
  websocket upgrade) and one file per app in `nginx/apps/`.
- **Frontend code must not hard-code `/`.** Build URLs from `import.meta.env.BASE_URL` (see `src/api.js`). If you
  add React Router, use `<BrowserRouter basename={import.meta.env.BASE_URL}>`.
- **Backends** keep all routes under `/api`. `ROOT_PATH=/app1` only tells FastAPI its public prefix so
  `/app1/api/docs` loads the right `openapi.json`. Uvicorn trusts nginx's `X-Forwarded-*` headers.
- **One Postgres, one database per app.** `db-init` runs `db/create-databases.sh` on every `up`: for each
  `name:password` in `APP_DATABASES` it creates a login role and a database it owns (skipping existing ones) and
  revokes `CONNECT` from everyone else, so app1's credentials can't open app2's database. Tables are created by
  each backend on startup.
- nginx resolves the app containers per request (Docker DNS), so it starts even if an app is down and keeps
  working after an app container restarts.

## Add a webapp (e.g. app3)

1. `cp -R apps/app1 apps/app3`, then replace `app1`/`5101`/`8101` with `app3`/`5103`/`8103` in its
   `frontend/package.json`, `frontend/vite.config.js` and `frontend/index.html`.
2. `docker-compose.dev.yml`: copy the two `app1-*` services as `app3-*` (ports, `APP_NAME`, `ROOT_PATH`,
   `BASE_PATH`, `API_PROXY_TARGET`, `DATABASE_URL`) and add `app3:${APP3_DB_PASSWORD:-app3}` to `APP_DATABASES`.
3. `cp nginx/apps/app1.conf nginx/apps/app3.conf` and replace the names and ports. Add a link in `nginx/html/index.html`.
4. `docker compose -f docker-compose.dev.yml up --build -d` (db-init creates the new database; no reset needed).

## On a server

- Point DNS at the server and put real certificates at `nginx/certs/fullchain.pem` and `privkey.pem` (e.g. copy
  or mount Let's Encrypt's `live/<domain>/` files). Reload with `docker compose exec nginx nginx -s reload`.
- Set strong `POSTGRES_PASSWORD` and `APPn_DB_PASSWORD` values in `.env` before the first start.
- This is a **dev** stack (Vite dev server, uvicorn `--reload`). For production, build the frontends
  (`vite build`) and serve `dist/` from nginx, and run uvicorn without `--reload`.

## Development

Edit `apps/<app>/frontend/src` (Vite HMR, through nginx too) or `apps/<app>/backend/app` (uvicorn `--reload`).

After changing dependencies (`package.json` or `requirements.txt`), rebuild with a fresh `node_modules` volume:

```bash
docker compose -f docker-compose.dev.yml up --build -V
```

Reset all databases: `docker compose -f docker-compose.dev.yml down -v`
