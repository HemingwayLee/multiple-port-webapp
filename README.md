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
| pgweb (optional, see below) | http://localhost:8081, or https://localhost/pgweb/ with `PGWEB_VIA_HTTPS=true` |

http://localhost redirects to HTTPS. Locally the certificate is self-signed (generated into `nginx/certs/` on first
`up`), so the browser warns once. For a trusted local cert, create one with
[mkcert](https://github.com/FiloSottile/mkcert) as `nginx/certs/fullchain.pem` and `nginx/certs/privkey.pem`.

For debugging, each service is also published on 127.0.0.1 only: frontends at http://localhost:5101/app1/ and
http://localhost:5102/app2/ (Vite proxies their API the same way nginx does), backends at :8101 and :8102.

## Database browser (pgweb, optional)

[pgweb](https://github.com/sosedoff/pgweb) lives in its own compose file and project (`multiple-port-webapp-pgweb`)
that joins the main stack's network (`multiple-port-webapp`), so it can be started and stopped without touching the apps:

```bash
docker compose -f docker-compose.dev.yml up -d       # main stack first (it creates the network)
docker compose -f docker-compose.pgweb.yml up -d     # http://localhost:8081
docker compose -f docker-compose.pgweb.yml down      # stop pgweb only
```

It connects as the Postgres superuser to `postgres`; pick `app1`/`app2` from its database menu. A small nginx
(`tools/pgweb/`) sits in front of it and adds `custom/json-viewer.js` (pretty-printed JSON in the cell popup). Port
8081 is bound to 127.0.0.1 because pgweb has no login; on a server, reach it with an SSH tunnel (`ssh -L 8081:localhost:8081`).

To also open it from the main site at https://localhost/pgweb/, set `PGWEB_VIA_HTTPS=true` in `.env` and restart
pgweb (`docker compose -f docker-compose.pgweb.yml up -d`). Port 443 listens on all interfaces, so anyone who can
reach this machine gets superuser access to the database: unless it's only your laptop, also set `PGWEB_AUTH_USER` /
`PGWEB_AUTH_PASS` (HTTP basic auth, applies to both ports). With the setting off, /pgweb/ returns 404; with pgweb
stopped, 503.

Stop pgweb before `docker compose -f docker-compose.dev.yml down`, otherwise the network can't be removed while
pgweb is still attached.

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

A new app is a copy of `apps/app1` plus four small config edits: compose services, a database, an nginx route and a
landing page entry. The example uses `app3` with frontend port **5103** and backend port **8103**. Pick ports that
no other app uses. Run the commands from the repo root.

### 1. Copy the code

```bash
rsync -a --exclude node_modules apps/app1/ apps/app3/
grep -rlE 'app1|App 1|5101|8101' apps/app3 | xargs perl -pi -e 's/app1/app3/g; s/App 1/App 3/g; s/5101/5103/g; s/8101/8103/g'
```

That renames the app in the frontend (`package.json` name, page `<title>`, heading in `src/App.jsx`) and the
fallback base path and ports in `frontend/vite.config.js`. Docker Compose sets the actual values (step 2).

- **Frontend** (`apps/app3/frontend`): build every URL from `import.meta.env.BASE_URL`, as `src/api.js` does. Never start a path with `/`.
- **Backend** (`apps/app3/backend`): needs no edits. `APP_NAME`, `ROOT_PATH`, `PORT` and `DATABASE_URL` come
  from compose. Keep its routes under `/api`. Tables in `app/models.py` are created on startup, in app3's own
  database.

### 2. Add the services to `docker-compose.dev.yml`

Add these two services next to the `app1`/`app2` ones. Only the names, ports and paths differ from app1:

```yaml
  # ---------------------------------------------------------------- app3
  app3-backend:
    build:
      context: ./apps/app3/backend
      dockerfile: Dockerfile.dev
    environment:
      <<: *backend-env
      PORT: "8103"
      APP_NAME: app3
      ROOT_PATH: /app3
      DATABASE_URL: postgresql+psycopg://app3:${APP3_DB_PASSWORD:-app3}@db:5432/app3
    ports:
      - "127.0.0.1:8103:8103"
    volumes:
      - ./apps/app3/backend:/app
    depends_on:
      db-init:
        condition: service_completed_successfully

  app3-frontend:
    build:
      context: ./apps/app3/frontend
      dockerfile: Dockerfile.dev
    environment:
      <<: *frontend-env
      PORT: "5103"
      BASE_PATH: /app3/
      API_PROXY_TARGET: http://app3-backend:8103
    ports:
      - "127.0.0.1:5103:5103"
    volumes:
      - ./apps/app3/frontend:/app
      - /app/node_modules
    depends_on:
      - app3-backend
```

### 3. Give it a database

In the same file, add a line to `APP_DATABASES` under `db-init`:

```yaml
      APP_DATABASES: >-
        app1:${APP1_DB_PASSWORD:-app1}
        app2:${APP2_DB_PASSWORD:-app2}
        app3:${APP3_DB_PASSWORD:-app3}
```

Add `APP3_DB_PASSWORD=app3` to `.env.example` (and to `.env` if you have one). On a server, use a strong password.
`db-init` creates the `app3` role and database on the next `up`, without touching existing data.

### 4. Route it in nginx

```bash
perl -pe 's/app1/app3/g; s/5101/5103/g; s/8101/8103/g' nginx/apps/app1.conf > nginx/apps/app3.conf
```

This sends `/app3/api/*` to `app3-backend:8103` with the `/app3` prefix removed, and everything else under `/app3/`
to `app3-frontend:5103`.

### 5. Add it to the landing page

In `nginx/html/index.html`, add an entry to `APPS`. It gets a card with frontend and backend checks and a Go button:

```js
const APPS = [
  { name: "App 1", path: "/app1/", kind: "webapp" },
  { name: "App 2", path: "/app2/", kind: "webapp" },
  { name: "App 3", path: "/app3/", kind: "webapp" },
  { name: "pgweb", path: "/pgweb/", kind: "pgweb" },
];
```

### 6. Start it

```bash
docker compose -f docker-compose.dev.yml up --build -d          # builds app3, db-init creates its database
docker compose -f docker-compose.dev.yml exec nginx nginx -s reload   # nginx only reads apps/*.conf when it (re)loads
```

The rest of the stack keeps running, and no database reset is needed.

### 7. Check it

- https://localhost/: the App 3 card shows **OK** for Frontend and Backend. **Go** opens it.
- https://localhost/app3/api/health returns `{"status": "ok", "app": "app3", "database": "app3", ...}`.
- https://localhost/app3/api/docs: the FastAPI docs.
- Direct, for debugging: http://localhost:5103/app3/ (frontend) and http://localhost:8103/api/health (backend).
- pgweb: `app3` appears in its database menu.

If the card shows 502 or 504, look at `docker compose -f docker-compose.dev.yml logs app3-frontend app3-backend`.
If `/app3/` returns the landing page or a 404, nginx hasn't been reloaded (step 6).

Optionally, add app3 to the diagram and the URL table at the top of this README.

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
