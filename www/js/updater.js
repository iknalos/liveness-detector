// In-app updates (same scheme as Drift & Bloom / TwoStep): the native Updater plugin reads the
// newest GitHub release's latest.json; when its build number beats this app's, a banner offers
// it, and the plugin downloads the APK, checks its SHA-256 and hands it to Android's installer.

(function () {
  'use strict';
  const $ = id => document.getElementById(id);
  const U = () => window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.Updater;
  let offered = null;

  async function showBuild() {
    let text = 'Web preview';
    try {
      const info = await U().info();
      window.APP_BUILD = info.build;
      text = `Build ${info.build}`;
    } catch (_) {}
    document.querySelectorAll('.build-label').forEach(el => { el.textContent = text; });
  }

  async function check(manual) {
    if (!U()) { if (manual) alert('Updates are only available in the Android app.'); return; }
    try {
      const r = await U().check();
      if (r.available) {
        offered = r;
        $('update-version').textContent = `build ${r.build}${r.notes ? ' · ' + r.notes : ''}`;
        $('update-banner').hidden = false;
      } else if (manual) {
        alert(`You have the newest build (${r.installed}).`);
      }
    } catch (err) {
      if (manual) alert('Could not check for updates: ' + (err.message || err));
    }
  }

  async function update() {
    if (!offered) return;
    const btn = $('btn-update-now');
    btn.disabled = true; btn.textContent = 'Downloading…';
    document.querySelector('.update-progress').hidden = false;
    try {
      await U().update({ apk: offered.apk, sha256: offered.sha256 });
      btn.textContent = 'Installing…';
    } catch (err) {
      alert('Update failed: ' + (err.message || err));
      btn.disabled = false; btn.textContent = 'Update now';
    }
  }

  $('btn-update-now').addEventListener('click', update);
  $('btn-update-later').addEventListener('click', () => { $('update-banner').hidden = true; });
  document.querySelectorAll('.btn-check-update').forEach(b => b.addEventListener('click', () => check(true)));
  if (U()) {
    U().addListener('progress', e => {
      $('update-bar').style.width = `${Math.round((e.fraction >= 0 ? e.fraction : 0.5) * 100)}%`;
    });
  }
  showBuild();
  check(false);
})();
