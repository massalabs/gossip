#!/bin/bash
set -e

# Install dependencies and build the project
npm ci
npm run build

# Update the version with a prepatch, preid dev, no git tag, and no commit hooks
npm version --preid dev --no-git-tag-version --no-commit-hooks prepatch

# Use timestamp as package suffix
TIME=$(date -u +%Y%m%d%H%M%S)
sed -i "/version/s/dev.0/dev.$TIME/g" package.json

# Publish the package
npm publish --access public --tag dev

