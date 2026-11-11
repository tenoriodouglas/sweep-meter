#!/usr/bin/env bash
# Installs the SDK packages this project needs on top of the runner's preinstalled SDK.
# Retries because large SDK downloads occasionally arrive truncated.
set -euo pipefail
sdkmanager=$(find "$ANDROID_HOME/cmdline-tools" -type f -name sdkmanager | sort -r | head -n 1)
test -n "$sdkmanager"
yes | "$sdkmanager" --licenses > /dev/null 2>&1 || true
for attempt in 1 2 3; do
  if "$sdkmanager" --install "platforms;android-37.0" "build-tools;37.0.0" > /dev/null; then
    exit 0
  fi
  echo "::warning::SDK install failed (attempt $attempt)"
  sleep $((attempt * 15))
done
echo "::error::SDK install failed after 3 attempts"
exit 1
