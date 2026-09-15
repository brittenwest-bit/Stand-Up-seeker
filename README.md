# Stand Up Seeker — clean restart

This is the minimal Vercel-ready restart build.

## Structure
- `index.html` — app UI
- `hero-stage.png` — hero image
- `api/events.js` — self-contained Vercel serverless API

There is deliberately **no data folder, package.json, build command, API key, or environment variable** in this test build.

## Deploy
Upload these three items to the **root** of the existing GitHub repository, preserving the `api/events.js` folder path. Vercel should redeploy automatically.

## Test
After Vercel says Ready, visit `/api/events?city=Boston&date=2026-10-29` on the deployed domain. It should return JSON with one clearly labeled demo event.
