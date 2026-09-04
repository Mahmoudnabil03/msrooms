# MS Rooms

MS Rooms is a cross-platform live audio rooms application. This repository contains a runnable React Native/Expo client and a Node.js backend with PostgreSQL persistence, Redis presence caching, Socket.IO room events, and Agora token issuance.

## Research Summary

Fomi Party is a mobile-first social entertainment application, not a public web platform. Its store listings describe live group voice rooms, themed conversations, anonymous/low-identity participation, host interaction, virtual gifts, in-app currency, profile personalization, and additional games or interactive features. Android and iPhone distribution are confirmed; no public evidence establishes whether its client is Flutter, React Native, Unity, or native, nor whether it uses WebRTC, Agora, or another media provider. Those implementation details must not be guessed from product behavior alone.

Public review signals include OTP/onboarding failures, moderation/account complaints, monetization concerns, regional support gaps, and privacy concerns. MS Rooms follows the same strongest product loop: fast themed-room discovery, voice-first participation, host/speaker/listener roles, text chat, and a synchronized quick poll. It deliberately uses Agora for media and keeps social/game logic in the backend, rather than attempting to copy an unknown proprietary stack.

Useful alternatives are LiveKit for a self-hosted WebRTC SFU, Jitsi for open-source conferencing, Mumble for low-latency community voice, Matrix for federated messaging, and Agora's public RTC quickstarts for client reference. None provides Fomi's discovery, host UX, virtual economy, or moderation model out of the box.

## Diagnosis And Repairs

The initial audit identified these concrete failure classes:

- `backend/src/server.ts` contained malformed nested Prisma object expressions, so TypeScript could not parse or build the API.
- Root-level generated Expo files and a separate `mobile/` app made `npx expo` commands ambiguous. The intended app is `mobile/`; native commands must be run from that directory.
- Expo SDK 57 was paired with React Native 0.81/React 19.1 in `mobile/package.json`. The manifest now aligns with Expo 57's React Native 0.86/React 19.2 line.
- Physical devices cannot reach a backend at `localhost`. Set both mobile API variables to the development computer's LAN IP or a deployed HTTPS URL.
- OTP registration had no password-compatible path. OTP verification now creates a verified account intentionally; password login remains a separate explicit registration/login path.
- Agora cleanup captured stale React state. The room now keeps the native engine in a ref and releases it on unmount.
- Socket events previously allowed chat/hand operations without active membership. The API now checks active room membership before changing state or writing chat.
- Host moderation is now authorized server-side and supports promote, demote, mute, unmute, and remove through `room:moderate`.

## Fix Plan And Effort

Priority 1 is complete: startup parsing, dependency alignment, auth storage, room join state, and Agora lifecycle. Priority 2 is complete for the MVP: synchronized room events, host moderation, and one synchronized quick-poll game with scores. Priority 3 remains deployment hardening: wire a real OTP provider, add avatar object-storage uploads, add the Redis Socket.IO adapter for multiple API replicas, and implement app-store billing/virtual gifts. A developer with the service credentials can complete those production integrations in roughly 2-5 days depending on provider setup.

## Test Plan

1. Backend: copy `backend/.env.example` to `.env`, start PostgreSQL/Redis, run `npx prisma generate`, `npx prisma migrate dev --name init`, then `npm run dev` and verify `GET /health`.
2. Auth: call `/auth/otp/request`, read the development code from the API log, verify it at `/auth/otp/verify`, then call `/users/me` with the returned access token.
3. Rooms: use the token to create a room, connect two Socket.IO clients with separate users, emit `room:join`, and verify both receive `room:participants`.
4. Realtime: emit `room:hand` and `room:chat` only after joining; verify a non-member receives an error acknowledgement and no chat row is created.
5. Moderation: create a host and listener, emit `room:moderate` from the host, verify the participant row and `room:moderated` event; repeat from the listener and verify rejection.
6. Agora: configure the App ID and certificate on the backend, run a native development build from `mobile/`, join from two devices, verify listener subscription and publisher audio, then leave and re-enter repeatedly to check for no stuck microphone/audio.
7. Game loop: host emits `game:start`, players receive identical `game:state`, answer once, and verify scores/state are identical for all connected players.

## Error Reporting

For any remaining issue, capture the exact command, platform/device, Expo SDK, app build type, full Metro/native stack trace, backend logs, request URL/status, Socket.IO transport/errors, and whether the backend was reached by LAN IP or localhost. Screenshots are useful for visual defects but cannot replace text logs or error codes.

## Architecture Plan

**Stack:** React Native with Expo targets iOS and Android from one codebase. The backend uses Node.js, Express, TypeScript, Prisma, PostgreSQL, Redis, and Socket.IO. Agora RTC handles encrypted low-latency audio using the native SDK's AEC/ANS processing. This keeps media transport out of the application servers, while REST owns durable data and Socket.IO owns room state and chat.

