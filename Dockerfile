# Description: Dockerfile for building Sitrec

# This is a multi-stage build
# The first stage is to build the app, using Node.js, version 22
FROM node:22 AS build

# Set the working directory to /build
# copy the needed files and run npm install
# in build/dist
WORKDIR /build

COPY assets ./assets
COPY data ./data
COPY src ./src
COPY docs ./docs
COPY tools ./tools
COPY scripts ./scripts
COPY sitrecServer ./sitrecServer
COPY package.json .
COPY package-lock.json .
COPY webpack.*.js .
COPY webpackCopyPatterns.js .
COPY config ./config
COPY docker/docker-config-install.js ./config/config-install.js
# For fresh clones: copy .example templates to live names if missing
RUN cp -n config/shared.env.example config/shared.env; \
    cp -n config/config.js.example config/config.js; \
    cp -n config/config.php.example config/config.php; \
    true
COPY .git .git
COPY apple-touch-icon.png .
COPY favicon-512.png .
COPY favicon-32x32.png .
COPY favicon-16x16.png .
COPY site.webmanifest .


# We don't want Puppeteer to try to download anything, as it can give errors on some systems
# and we don't run the regression tests in Docker yet
ENV PUPPETEER_SKIP_DOWNLOAD=true

# Pin npm version to match local dev (node:22 ships npm 10, lock file was generated with npm 11)
# Direct self-upgrade (npm i -g npm@11) can corrupt modules on some node:22
# images, so bootstrap via npx which downloads a clean copy first.
RUN npx -y npm@11 install -g npm@11

# We use npm ci (Clean Install) to install the dependencies
RUN npm ci

# We build the app using either:
# npm run build (for development)
# or
# npm run deploy (for production)
# Both commands are defined in the package.json file
# and will build the app using Webpack into the dist folder
# (See docker-config-install.js, which sets those paths)

# Set environment variable to indicate this is a Docker build
ENV DOCKER_BUILD=true

RUN npm run deploy


# --- PHP dependencies (AWS SDK for S3, Guzzle) -------------------------------
# composer.json/composer.lock ship in sitrecServer, but vendor/ is gitignored and
# never committed — so it must be built into the image. Without it, every PHP
# endpoint that does `require 'vendor/autoload.php'` (S3 uploads, settings, rehost,
# object, metadata, getsitches, admin) fatals. Built from the committed lock.
# --ignore-platform-reqs: install exactly what the lock pins; the runtime
# php:8.4-apache below provides the extensions S3 actually uses (curl, json,
# simplexml, mbstring, openssl) and the only lock exts it lacks are optional
# (awscrt/pcntl/sockets/intl), unused here.
FROM composer:2 AS phpdeps
WORKDIR /sitrecServer
COPY sitrecServer/composer.json sitrecServer/composer.lock ./
RUN composer install --no-dev --no-interaction --prefer-dist --optimize-autoloader --no-progress --ignore-platform-reqs

# The second stage is to build the image
# We're using the official PHP 8.4 image with Apache
# This is the image that will be used to run the app
# We're copying the built app from the first stage to this image
FROM php:8.4-apache

RUN apt-get update && apt-get install -y libzip-dev libonig-dev \
    python3 python3-pip \
    && docker-php-ext-install zip mbstring iconv \
    && pip3 install --no-cache-dir --break-system-packages eccodes certifi \
    && rm -rf /var/lib/apt/lists/*

COPY --from=build /build/dist /var/www/html

# vendor/ (AWS SDK etc.) is gitignored, so the built dist carries composer.json/lock
# but no vendor — add the PHP dependencies built in the phpdeps stage above.
COPY --from=phpdeps /sitrecServer/vendor /var/www/html/sitrecServer/vendor

WORKDIR /var/www/html

# make sitrec-cache and upload dirs and set permissions
# cache is needed for terrain loading and starlink
# upload is needed for video and data track uploads
# but it will NOT be persisted
# So it's highly recommended you use S3 with docker
# or mount a volume to /var/www/html/sitrec-upload

RUN mkdir -p ./sitrec-cache && chmod 777 ./sitrec-cache \
    && mkdir -p ./sitrec-upload && chmod 777 ./sitrec-upload \
    && mkdir -p ./data/wind && chmod 777 ./data/wind

# The entrypoint regenerates shared.env.php and re-injects index.html at every
# container start. Make the webroot world-writable and non-sticky so a non-root UID
# (rootless Podman with --user, OpenShift's arbitrary assigned UIDs, etc.) can
# delete-and-recreate those root-owned files: a non-owner cannot modify them in
# place under rootless overlay (copy-up is denied even at mode 666), but it CAN
# replace them in a writable, non-sticky directory.
RUN chmod 0777 /var/www/html

# Install the entrypoint script that converts Docker env vars
# into shared.env.php (for PHP) and window.__SITREC_ENV__ (for JS)
# Suppress Apache ServerName warning
RUN echo "ServerName localhost" >> /etc/apache2/apache2.conf

# Listen on an unprivileged port (8080) by default so the container can run as a
# non-root UID (rootless Podman --user, OpenShift's arbitrary assigned UIDs).
# Port 80 is privileged and only root can bind it. The entrypoint exports
# SITREC_LISTEN_PORT (default 8080, overridable via SITREC_DOCKER_INTERNAL_PORT)
# and Apache expands ${SITREC_LISTEN_PORT} below. The envvars line is a fallback
# default so the variable is always defined even if the entrypoint is bypassed.
RUN sed -i 's/^Listen 80$/Listen ${SITREC_LISTEN_PORT}/' /etc/apache2/ports.conf \
    && sed -i 's/<VirtualHost \*:80>/<VirtualHost *:${SITREC_LISTEN_PORT}>/' /etc/apache2/sites-available/000-default.conf \
    && echo 'export SITREC_LISTEN_PORT=${SITREC_LISTEN_PORT:-8080}' >> /etc/apache2/envvars

COPY docker/entrypoint.sh /usr/local/bin/sitrec-entrypoint.sh
RUN chmod +x /usr/local/bin/sitrec-entrypoint.sh

# Bundle installer-support files so install.sh/install.ps1 can extract them from the image
COPY sitrec.sh /usr/local/share/sitrec/sitrec.sh
COPY sitrec.ps1 /usr/local/share/sitrec/sitrec.ps1
COPY sitrec.cmd /usr/local/share/sitrec/sitrec.cmd
COPY config/shared.env.example /usr/local/share/sitrec/shared.env.example

VOLUME /var/www/html/sitrec-videos

# Canonical container port is 8080 (unprivileged, runs as any UID). When started
# as root, the entrypoint also listens on 80 for back-compat with older mappings.
EXPOSE 8080

ENTRYPOINT ["sitrec-entrypoint.sh"]
CMD ["apache2-foreground"]
