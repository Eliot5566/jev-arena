# Contributing

## Add a fighter (the fun part)

1. `npx jev-arena` → **Fighter Lab**. Start from a template or a blank sheet.
2. Edit the English and press **TEST FIGHT** until you like it.
3. **Copy YAML** → save as `fighters/<your-github-handle>.yaml`.
4. `npx jev-arena validate fighters/<your-github-handle>.yaml`
5. Open a pull request using the template.

House rules:

- One fighter per GitHub account per season. Update yours whenever you like.
- `author` must be your GitHub handle, and names must be unique.
- Keep it friendly. No slurs, harassment, or real people's names as fighters.
- Strategy text can say anything about *your* fighter. It cannot see the opponent's file, so there's nothing to inject into.

## Change the game

Balance lives in `src/engine/constants.js`. If a change alters how fights play out, bump `ENGINE_VERSION` so old replays warn instead of silently drifting. Include a before/after ladder run with the mock brain (`npx jev-arena ladder --brain mock --mode lockstep`) in the PR description.

Keep the engine deterministic: all randomness goes through `world.rng`, and the simulation only uses `+ - * /` and `Math.sqrt` (no trig), so replays re-simulate identically in every JS engine. `npm test` checks this.

## Add a brain

A brain is an object with `decide(request) → Promise<{ response, latencyMs }>`, where `request` and `response` follow the TypeSafe System One shape. See `src/brains/systemone.js` (HTTP), `src/brains/llm.js` (translation layer) and `src/brains/mock.js` (offline). Register it in `src/node/brains.js`.

## Development

```bash
npm install
npm test
npm start                 # http://localhost:5173
node bin/jev-arena.js fight tortoise berserker --brain mock
```

The web UI has no build step. Edit `web/*.js` and reload.
