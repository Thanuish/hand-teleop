# The screening test as one container: the lobby (sign-up, admin, one simulator process per
# candidate) on port 8000. Results, the candidates database and recordings go to /data: mount
# a volume there. See DEPLOY.md.
#
#   docker build -t hand-teleop:cpu .
#   docker build -t hand-teleop:gpu --build-arg VARIANT=gpu .     (server-side hand tracking on an NVIDIA GPU)
#   docker run -p 8000:8000 -v teleop-data:/data -e PUBLIC_URL=https://... -e ADMIN_PASSWORD=... hand-teleop:cpu
FROM python:3.12-slim

ARG VARIANT=cpu

# MediaPipe (server-side hand tracking) needs OpenGL / EGL libraries even on the CPU; the GPU
# variant gets the NVIDIA driver's own through the NVIDIA container runtime
RUN apt-get update && apt-get install -y --no-install-recommends \
        libgl1 libegl1 libgles2 libglib2.0-0 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .
# built in: the hand-tracking model for the server fallback, the generated textures
RUN python -c "from TEST_TELEOP.tracker import ensure_model; ensure_model()" \
    && python -c "import TEST_TELEOP; from vrteleop import scene as S; S.build_scene('screen')" \
    && python -m TEST_TELEOP.check_config

# not root; /data belongs to it
RUN useradd --create-home --uid 10001 app && mkdir -p /data && chown -R app /data /app/assets/generated /app/config
USER app

ENV HOST=0.0.0.0 PORT=8000 DATA_DIR=/data ADMIN_LOCAL_OPEN=0 \
    TRACKER_DELEGATE=${VARIANT} \
    NVIDIA_DRIVER_CAPABILITIES=compute,utility,graphics \
    PYTHONUNBUFFERED=1
VOLUME ["/data"]
EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
    CMD python -c "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8000/healthz', timeout=4).status == 200 else 1)"

CMD ["python", "-m", "TEST_TELEOP.lobby", "serve"]
