#!/usr/bin/env bash
# Check commit subjects against Conventional Commits (see CONTRIBUTING.md).
#   commitlint.sh <git range>        e.g. commitlint.sh upstream/main..HEAD
#   commitlint.sh --message "<subject>"
set -u

types='feat|fix|docs|refactor|perf|test|build|ci|chore|revert'
scopes='calshare|web|chart|compose|docs'
pattern="^($types)(\(($scopes)\))?!?: [^ ].*"
max=100

check() {
  local subject=$1 where=$2
  case $subject in
    "Merge "* | "Revert \""*) return 0 ;; # created by git or GitHub
  esac
  if ! [[ $subject =~ $pattern ]]; then
    echo "✗ $where: \"$subject\""
    echo "  expected <type>(<scope>): <description>, type: ${types//|/, }, scope (optional): ${scopes//|/, }"
    return 1
  fi
  if ((${#subject} > max)); then
    echo "✗ $where: subject longer than $max characters"
    return 1
  fi
}

if [[ ${1:-} == --message ]]; then
  check "$2" "message"
  exit
fi

status=0
while read -r sha subject; do
  check "$subject" "${sha:0:7}" || status=1
done < <(git log --format='%H %s' "${1:?usage: commitlint.sh <git range> | --message <subject>}")
exit $status
