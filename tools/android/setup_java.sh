#!/usr/bin/env bash
# Ensures Java 17 (required by Gradle/Android build tools) is active on Ubuntu
set -euo pipefail

echo "==> Checking Java installation"
if java -version 2>&1 | grep -q "17"; then
  echo "Java 17 already active."
  java -version
  exit 0
fi

echo "==> Installing OpenJDK 17"
sudo apt-get update -q
sudo apt-get install -y openjdk-17-jdk

echo "==> Setting Java 17 as default"
sudo update-alternatives --set java "$(update-alternatives --list java | grep java-17)"
sudo update-alternatives --set javac "$(update-alternatives --list javac | grep java-17)"

JAVA_HOME_PATH=$(dirname "$(dirname "$(readlink -f "$(which java)")")")
JAVA_ENV="
# Java 17
export JAVA_HOME=\"${JAVA_HOME_PATH}\"
export PATH=\"\${JAVA_HOME}/bin:\${PATH}\"
"

for PROFILE_FILE in "${HOME}/.bashrc" "${HOME}/.profile"; do
  if ! grep -q "JAVA_HOME" "${PROFILE_FILE}" 2>/dev/null; then
    echo "${JAVA_ENV}" >> "${PROFILE_FILE}"
    echo "  -> Added JAVA_HOME to ${PROFILE_FILE}"
  fi
done

echo ""
echo "Java 17 configured."
echo "  JAVA_HOME: ${JAVA_HOME_PATH}"
java -version
