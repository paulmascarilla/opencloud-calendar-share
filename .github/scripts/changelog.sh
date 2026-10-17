#!/usr/bin/env bash
# Release helpers based on Conventional Commits (see CONTRIBUTING.md).
#   changelog.sh version [auto|patch|minor|major]   next version after the latest v* tag
#   changelog.sh notes <version> [<git range>]       changelog section for <version>
#   changelog.sh previous-tag [<rev>]                latest v* tag before <rev> (default HEAD)
set -euo pipefail

repo_url=""
if [[ -n ${GITHUB_REPOSITORY:-} ]]; then
  repo_url="${GITHUB_SERVER_URL:-https://github.com}/$GITHUB_REPOSITORY"
fi

previous_tag() {
  git describe --tags --abbrev=0 --match 'v[0-9]*' "${1:-HEAD}" 2>/dev/null || true
}

# Default range: since the latest tag (all commits when there is none).
default_range() {
  local tag
  tag=$(previous_tag)
  echo "${tag:+$tag..}HEAD"
}

# Commits in a range, as "<sha> <subject>", without merges and release commits.
commits() {
  git log --no-merges --format='%H %s' "$1" | grep -v ' chore: release v' || true
}

breaking() { # $1 = sha, $2 = subject
  [[ $2 =~ ^[a-z]+(\([a-z0-9-]+\))?!: ]] || git log -1 --format=%b "$1" | grep -q '^BREAKING[ -]CHANGE:'
}

next_version() {
  local bump=${1:-auto} tag major minor patch
  tag=$(previous_tag)
  IFS=. read -r major minor patch <<<"${tag#v}"
  major=${major:-0} minor=${minor:-0} patch=${patch:-0}

  if [[ $bump == auto ]]; then
    local sha subject found=0 feat='^feat[(:!]'
    bump="patch"
    while read -r sha subject; do
      found=1
      if breaking "$sha" "$subject"; then
        bump=major
        break
      fi
      [[ $subject =~ $feat ]] && bump=minor
    done < <(commits "$(default_range)")
    if ((found == 0)); then
      echo "no commits since ${tag:-the start}" >&2
      exit 1
    fi
    # Before 1.0.0, a breaking change bumps the minor version.
    if [[ $bump == major && $major == 0 ]]; then bump=minor; fi
  fi

  case $bump in
    major) echo "$((major + 1)).0.0" ;;
    minor) echo "$major.$((minor + 1)).0" ;;
    patch) echo "$major.$minor.$((patch + 1))" ;;
    *) echo "unknown bump: $bump" >&2; exit 1 ;;
  esac
}

notes() {
  local version=$1 range=${2:-$(default_range)}
  local -A sections=()
  local order=(breaking feat fix perf docs)
  local -A titles=([breaking]="⚠ Breaking changes" [feat]=Features [fix]="Bug fixes" [perf]=Performance [docs]=Documentation)

  local sha subject type scope desc line
  while read -r sha subject; do
    [[ $subject =~ ^([a-z]+)(\(([a-z0-9-]+)\))?!?:\ (.*)$ ]] || continue
    type=${BASH_REMATCH[1]} scope=${BASH_REMATCH[3]} desc=${BASH_REMATCH[4]}
    line="- ${scope:+**$scope:** }$desc"
    if [[ -n $repo_url ]]; then
      line+=" ([${sha:0:7}]($repo_url/commit/$sha))"
    else
      line+=" (${sha:0:7})"
    fi
    if breaking "$sha" "$subject"; then
      sections[breaking]+="$line"$'\n'
    fi
    if [[ -n ${titles[$type]:-} ]]; then
      sections[$type]+="$line"$'\n'
    fi
  done < <(commits "$range")

  local prev="" heading="$version"
  [[ $range == *..* ]] && prev=${range%%..*}
  if [[ -n $repo_url && -n $prev ]]; then
    heading="[$version]($repo_url/compare/$prev...v$version)"
  fi
  echo "## $heading ($(date -u +%F))"
  local key empty=1
  for key in "${order[@]}"; do
    [[ -n ${sections[$key]:-} ]] || continue
    empty=0
    printf '\n### %s\n\n%s' "${titles[$key]}" "${sections[$key]}"
  done
  if ((empty)); then printf '\nMaintenance only.\n'; fi
}

case ${1:-} in
  version) next_version "${2:-auto}" ;;
  notes) notes "${2:?version}" "${3:-}" ;;
  previous-tag) previous_tag "${2:-HEAD}" ;;
  *) echo "usage: changelog.sh version [auto|patch|minor|major] | notes <version> [<range>] | previous-tag [<rev>]" >&2; exit 1 ;;
esac
