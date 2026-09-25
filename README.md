<div align="center">

# ⚔ Jev Arena

**Write a fighter in plain English. A System One model pilots it several times a second.**

Real-time bot battles · a ladder you join with a pull request · swap the brain: Jev, Laya, kev, or any LLM

**[▶ Watch the ladder live](https://eliot5566.github.io/jev-arena/)** · [Play locally](#play-in-10-seconds) · [Write a fighter](#your-fighter-is-a-paragraph) · [Join the ladder](#join-the-ladder) · [繁體中文](README.zh-TW.md)

<img src="docs/demo.gif" alt="Two fighters dueling in Jev Arena, with each brain's move probabilities updating live" width="880" />

</div>

---

LLMs think well and react slowly. By the time a chat model has written *"I should raise my shield"*, the heavy shot has already landed.

[Jev](https://typesafe.ai) is a different kind of model. It doesn't write text. It reads a state and returns **typed decisions with calibrated probabilities**, in roughly 70 to 500 ms by TypeSafe's numbers. That is fast enough to be a fighter's reflexes.

So in Jev Arena, **you** write the strategy in English and **the model** supplies the reflexes, live, while the fight is running.

## Your fighter is a paragraph

```yaml
name: Tortoise
author: your-github-handle
color: "#4ade80"
strategy: >
  I am a patient counter-puncher. I stay close to a pillar and let the enemy come to me.
  I shield the moment a heavy shot is on its way, then answer with bolts while the enemy
  is exposed. I only step out of cover to grab a repair kit or to finish a badly hurt enemy.
reflexes:
  - when: The enemy is charging a heavy shot, or a heavy shot is flying at me.
    do: shield
    threshold: 0.7
fallback: take_cover
```

That's the whole bot. No code, no coordinates, no if-statements.

**How far does one sentence go?** On the current Jev ladder, *Zen* is a single line, "Win the fight. Do whatever a wise, calm fighter would do in this exact moment.", with no reflexes at all. It finished **2nd of 6**, one Elo point behind the leader. The carefully tuned Sniper went 0-10. Can your paragraph beat a sentence?

| # | Fighter | Elo | W-D-L | Style |
|---|---------|-----|-------|-------|
| 1 | Trickster | 1063 | 8-0-2 | circles, baits, dashes away |
| 2 | **Zen** | 1062 | 8-0-2 | one sentence, zero reflexes |
| 3 | Tortoise | 1039 | 7-0-3 | shoots from behind pillars |
| 4 | Berserker | 994 | 5-0-5 | rushes in, punches |
| 5 | Glass Cannon | 938 | 2-0-8 | heavy shots, paper armor |
| 6 | Sniper | 905 | 0-0-10 | long range, and it shows |

<sub>Real Jev (jev-1.13.0), real time, 30 fights, all ended in KO. Full table and every replay: [`ladder/LEADERBOARD.md`](ladder/LEADERBOARD.md).</sub>

## How one decision works

```
 fight state ──►  "enemy charging heavy shot: YES, fires in 0.4s"      (engine does the geometry)
                  "distance: 6.2m (medium)"  "my shield: ready"  "closing zone: not yet"
       │
       ▼
 questions  ──►  Choice  move: "Following Tortoise's style, how should it move?"   over legal movements
 (one request,   Choice  act:  "…and what should it do with its weapons?"         over legal actions + wait
  in parallel)   Noul    reflex_1: "Is this true right now: a heavy shot is flying at me?"
       │
       ▼
 typed answer ─► move: take_cover 0.62 · strafe_left 0.21 …    act: shield 0.71 · shoot 0.18 …
                 reflex 1: p = 0.93  (threshold 0.7 → FIRES)
       │
       ▼
 decision    ──►  take_cover + shield      a fired reflex wins its slot → else the top choice if
                                           confident → else your fallback move / wait
```

Every movement, every action and every reflex has a probability, and the arena shows them all live in each fighter's "mind panel". You can watch *why* your fighter did what it did.

## Play in 10 seconds

```bash
npx jev-arena
```

Open http://localhost:5173 and press **FIGHT**. It works without any key: the offline **mock brain** (keyword heuristics, not AI) pilots both corners so you can explore right away. The **Replays** tab already has all 30 real Jev ladder fights, with every probability the model returned.

Let Jev pilot:

```bash
TYPESAFE_API_KEY=ts-... npx jev-arena     # key from https://console.typesafe.ai/keys
```

Or from a clone: `git clone https://github.com/Eliot5566/jev-arena && cd jev-arena && npm install && npm start`.

> **Cost check (measured).** A decision is about 1,400 input tokens. Jev charges $0.042 per million input tokens and nothing for output, so one decision costs about $0.00006. Both fighters decide ~3.7 times a second at a 230 ms median latency, so a fight that goes the full 60 seconds costs **2–3 cents**, and the whole 30-fight ladder in [`ladder/`](ladder/LEADERBOARD.md) cost **$0.49**.

## Two ways to fight

| Mode | The world… | What it measures |
|---|---|---|
| **Real-time** (default) | never waits. A brain is asked again as soon as it answers. | Speed *and* judgment. A 250 ms brain acts ~4×/s. A 3 s brain barely moves. |
| **Lockstep** | freezes every 0.2 s until both brains answer. | Judgment only. Latency stops mattering. |

Put the same fighter on a fast brain and a slow brain in real-time mode and the difference is obvious within seconds. (No key? Try `Mock` vs `Mock (slow, 1.5s)`.)

## Swap the brain

Any brain that speaks the TypeSafe **System One** protocol (`POST {state, questions}` → typed answers) plugs in.

| Brain | How to enable | Notes |
|---|---|---|
| `jev` | `TYPESAFE_API_KEY` | TypeSafe's hosted model. The headliner. |
| Laya, kev, any compatible server | `JEV_ARENA_ENDPOINTS="laya=http://localhost:8000/v1/systemone"` | Open models you run yourself. |
| `llm` | `LLM_MODEL=<model>` + `OPENAI_API_KEY`, or `OPENAI_BASE_URL` for OpenRouter / Ollama / LM Studio | Chat LLMs through a JSON adapter. Their probabilities are self-reported, not calibrated. |
| `mock` / `mock-slow` | always on | Offline heuristics for trying things out and CI. Not intelligent. |

```bash
# Jev vs a local Ollama model, same English on both sides
OPENAI_BASE_URL=http://localhost:11434/v1 npx jev-arena fight tortoise berserker --red jev --blue llm:llama3.2
npx jev-arena fight sniper trickster --brain http://localhost:8000/v1/systemone --mode lockstep
```

## Join the ladder

1. Design your fighter in the **Fighter Lab** tab: edit the English, press **TEST FIGHT**, repeat.
2. Press **Copy YAML** and save it as `fighters/<your-github-handle>.yaml`.
3. Open a pull request. CI validates it and smoke-fights it against the field.
4. When it's merged, the [ladder workflow](.github/workflows/ladder.yml) runs the round robin (with Jev, using the repo's `TYPESAFE_API_KEY` secret), commits [`ladder/LEADERBOARD.md`](ladder/LEADERBOARD.md), and republishes the site with every replay.

You don't need a TypeSafe key to compete. The ladder's brain is the repo's.

**Fair-play limits:** strategy ≤ 700 characters, ≤ 4 reflexes, action notes ≤ 160 characters. Everybody gets the same prompt budget, and the ladder brain is the same for every fighter.

## Tips for writing fighters

- **Describe situations, not coordinates.** The brain sees facts like `enemy charging heavy shot: YES, fires in 0.4s` and `line_of_sight: false`. Write rules in those terms.
- **Say what the hands should do, not only the feet.** Movement and action are separate questions. "Strafe while I shoot" is exactly how the brain thinks.
- **Reflexes are for the obvious.** "A heavy shot is flying at me → dash" should be a reflex. Nuanced trade-offs belong in the strategy.
- **Thresholds are real probabilities.** Jev's numbers are calibrated, so 0.9 means "only when you're sure" and 0.6 means "when it's more likely than not".
- **Use the fallback.** When the brain is unsure (confidence below `min_confidence`), a safe default like `take_cover` beats a coin flip.
- **The move set has counters.** Bolts lose to sidestepping at range. Heavy shots lose to shields and dashes. Shields lose to melee. Melee loses to being shot on the way in.
- **Plan for the zone.** After 25 s the edges start to burn. A fighter that only ever hides needs a sentence about what to do then.

## Everything else

<details>
<summary><b>CLI reference</b></summary>

```text
jev-arena [serve]                       open the arena in your browser (default)
jev-arena fight <red> <blue> [options]  run one fight in the terminal
jev-arena ladder [options]              round-robin every fighter, write ladder/
jev-arena validate [files...]           check fighter files
jev-arena brains                        list the brains this machine can use
jev-arena build-site [--out dist]       build the static site for GitHub Pages
jev-arena verify <replay.json>          re-simulate a replay and check the result

--brain <id>   mock | jev | llm:<model> | <System One URL>      --red / --blue  per-side brains
--mode <m>     realtime | lockstep      --seed <n>      --out <file|dir>
--games <n>    ladder games per pair    --concurrency <n>      --dry-run (ladder cost estimate)
```
</details>

<details>
<summary><b>Replays are exact</b></summary>

The engine uses one seeded RNG and only exact floating-point operations, so a fight is fully determined by its seed plus the list of decisions (which tick each landed on). A replay file is exactly that, plus each decision's probabilities, so the viewer re-simulates the fight tick for tick and shows the fighter's mind at every moment. `jev-arena verify replay.json` checks it.
</details>

<details>
<summary><b>The rules of the arena</b></summary>

24 × 14 m, five pillars (point-symmetric, so neither corner has an edge), four power-up pads. 60 seconds, 20 ticks per second. 100 health and 100 energy; energy regenerates at 10/s (30/s while recharging).

Each decision picks **one movement and one action together**, so a fighter can shoot while strafing or shield while backing off.

| Movement | Effect |
|---|---|
| advance / retreat / strafe_left / strafe_right | Relative to the enemy. Pressing forward is a bit faster than backing off. |
| take_cover | Go to the pillar spot that blocks the enemy's line of sight. |
| grab_powerup / go_center / recharge | Fetch a power-up, head for the middle, or stand still and regenerate 3× faster. |

| Action | Cost | Effect |
|---|---|---|
| shoot | 8 | 7 damage bolt, 13 m/s. Only offered with line of sight. Dodgeable at range. |
| charge | 30 | 1 s telegraphed charge, then a 24 damage blast. |
| shield | 12 | 0.9 s, blocks 80% of shot damage. Melee breaks it. |
| dash | 18 | 3.5 m sidestep, untouchable while dashing. |
| melee | 0 | 11 damage lunge. Knocks back, stuns, breaks shields, cancels charges. |
| wait | 0 | Hold fire and save energy. |

**The closing zone.** From 25 s the safe area shrinks toward the open center (down to 6 × 4 m at 50 s). Anyone outside it loses 6 health per second, so camping at the edges loses late.

Numbers live in [`src/engine/constants.js`](src/engine/constants.js). Balance PRs welcome.
</details>

<details>
<summary><b>Project layout</b></summary>

```
src/engine/    deterministic simulation (runs in Node and the browser)
src/protocol.js   fight state + fighter → System One request; answers → move
src/brains/    jev / System One endpoints, LLM adapter, mock
src/match.js   real-time and lockstep runners, replay recording
src/node/      CLI server, ladder, static site builder
web/           the arena UI (no build step)
fighters/      one YAML file per fighter
ladder/        leaderboard + replays written by CI
```
</details>

## Roadmap

- [ ] 2v2 tag team fights and a free-for-all mode
- [ ] Seasons: frozen balance, a bracket, and a replay of the final on the site
- [ ] Laya running inside the browser tab, so anyone can play with a real model and no key
- [ ] Stream overlay mode (OBS browser source) with live commentary from the probability feed
- [ ] More arenas: tight corridors, no cover, moving pillars

Ideas, balance reports and weird replays are welcome in [issues](../../issues).

---

Unofficial community project, not affiliated with TypeSafe AI. Jev is TypeSafe's model, and "System One model" is their name for this kind of model. MIT licensed.
