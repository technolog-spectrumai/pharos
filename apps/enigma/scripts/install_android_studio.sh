#!/usr/bin/env bash
# Installs Android Studio, SDK, NDK, and all build prerequisites on Ubuntu 22.04+
set -euo pipefail

ANDROID_STUDIO_VERSION="2024.3.2.14"
ANDROID_STUDIO_BUILD="android-studio-${ANDROID_STUDIO_VERSION}-linux.tar.gz"
ANDROID_STUDIO_URL="https://redirector.gvt1.com/edgedl/android/studio/ide-zips/${ANDROID_STUDIO_VERSION}/${ANDROID_STUDIO_BUILD}"
INSTALL_DIR="/opt/android-studio"
ANDROID_HOME="${HOME}/Android/Sdk"
NDK_VERSION="27.2.12479018"
BUILD_TOOLS_VERSION="35.0.0"
PLATFORM_VERSION="35"
CMDLINE_TOOLS_VERSION="latest"

echo "==> Installing system dependencies"
sudo dpkg --add-architecture i386
sudo apt-get update -q
sudo apt-get install -y \
  curl wget unzip git openjdk-17-jdk \
  libc6:i386 libncurses6:i386 libstdc++6:i386 lib32z1 libbz2-1.0:i386 \
  libglib2.0-0t64 libxext6 libxrender1 libxtst6 libxi6 \
  libgtk-3-0t64 libdbus-glib-1-2 libxss1 libxxf86vm1 \
  gcc g++ make cmake pkg-config

echo "==> Downloading Android Studio ${ANDROID_STUDIO_VERSION}"
TMP_DIR=$(mktemp -d)
wget -q --show-progress -O "${TMP_DIR}/${ANDROID_STUDIO_BUILD}" "${ANDROID_STUDIO_URL}"

echo "==> Installing Android Studio to ${INSTALL_DIR}"
sudo mkdir -p "${INSTALL_DIR}"
sudo tar -xzf "${TMP_DIR}/${ANDROID_STUDIO_BUILD}" -C /opt/
sudo mv /opt/android-studio "${INSTALL_DIR}" 2>/dev/null || true

# Create desktop entry
sudo tee /usr/share/applications/android-studio.desktop > /dev/null <<EOF
[Desktop Entry]
Version=1.0
Type=Application
Name=Android Studio
Exec=${INSTALL_DIR}/bin/studio.sh
Icon=${INSTALL_DIR}/bin/studio.png
Categories=Development;IDE;
Terminal=false
EOF

echo "==> Installing Android command-line tools"
CMDTOOLS_URL="https://dl.google.com/android/repository/commandlinetools-linux-11076708_latest.zip"
mkdir -p "${ANDROID_HOME}/cmdline-tools"
wget -q --show-progress -O "${TMP_DIR}/cmdline-tools.zip" "${CMDTOOLS_URL}"
unzip -q "${TMP_DIR}/cmdline-tools.zip" -d "${TMP_DIR}/cmdline-tools-extracted"
mkdir -p "${ANDROID_HOME}/cmdline-tools/${CMDLINE_TOOLS_VERSION}"
mv "${TMP_DIR}/cmdline-tools-extracted/cmdline-tools/"* "${ANDROID_HOME}/cmdline-tools/${CMDLINE_TOOLS_VERSION}/"

export ANDROID_HOME="${ANDROID_HOME}"
export PATH="${ANDROID_HOME}/cmdline-tools/${CMDLINE_TOOLS_VERSION}/bin:${ANDROID_HOME}/platform-tools:${PATH}"

echo "==> Accepting SDK licenses"
yes | sdkmanager --licenses > /dev/null 2>&1

echo "==> Installing SDK platform, build-tools, NDK, and platform-tools"
sdkmanager \
  "platform-tools" \
  "platforms;android-${PLATFORM_VERSION}" \
  "build-tools;${BUILD_TOOLS_VERSION}" \
  "ndk;${NDK_VERSION}" \
  "cmake;3.31.6"

echo "==> Writing environment variables to ~/.bashrc and ~/.profile"
ANDROID_ENV="
# Android SDK / NDK
export ANDROID_HOME=\"\${HOME}/Android/Sdk\"
export NDK_HOME=\"\${ANDROID_HOME}/ndk/${NDK_VERSION}\"
export PATH=\"\${ANDROID_HOME}/cmdline-tools/latest/bin:\${ANDROID_HOME}/platform-tools:\${ANDROID_HOME}/emulator:\${PATH}\"
"

for PROFILE_FILE in "${HOME}/.bashrc" "${HOME}/.profile"; do
  if ! grep -q "ANDROID_HOME" "${PROFILE_FILE}" 2>/dev/null; then
    echo "${ANDROID_ENV}" >> "${PROFILE_FILE}"
    echo "  -> Added Android env to ${PROFILE_FILE}"
  fi
done

rm -rf "${TMP_DIR}"

echo ""
echo "Android Studio installation complete."
echo "  ANDROID_HOME : ${ANDROID_HOME}"
echo "  NDK          : ${ANDROID_HOME}/ndk/${NDK_VERSION}"
echo ""
echo "Run 'source ~/.bashrc' or open a new terminal before continuing."
echo "To launch Android Studio: ${INSTALL_DIR}/bin/studio.sh"
