# Firebase Auth Emulator only. The Auth emulator needs no JRE (unlike
# Firestore/RTDB), so this stays a thin node image. The Emulator UI bundle is
# fetched at build time so container start is offline-friendly.
FROM node:24-alpine
RUN apk add --no-cache bash openjdk17-jre-headless && \
    npm install -g firebase-tools@13
WORKDIR /srv
COPY firebase.json ./firebase.json
RUN firebase setup:emulators:ui || true
EXPOSE 9099 4000
CMD ["firebase", "emulators:start", "--only", "auth", "--project", "demo-circls"]
