#!/bin/bash
set -e

# Install dependencies and build the project
npm ci
npm run build

# Get the package name and current version from package.json
PACKAGE_NAME=$(jq -r '.name' package.json)
NEW_VERSION=$(jq -r '.version' package.json)
CURRENT_VERSION=$(npm view "$PACKAGE_NAME" version 2>/dev/null || true)

if [ "$CURRENT_VERSION" == "$NEW_VERSION" ]; then
  echo "${PACKAGE_NAME}@${NEW_VERSION} is already published. Skipping."
else
  echo "Publishing ${PACKAGE_NAME}@${NEW_VERSION}"
  npm publish --access public
fi

