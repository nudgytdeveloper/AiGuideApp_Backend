# Ai Guide App's backend

Express.js API that serves as backend for both Ai Guide App and Hologram app.

## IF you wan to run locally, kindly follw below:-

```bash
# install deps
npm install
##npm install firebase ## install Firebase

## type this command in terminal to firebse json file for Firebase linking
export GOOGLE_APPLICATION_CREDENTIALS=/abs/path/to/serviceAccount.json

# start
npm start
# or with auto hot reload..
npm run dev
```

## Firestore setup

- Option A: set FIREBASE_SERVICE_ACCOUNT (base64 JSON service account)
- Option B: set GOOGLE_APPLICATION_CREDENTIALS to path of serviceAccount.json

## Example response

```json
{
  "sessionId": "abcd...",
  "issuedAt": 1725072000000,
  "nonce": "3f1a...",
  "firestore": { "enabled": true, "persisted": true, "error": null }
}
```

## Deploy to Render (optional)

1. Push this repo to GitHub.
2. On Render, create a **Web Service** from the repo.
3. Use `Node` runtime, build command: `npm install`, start command: `npm start`.

## Docker

```bash
# build
docker build -t express-session-id-api .
# run..

docker run -p 3000:3000 --name session-api express-session-id-api
```
