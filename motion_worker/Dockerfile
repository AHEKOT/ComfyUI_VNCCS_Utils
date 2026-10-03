# Isolated motion worker image. Build from the extension folder:
#   docker build -f motion_worker/Dockerfile --build-arg FAMILY=ardy -t vnccs-motion-ardy .
FROM pytorch/pytorch:2.5.1-cuda12.4-cudnn9-devel
ARG FAMILY=ardy
RUN apt-get update && apt-get install -y --no-install-recommends git git-lfs cmake build-essential \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY motion_worker/requirements /app/motion_worker/requirements
RUN pip install --no-cache-dir "setuptools<81" wheel \
    && pip install --no-cache-dir --no-build-isolation -r /app/motion_worker/requirements/${FAMILY}.txt
COPY api/text_to_motion /app/api/text_to_motion
COPY config/motion_models /app/config/motion_models
COPY motion_worker/worker.py /app/motion_worker/worker.py
ENV FAMILY=${FAMILY} HF_HOME=/hf HOME=/hf PYTHONUNBUFFERED=1
CMD ["sh", "-c", "python /app/motion_worker/worker.py --family $FAMILY --root /data"]
