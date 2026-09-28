// Ubuntu's chromium package is a Snap launcher; use the same signed Chrome
// repository as the headed-browser CI image instead.
export function browserRecipe(): string {
  return `DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends curl ca-certificates gnupg xdg-utils libexo-2-0
curl -fsSL https://dl.google.com/linux/linux_signing_key.pub -o /tmp/harness-chrome-key.pub
gpg --batch --yes --dearmor -o /usr/share/keyrings/harness-chrome.gpg /tmp/harness-chrome-key.pub
rm /tmp/harness-chrome-key.pub
echo 'deb [arch=amd64 signed-by=/usr/share/keyrings/harness-chrome.gpg] https://dl.google.com/linux/chrome/deb/ stable main' > /etc/apt/sources.list.d/harness-chrome.list
apt-get update
DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends google-chrome-stable
cat > /usr/local/bin/harness-preview-browser <<'BROWSER'
#!/bin/sh
# Preview desktops run as root inside an isolated VM, like Electron itself.
exec /usr/bin/google-chrome-stable --no-sandbox --disable-dev-shm-usage --no-first-run --no-default-browser-check --user-data-dir="\${HARNESS_PREVIEW_BROWSER_PROFILE:-\${XDG_CONFIG_HOME:-$HOME/.config}/harness-preview-browser}" "$@"
BROWSER
chmod 755 /usr/local/bin/harness-preview-browser
# Chrome's own Applications-menu entry must use the VM launcher as well.
sed -i 's|^Exec=/usr/bin/google-chrome-stable|Exec=/usr/local/bin/harness-preview-browser|' /usr/share/applications/google-chrome.desktop
cat > /usr/share/applications/harness-preview-browser.desktop <<'DESKTOP'
[Desktop Entry]
Type=Application
Name=Web Browser
Exec=/usr/local/bin/harness-preview-browser %U
Icon=google-chrome
Terminal=false
Categories=Network;WebBrowser;
MimeType=text/html;x-scheme-handler/http;x-scheme-handler/https;
DESKTOP
mkdir -p /etc/xdg/xfce4 /usr/share/xfce4/helpers
cat > /usr/share/xfce4/helpers/harness-preview-browser.desktop <<'HELPER'
[Desktop Entry]
Version=1.0
Type=X-XFCE-Helper
Name=Harness Preview Browser
Icon=google-chrome
X-XFCE-Category=WebBrowser
X-XFCE-Commands=/usr/local/bin/harness-preview-browser;
X-XFCE-CommandsWithParameter=/usr/local/bin/harness-preview-browser "%s";
HELPER
printf '[Default Applications]\\ntext/html=harness-preview-browser.desktop\\nx-scheme-handler/http=harness-preview-browser.desktop\\nx-scheme-handler/https=harness-preview-browser.desktop\\n' > /etc/xdg/mimeapps.list
printf 'WebBrowser=harness-preview-browser\\n' > /etc/xdg/xfce4/helpers.rc
update-alternatives --install /usr/bin/x-www-browser x-www-browser /usr/local/bin/harness-preview-browser 250
update-alternatives --set x-www-browser /usr/local/bin/harness-preview-browser
/usr/bin/google-chrome-stable --version`;
}
