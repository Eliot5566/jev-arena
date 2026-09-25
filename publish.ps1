# One-shot publisher for Jev Arena (Windows PowerShell).
#
#   powershell -ExecutionPolicy Bypass -File .\publish.ps1
#
# What it does, in order:
#   1. moves _github into .github (the Claude session cannot write .github directly)
#   2. creates a git repo and a first commit, if there isn't one yet
#   3. with the GitHub CLI (gh): creates the public repo <you>/jev-arena and pushes
#   4. points the site's "Star on GitHub" link and the README at your repo
#   5. asks for your TypeSafe key and stores it as the TYPESAFE_API_KEY repository secret
#      (typed here, sent only to GitHub; it never lands in a file)
#   6. pushes (which starts the ladder workflow) and turns on GitHub Pages
#
# Needs: git, and GitHub CLI logged in (winget install GitHub.cli ; gh auth login).

param(
  [string]$RepoName = "jev-arena",
  [ValidateSet("public", "private")] [string]$Visibility = "public"
)

$ErrorActionPreference = "Stop"
Set-Location -Path $PSScriptRoot

function Step($msg) { Write-Host "`n==> $msg" -ForegroundColor Cyan }
function Need($cmd, $hint) {
  if (-not (Get-Command $cmd -ErrorAction SilentlyContinue)) {
    Write-Host "Missing '$cmd'. $hint" -ForegroundColor Red
    exit 1
  }
}

Need git "Install Git from https://git-scm.com/download/win"
Need gh "Install the GitHub CLI: winget install GitHub.cli   then run: gh auth login"

Step "Checking GitHub login"
gh auth status | Out-Null
if ($LASTEXITCODE -ne 0) { Write-Host "Run 'gh auth login' first." -ForegroundColor Red; exit 1 }
$login = (gh api user --jq .login).Trim()
Write-Host "Logged in as $login"

Step "Moving _github into .github"
if (Test-Path "_github") {
  if (Test-Path ".github") {
    # .github already exists: copy each updated file over it, then drop _github.
    $src = (Resolve-Path "_github").Path
    Get-ChildItem -Path $src -Recurse -File | ForEach-Object {
      $dest = Join-Path ".github" $_.FullName.Substring($src.Length + 1)
      New-Item -ItemType Directory -Force -Path (Split-Path $dest) | Out-Null
      Copy-Item -Path $_.FullName -Destination $dest -Force
      Write-Host "  updated $dest"
    }
    Remove-Item "_github" -Recurse -Force
  } else {
    Rename-Item -Path "_github" -NewName ".github"
  }
  Write-Host "done"
} else {
  Write-Host "already done"
}
if (Test-Path ".github\README.md") { Remove-Item ".github\README.md" -Force }

Step "Pointing links at github.com/$login/$RepoName"
$files = @("web\index.html", "README.md", "README.zh-TW.md", "docs\PLAN.zh-TW.md")
foreach ($f in $files) {
  if (Test-Path $f) {
    $text = [System.IO.File]::ReadAllText((Resolve-Path $f))
    $new = $text.Replace("your-name/jev-arena", "$login/$RepoName").Replace("your-name.github.io/jev-arena", "$login.github.io/$RepoName")
    if ($new -ne $text) { [System.IO.File]::WriteAllText((Resolve-Path $f), $new, (New-Object System.Text.UTF8Encoding $false)); Write-Host "  updated $f" }
  }
}

Step "Creating the git repository"
if (-not (Test-Path ".git")) {
  git init -b main | Out-Null
}
git add -A
git diff --cached --quiet
if ($LASTEXITCODE -ne 0) { git commit -m "Jev Arena: write a fighter in plain English" | Out-Null; Write-Host "committed" } else { Write-Host "nothing new to commit" }

Step "Creating $Visibility repo $login/$RepoName"
gh repo view "$login/$RepoName" 2>$null | Out-Null
if ($LASTEXITCODE -ne 0) {
  gh repo create "$login/$RepoName" "--$Visibility" --source . --remote origin `
    --description "Write a fighter in plain English. A System One model (Jev) pilots it in real time."
}
if (-not (git remote | Select-String -Quiet "^origin$")) { git remote add origin "https://github.com/$login/$RepoName.git" }
gh repo edit "$login/$RepoName" --add-topic jev --add-topic typesafe --add-topic ai-arena --add-topic game --add-topic prompt-engineering --add-topic system-one | Out-Null

Step "Storing your TypeSafe key as the TYPESAFE_API_KEY secret"
$secure = Read-Host "Paste your TypeSafe API key (input hidden, Enter to skip)" -AsSecureString
$plain = [Runtime.InteropServices.Marshal]::PtrToStringAuto([Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure))
if ($plain) {
  $plain | gh secret set TYPESAFE_API_KEY --repo "$login/$RepoName"
  $plain = $null
  Write-Host "secret saved"
} else {
  Write-Host "skipped (the ladder will use the offline mock brain until you add it)"
}

Step "Pushing (this starts the validate and ladder workflows)"
git push -u origin main

Step "Turning on GitHub Pages (built by the workflow)"
gh api -X POST "repos/$login/$RepoName/pages" -f build_type=workflow 2>$null | Out-Null
gh api -X PUT "repos/$login/$RepoName/pages" -f build_type=workflow 2>$null | Out-Null
Write-Host "done"

Write-Host "`nAll set:" -ForegroundColor Green
Write-Host "  repo   https://github.com/$login/$RepoName"
Write-Host "  site   https://$login.github.io/$RepoName/   (live after the first ladder run, ~20 min)"
Write-Host "  runs   https://github.com/$login/$RepoName/actions"
