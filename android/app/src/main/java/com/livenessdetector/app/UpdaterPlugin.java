package com.livenessdetector.app;

import android.content.Intent;
import android.content.pm.PackageInfo;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;
import androidx.core.content.FileProvider;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import org.json.JSONObject;

/**
 * In-app updates, the way Drift & Bloom and TwoStep do them: read the newest release's
 * latest.json, and when its build number beats this one, download the APK, check its SHA-256
 * and hand it to the system installer. Android only installs it over this app when it is
 * signed with the same key, so the registered face (WebView storage) carries over.
 */
@CapacitorPlugin(name = "Updater")
public class UpdaterPlugin extends Plugin {

    private static final String REPO = "iknalos/liveness-detector";
    private static final String LATEST_URL = "https://github.com/" + REPO + "/releases/latest/download/latest.json";
    private static final String APK_PREFIX = "https://github.com/" + REPO + "/releases/download/";

    private final ExecutorService io = Executors.newSingleThreadExecutor();
    private File pendingApk;

    private long installedBuild() throws Exception {
        PackageInfo pi = getContext().getPackageManager().getPackageInfo(getContext().getPackageName(), 0);
        return Build.VERSION.SDK_INT >= 28 ? pi.getLongVersionCode() : pi.versionCode;
    }

    @PluginMethod
    public void info(PluginCall call) {
        try {
            PackageInfo pi = getContext().getPackageManager().getPackageInfo(getContext().getPackageName(), 0);
            JSObject r = new JSObject();
            r.put("build", installedBuild());
            r.put("version", pi.versionName);
            call.resolve(r);
        } catch (Exception e) {
            call.reject(e.getMessage());
        }
    }

    @PluginMethod
    public void check(PluginCall call) {
        io.execute(() -> {
            HttpURLConnection conn = null;
            try {
                long installed = installedBuild();
                conn = open(LATEST_URL);
                int code = conn.getResponseCode();
                JSObject r = new JSObject();
                r.put("installed", installed);
                if (code == 404) {               // nothing released yet
                    r.put("available", false);
                    call.resolve(r);
                    return;
                }
                if (code != 200) throw new IOException("GitHub answered HTTP " + code);
                JSONObject o = new JSONObject(readAll(conn.getInputStream()));
                long build = o.getLong("build");
                r.put("available", build > installed);
                r.put("build", build);
                r.put("version", o.optString("version"));
                r.put("apk", o.getString("apk"));
                r.put("sha256", o.getString("sha256").toLowerCase());
                r.put("notes", o.optString("notes"));
                call.resolve(r);
            } catch (Exception e) {
                call.reject(e.getMessage() != null ? e.getMessage() : e.toString());
            } finally {
                if (conn != null) conn.disconnect();
            }
        });
    }

    @PluginMethod
    public void update(PluginCall call) {
        String apk = call.getString("apk", "");
        String sha = call.getString("sha256", "").toLowerCase();
        if (!apk.startsWith(APK_PREFIX)) {
            call.reject("Refusing an update from outside " + REPO);
            return;
        }
        io.execute(() -> {
            HttpURLConnection conn = null;
            try {
                File dir = new File(getContext().getCacheDir(), "updates");
                if (!dir.exists() && !dir.mkdirs()) throw new IOException("No room for the download");
                File out = new File(dir, "update.apk");
                conn = open(apk);
                if (conn.getResponseCode() != 200) throw new IOException("Download failed: HTTP " + conn.getResponseCode());
                long total = conn.getContentLength();
                MessageDigest digest = MessageDigest.getInstance("SHA-256");
                try (InputStream in = conn.getInputStream(); OutputStream os = new FileOutputStream(out)) {
                    byte[] buf = new byte[64 * 1024];
                    long got = 0, last = 0;
                    int n;
                    while ((n = in.read(buf)) >= 0) {
                        os.write(buf, 0, n);
                        digest.update(buf, 0, n);
                        got += n;
                        long now = System.currentTimeMillis();
                        if (now - last > 120) {
                            last = now;
                            JSObject p = new JSObject();
                            p.put("fraction", total > 0 ? (double) got / total : -1);
                            notifyListeners("progress", p);
                        }
                    }
                }
                StringBuilder hex = new StringBuilder();
                for (byte b : digest.digest()) hex.append(String.format("%02x", b));
                if (!hex.toString().equals(sha)) {
                    //noinspection ResultOfMethodCallIgnored
                    out.delete();
                    throw new IOException("The download was damaged (checksum mismatch). Try again.");
                }
                JSObject p = new JSObject();
                p.put("fraction", 1.0);
                notifyListeners("progress", p);
                pendingApk = out;
                getActivity().runOnUiThread(this::installOrAsk);
                call.resolve();
            } catch (Exception e) {
                call.reject(e.getMessage() != null ? e.getMessage() : e.toString());
            } finally {
                if (conn != null) conn.disconnect();
            }
        });
    }

    /** First time only, Android asks to allow installs from this app; we resume on return. */
    private void installOrAsk() {
        if (pendingApk == null) return;
        if (Build.VERSION.SDK_INT >= 26 && !getContext().getPackageManager().canRequestPackageInstalls()) {
            Intent i = new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
                    Uri.parse("package:" + getContext().getPackageName()));
            getActivity().startActivity(i);
            return;
        }
        Uri uri = FileProvider.getUriForFile(getContext(), getContext().getPackageName() + ".fileprovider", pendingApk);
        Intent i = new Intent(Intent.ACTION_VIEW)
                .setDataAndType(uri, "application/vnd.android.package-archive")
                .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_ACTIVITY_NEW_TASK);
        getActivity().startActivity(i);
        pendingApk = null;
    }

    @Override
    protected void handleOnResume() {
        super.handleOnResume();
        if (pendingApk != null && (Build.VERSION.SDK_INT < 26 || getContext().getPackageManager().canRequestPackageInstalls())) {
            installOrAsk();
        }
    }

    private static HttpURLConnection open(String url) throws IOException {
        HttpURLConnection c = (HttpURLConnection) new URL(url).openConnection();   // follows GitHub's https redirects
        c.setConnectTimeout(15000);
        c.setReadTimeout(30000);
        c.setUseCaches(false);
        c.setRequestProperty("Cache-Control", "no-cache");
        c.setRequestProperty("User-Agent", "LivenessCheck-Android");
        return c;
    }

    private static String readAll(InputStream in) throws IOException {
        try (InputStream s = in) {
            java.io.ByteArrayOutputStream bo = new java.io.ByteArrayOutputStream();
            byte[] buf = new byte[8192];
            int n;
            while ((n = s.read(buf)) >= 0) bo.write(buf, 0, n);
            return new String(bo.toByteArray(), StandardCharsets.UTF_8);
        }
    }
}
