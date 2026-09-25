# Contributing

## Add a fighter (the fun part)

1. `npx jev-arena` → **Fighter Lab**. Start from a template or a blank sheet.
2. Edit the English and press **TEST FIGHT** until you like it.
3. **Copy YAML** → save as `fighters/<your-github-handle>.yaml`.
4. In your fork's folder: `npm install` once, then `npx jev-arena smoke fighters/<your-github-handle>.yaml` (validates the file and fights it against the field with the offline brain; CI runs the same check)
5. Open a pull request using the template. [PR #2](https://github.com/Eliot5566/jev-arena/pull/2) is a worked example.

House rules:

- One fighter per GitHub account per season. Update yours whenever you like.
- `author` must be your GitHub handle, and names must be unique.
- Keep it friendly. No slurs, harassment, or real people's names as fighters.
- Strategy text can say anything about *your* fighter. It cannot see the opponent's file, so there's nothing to inject into.

## Change the game

Balance lives in `src/engine/constants.js`. If a change alters how fights play out, bump `ENGINE_VERSION` so old replays warn instead of silently drifting. Include a before/after ladder run with the mock brain (`npx jev-arena ladder --brain mock --mode lockstep --out /tmp/ladder`) in the PR description.

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

## Run a season (maintainers)

1. Announce the deadline in an issue (Season 1 is [#1](https://github.com/Eliot5566/jev-arena/issues/1)) and freeze balance: don't bump `ENGINE_VERSION` until the season closes.
2. Merge entries in batches. Every merge re-runs the ladder with Jev, so batching saves money. `npx jev-arena ladder --dry-run` prints the cost and time for the current field.
3. After the deadline, run the **Ladder and site** workflow by hand for a fresh final run.
4. Run the **Close season** workflow with the season id (for example `1`). It freezes `ladder/` into `seasons/<id>/`, writes the champion into the README Hall of Fame, and republishes the site, where the Ladder tab gets a season picker. Locally: `npx jev-arena season archive 1`.
