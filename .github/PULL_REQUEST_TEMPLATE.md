<!-- Adding a fighter? Fill this in. Anything else? Delete it and describe your change. -->

## New fighter

- **Name:**
- **Style in one line:**
- [ ] One file, `fighters/<your-github-handle>.yaml`
- [ ] `author` is my GitHub handle
- [ ] `npx jev-arena smoke fighters/<file>.yaml` passes (validates the file and fights the field offline)
- [ ] I tested it in the Fighter Lab or with `jev-arena fight`

CI posts the same smoke test on the check's summary page. Once merged, the ladder workflow plays it against the field with Jev and the site updates with its replays. [PR #2](https://github.com/Eliot5566/jev-arena/pull/2) is a worked example.
