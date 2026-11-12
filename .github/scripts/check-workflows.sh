#!/usr/bin/env bash
set -euo pipefail

directory=$(mktemp -d)
trap 'rm -rf "$directory"' EXIT

# Verify downloaded tools against the release checksums before executing them.
curl --fail --silent --show-error --location \
  https://github.com/rhysd/actionlint/releases/download/v1.7.12/actionlint_1.7.12_linux_amd64.tar.gz \
  --output "$directory/actionlint.tar.gz"
printf '%s  %s\n' 8aca8db96f1b94770f1b0d72b6dddcb1ebb8123cb3712530b08cc387b349a3d8 "$directory/actionlint.tar.gz" | sha256sum --check --status
tar -xzf "$directory/actionlint.tar.gz" -C "$directory" actionlint
"$directory/actionlint" .github/workflows/*.yaml

curl --fail --silent --show-error --location \
  https://github.com/gitleaks/gitleaks/releases/download/v8.30.1/gitleaks_8.30.1_linux_x64.tar.gz \
  --output "$directory/gitleaks.tar.gz"
printf '%s  %s\n' 551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb "$directory/gitleaks.tar.gz" | sha256sum --check --status
tar -xzf "$directory/gitleaks.tar.gz" -C "$directory" gitleaks
"$directory/gitleaks" git --redact --no-banner .
