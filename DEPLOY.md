# Deploying the Sereact teleoperation screening test

For the person hosting it. One container serves everything: the candidate page, the test itself
(one simulator process per candidate, started inside the container) and the admin page.

## The image

| Tag | When |
|---|---|
| `hand-teleop:v<version>-cpu` | the default |
| `hand-teleop:v<version>-gpu` | optional: an NVIDIA GPU speeds up the "track on our server" fallback for slow laptops (needs the NVIDIA container runtime) |

Built from the repository's `Dockerfile` (`docker build -t hand-teleop:cpu .`, or
`--build-arg VARIANT=gpu`). Version tags are built automatically by GitHub Actions into
`ghcr.io/thanuish/hand-teleop:v<version>-cpu` / `-gpu` (e.g. `v1.0.0-cpu`). Without a registry: `docker save` / `docker load` a `.tar`.

**As a file:** every version's GitHub Release has `hand-teleop-v<version>-cpu.tar.gz`
(about 0.5 GB; a `.sha256` next to it to check it arrived whole):

```bash
sha256sum -c hand-teleop-v1.0.1-cpu.tar.gz.sha256
docker load < hand-teleop-v1.0.1-cpu.tar.gz      # gives the image hand-teleop:v1.0.1-cpu
```

Then use `hand-teleop:v1.0.1-cpu` as the image name in the `docker run` below.

**From the registry:** it's private. To pull, sign in once with a GitHub account that can read the
repository, using a personal access token with the `read:packages` scope:

```bash
echo <token> | docker login ghcr.io -u <github-user> --password-stdin
docker pull ghcr.io/thanuish/hand-teleop:v1.0.1-cpu
```

## Run: one server, one address (the simplest)

On a server with Docker, at an address on Sereact's domain (e.g. `assessment.sereact.ai`):

1. In DNS, point the address at the server's IP. Open ports 80 and 443.
2. Copy `docker-compose.yml` and `Caddyfile` from the repository to the server, and next to them a
   file `.env`:
   ```
   SITE=assessment.sereact.ai
   ADMIN_PASSWORD=<a long random password>
   VERSION=v1.0.2
   MAX_CONCURRENT=15
   ```
3. Sign in to the registry once (see above), then `docker compose up -d`.

Caddy gets the https certificate by itself and passes the websockets on, so nothing below
("The load balancer") needs doing by hand. Candidates open `https://assessment.sereact.ai`, the
admin page is `https://assessment.sereact.ai/admin`. To update: change `VERSION` in `.env`, then
`docker compose pull && docker compose up -d` (after draining, see "Updating").

## Run: the container alone (behind a load balancer you already have)

```bash
docker run -d --name teleop --restart unless-stopped \
  -p 8000:8000 \
  -v teleop-data:/data \
  -e PUBLIC_URL=https://teleop.sereact.ai \
  -e ADMIN_USER=admin -e ADMIN_PASSWORD='<a long random password>' \
  -e MAX_CONCURRENT=25 \
  ghcr.io/thanuish/hand-teleop:v1.0.1-cpu      # (or hand-teleop:v1.0.1-cpu after docker load)
```

GPU variant: add `--gpus all` and use the `-gpu` tag.

| Variable | Meaning | Default |
|---|---|---|
| `PUBLIC_URL` | the site's address (shown on the admin page, used in links) | – |
| `ADMIN_USER`, `ADMIN_PASSWORD` | sign-in for `/admin` (HTTP Basic, over the load balancer's https). In the container it always asks, from anywhere; without a password the admin page is closed. | `admin`, – |
| `MAX_CONCURRENT` | tests at the same time (first start; then the admin page's setting) | 15 |
| `DATA_DIR` | where state lives | `/data` |
| `PORT`, `HOST` | the listening address | `8000`, `0.0.0.0` |
| `SCREEN_CONFIG` | another test configuration file (mount it), instead of the built-in `config/screening.toml` | – |

## State: the volume

`/data` holds everything that matters:
- the candidates database (SQLite);
- the results and recordings of every test.

Mount a persistent volume there and **back it up** (daily, and before each update). Everything else in the container is replaced by an update.

## The load balancer

- **HTTPS is required:** browsers only give a page the camera on https. TLS ends at the load balancer; the container speaks plain http on 8000.
- **WebSockets:** the robot streams live over websockets (`/s/<id>/ws`, `/s/<id>/track`). Allow the upgrade, and set the **idle timeout to at least 30 minutes** (a test takes about 20).
- **One container:** each candidate's simulator runs inside the container that started it, so all of a candidate's requests must reach the same container. Run one container and size the machine. For more than one, every request for `/play/<id>`, `/s/<id>/…`, `/h/<id>` must be routed sticky.
- **Health check:** `GET /healthz` returns 200 with `{"ok": true, "running": n, "capacity": m, "accepting": true}`.
- **Pass through** `X-Forwarded-For` and `X-Forwarded-Proto`. Without them the app can't tell that a request came through the load balancer, so it would treat it as local.
- **Outbound internet** from candidates' browsers to `cdn.jsdelivr.net` and `storage.googleapis.com` (the hand-tracking model loads from there).

## Size

About **1 CPU core and 1 GB of RAM per candidate testing at the same time**, plus 2 cores and
2 GB for the rest (a simulator measured 0.8 GB, up to 1.8 GB while it starts). For 10 at once:
8–12 vCPU, 16 GB; for 30: 32 vCPU, 32 GB. Set `MAX_CONCURRENT` to what the machine holds: a
candidate over it is asked to wait instead of the test failing. Disk: about 10 MB per minute of a
test (recordings). Pick a region near the candidates (e.g. Frankfurt): the distance adds to the lag.

## Updating

Each candidate's test runs inside the container, so stopping the container ends the tests running in it.

1. Admin page → Settings → untick **Accept new candidates**. The link now says "back in a few minutes"; running tests go on.
2. Wait until the admin page shows nobody **in progress** (at most ~25 minutes).
3. `docker pull` the new version, then `docker stop teleop && docker rm teleop`, then the same `docker run` with the new tag (same volume).
4. Tick **Accept new candidates** again.

Rollback: the same `docker run` with the previous tag (the volume is untouched).

## Logs

The lobby logs to stdout (`docker logs teleop`). Each test's simulator log is in its folder under `/data`. Each candidate's report on the admin page lists their files.
