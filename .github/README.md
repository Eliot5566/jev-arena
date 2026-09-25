# Updated workflow waiting to move into `.github`

`workflows/ladder.yml` here is newer than the one in `.github` (it skips re-running the ladder
when nothing changed, and re-runs it once a month). The Claude session can't write inside
`.github`, so it's parked here.

`publish.ps1` copies it over `.github\workflows\ladder.yml` and deletes this folder.
By hand: copy `workflows\ladder.yml` into `.github\workflows\`, then delete `_github`.
