package local.sixsignage.player;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.content.SharedPreferences;
import android.os.Bundle;
import android.view.View;
import android.view.WindowManager;
import android.webkit.JavascriptInterface;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import org.json.JSONObject;

import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.security.MessageDigest;
import java.security.SecureRandom;

/**
 * 6Signage Player para Android TV.
 * Player em WebView (mesma lógica do cliente Windows) + ponte nativa para
 * configuração persistente e cache de mídia em disco com validação SHA-256.
 * BACK no controle remoto abre a tela de configuração.
 */
public class MainActivity extends Activity {

    private WebView web;
    private SharedPreferences prefs;
    private boolean inSetup = false;

    @SuppressLint("SetJavaScriptEnabled")
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        prefs = getSharedPreferences("6signage", MODE_PRIVATE);

        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);

        web = new WebView(this);
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setAllowFileAccess(true);
        s.setAllowFileAccessFromFileURLs(true);
        s.setAllowUniversalAccessFromFileURLs(true);
        web.setWebViewClient(new WebViewClient());
        web.setBackgroundColor(0xFF000000);
        web.addJavascriptInterface(new Bridge(), "NativeBridge");
        setContentView(web);
        hideSystemUi();

        if (getServer().isEmpty()) openSetup(); else openPlayer();
    }

    private String getServer() { return prefs.getString("server", ""); }

    private void openPlayer() {
        inSetup = false;
        web.loadUrl("file:///android_asset/player.html");
    }

    private void openSetup() {
        inSetup = true;
        web.loadUrl("file:///android_asset/setup.html");
    }

    @Override
    public void onBackPressed() {
        // BACK no controle remoto alterna player <-> configuração
        if (!inSetup) openSetup();
        else if (!getServer().isEmpty()) openPlayer();
        else super.onBackPressed();
    }

    @Override
    public void onWindowFocusChanged(boolean hasFocus) {
        super.onWindowFocusChanged(hasFocus);
        if (hasFocus) hideSystemUi();
    }

    private void hideSystemUi() {
        getWindow().getDecorView().setSystemUiVisibility(
                View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY
                        | View.SYSTEM_UI_FLAG_FULLSCREEN
                        | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
                        | View.SYSTEM_UI_FLAG_LAYOUT_STABLE
                        | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
                        | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION);
    }

    private String deviceKey() {
        String k = prefs.getString("device_key", null);
        if (k == null) {
            byte[] b = new byte[24];
            new SecureRandom().nextBytes(b);
            StringBuilder sb = new StringBuilder();
            for (byte x : b) sb.append(String.format("%02x", x));
            k = sb.toString();
            prefs.edit().putString("device_key", k).apply();
        }
        return k;
    }

    private static String sha256(File f) throws Exception {
        MessageDigest md = MessageDigest.getInstance("SHA-256");
        try (InputStream in = new java.io.FileInputStream(f)) {
            byte[] buf = new byte[65536];
            int n;
            while ((n = in.read(buf)) > 0) md.update(buf, 0, n);
        }
        StringBuilder sb = new StringBuilder();
        for (byte x : md.digest()) sb.append(String.format("%02x", x));
        return sb.toString();
    }

    private class Bridge {

        @JavascriptInterface
        public String getConfig() {
            try {
                JSONObject o = new JSONObject();
                o.put("server", getServer());
                o.put("deviceKey", deviceKey());
                o.put("deviceName", prefs.getString("device_name",
                        android.os.Build.MODEL != null ? "TV_" + android.os.Build.MODEL.replace(" ", "_") : "TV_Android"));
                o.put("osVersion", "Android " + android.os.Build.VERSION.RELEASE);
                return o.toString();
            } catch (Exception e) { return "{}"; }
        }

        @JavascriptInterface
        public void saveConfig(String server, String name) {
            prefs.edit()
                    .putString("server", server.replaceAll("/+$", ""))
                    .putString("device_name", name)
                    .apply();
            runOnUiThread(MainActivity.this::openPlayer);
        }

        /** Roda fora da main thread (thread do binder do WebView): pode bloquear. */
        @JavascriptInterface
        public String testServer(String url) {
            try {
                HttpURLConnection c = (HttpURLConnection) new URL(url.replaceAll("/+$", "") + "/api/health").openConnection();
                c.setConnectTimeout(5000);
                c.setReadTimeout(5000);
                InputStream in = c.getInputStream();
                byte[] buf = new byte[512];
                int n = in.read(buf);
                in.close();
                String body = new String(buf, 0, Math.max(n, 0));
                boolean ok = c.getResponseCode() == 200 && body.contains("6signage");
                return "{\"ok\":" + ok + "}";
            } catch (Exception e) {
                return "{\"ok\":false}";
            }
        }

        /** Baixa mídia para o cache local (assíncrono); responde via __cacheDone(id, path, ok). */
        @JavascriptInterface
        public void cacheMedia(final int id, final String url, final String checksum) {
            new Thread(() -> {
                String result;
                boolean ok = false;
                try {
                    File dir = new File(getFilesDir(), "media_cache");
                    dir.mkdirs();
                    String ext = url.contains(".") ? url.substring(url.lastIndexOf('.')) : "";
                    File dest = new File(dir, checksum + ext);
                    if (!dest.exists()) {
                        File tmp = new File(dir, checksum + ".part");
                        HttpURLConnection c = (HttpURLConnection) new URL(getServer() + url).openConnection();
                        c.setConnectTimeout(10000);
                        try (InputStream in = c.getInputStream(); FileOutputStream out = new FileOutputStream(tmp)) {
                            byte[] buf = new byte[65536];
                            int n;
                            while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
                        }
                        if (checksum != null && !checksum.isEmpty() && !sha256(tmp).equals(checksum)) {
                            tmp.delete();
                            throw new Exception("checksum invalido");
                        }
                        tmp.renameTo(dest);
                    }
                    result = "file://" + dest.getAbsolutePath();
                    ok = true;
                } catch (Exception e) {
                    result = e.getMessage() == null ? "erro" : e.getMessage();
                }
                final String r = result.replace("\\", "\\\\").replace("'", "\\'");
                final boolean okF = ok;
                runOnUiThread(() ->
                        web.evaluateJavascript("__cacheDone(" + id + ",'" + r + "'," + okF + ")", null));
            }).start();
        }
    }
}
