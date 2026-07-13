FROM public.ecr.aws/docker/library/gcc:13-bookworm@sha256:930f2ebe239275fa67226654cb79273ea34eee672ae61c8a39f689c37fb7ac5c

LABEL org.opencontainers.image.title="Textile Feature Store Migration"
LABEL org.opencontainers.image.description="C++ SQLite migration for textile defect classifier feature store"
LABEL org.opencontainers.image.version="1.0.0"
LABEL org.opencontainers.image.licenses="MIT"

# Install system dependencies
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        asciinema \
        ca-certificates \
        imagemagick \
        libsqlite3-dev \
        libssl-dev \
        make \
        python3 \
        python3-pip \
        sqlite3 \
        tmux \
    && rm -rf /var/lib/apt/lists/*

# Install Python packages for verifier
RUN python3 -m pip install --no-cache-dir --break-system-packages \
    pytest==8.4.1 \
    pytest-json-ctrf==0.3.5

WORKDIR /app

# Copy application files
COPY app/docs /app/docs
COPY app/src /app/src
COPY app/Makefile /app/Makefile
COPY app/legacy/init_legacy_db.py /app/legacy/init_legacy_db.py
COPY app/images/init_images.py /app/images/init_images.py

# Initialize legacy database and images
RUN python3 /app/legacy/init_legacy_db.py \
    && python3 /app/images/init_images.py

# Create output directory
RUN mkdir -p /app/output /app/bin