**Data model:** `User` stores verified identities and profiles. `OtpCode` stores short-lived hashed verification codes. `Room` stores name, category, visibility, capacity, host, and lifecycle. `RoomParticipant` stores role (`HOST`, `SPEAKER`, `LISTENER`), mute and raised-hand state, and membership lifecycle. `ChatMessage` stores room text history. Active user IDs are additionally kept in Redis keys like `room:{id}:online` with application-level expiry/cleanup.

**REST API:**

- `POST /auth/register`, `POST /auth/login`, `POST /auth/refresh`
- `POST /auth/otp/request`, `POST /auth/otp/verify`
- `GET /users/me`, `PATCH /users/me`
- `GET /rooms`, `POST /rooms`, `GET /rooms/:id`
- `POST /rooms/:id/agora-token`

**Socket.IO events:** Clients authenticate with a JWT in the handshake. Client events are `room:join`, `room:leave`, `room:hand`, and `room:chat`. Server events are `room:participants`, `room:user_left`, `room:hand`, and `room:chat`. The event handlers validate membership and write durable state before broadcasting. A Redis adapter can be added when running multiple API replicas.

**Voice:** After joining a room through Socket.IO, the client requests `/rooms/:id/agora-token`, joins an Agora channel named by the room ID, and uses publisher role only for speakers. Agora's DTLS/SRTP transport and built-in audio processing provide encrypted voice, echo cancellation, and noise suppression. The current client boundary is ready for `react-native-agora`; add the SDK and wire the token response in `Room` for device audio publishing.

**Deployment:** Run the API on Railway, Fly.io, or ECS behind HTTPS. Run managed PostgreSQL and Redis. Store avatar objects in S3/Cloudinary and persist only their HTTPS URL. Build mobile binaries with EAS. Set strict `CLIENT_ORIGIN`, rotate `JWT_SECRET`, use a real SMS/email provider for OTP delivery, and configure an Agora App Certificate in production.

## Backend Setup

Requirements: Node.js 20+, PostgreSQL 14+, and Redis 6+ (Redis is optional for local development).

```bash
cd backend
npm install
copy .env.example .env   # PowerShell; use cp on macOS/Linux
# Edit DATABASE_URL, JWT_SECRET, and optionally Agora/Redis values
npx prisma generate
npx prisma migrate dev --name init
npm run seed
npm run dev
```

The API starts on `http://localhost:4000`. `GET /health` is the health check. OTP codes are printed to the backend console in development; connect `/auth/otp/request` to Twilio, MessageBird, or an email provider before shipping.

## Mobile Setup

Requirements: Node.js 20+, Expo SDK 57, EAS CLI, Xcode for iOS or Android Studio/emulator for Android.

```bash
cd mobile
npm install
copy .env.example .env   # PowerShell; use cp on macOS/Linux
npx expo start
```

Agora requires a native development build; Expo Go cannot load `react-native-agora`.

```bash
npx expo install expo-dev-client
npx expo run:android
npx expo run:ios
```

The room screen joins Agora after the authenticated Socket.IO membership is accepted. Listeners receive audio only; hosts and promoted speakers receive publisher tokens. The native Agora SDK is responsible for microphone permissions, AEC, ANS, and DTLS/SRTP media encryption.

## Branding Assets

The supplied MS Rooms artwork is represented in `mobile/assets/ms-rooms-logo.svg` and `public/ms-rooms-logo.svg`. The latter is used by the browser preview. For an EAS native build, export the supplied artwork as a square PNG at `mobile/assets/icon.png` and add `"icon": "./assets/icon.png"` to `mobile/app.json`; Expo does not accept SVG files for native app icons.

For a physical phone, set `EXPO_PUBLIC_API_URL` and `EXPO_PUBLIC_SOCKET_URL` to the computer's LAN IP rather than `localhost`. The client includes demo lobby data until the API is reachable, but authentication and live room operations require a running backend and a verified user token.

## Environment Variables

Backend: `DATABASE_URL`, `REDIS_URL`, `JWT_SECRET`, `AGORA_APP_ID`, `AGORA_APP_CERTIFICATE`, `PORT`, and `CLIENT_ORIGIN`.

Mobile: `EXPO_PUBLIC_API_URL`, `EXPO_PUBLIC_SOCKET_URL`, and `EXPO_PUBLIC_AGORA_APP_ID`.

## Production Notes

Use a real OTP provider, object storage upload signing endpoint, refresh-token rotation and revocation storage, Redis Socket.IO adapter for multiple replicas, and an Agora-capable native client build. Never commit `.env` files or expose `AGORA_APP_CERTIFICATE` to the mobile app.
