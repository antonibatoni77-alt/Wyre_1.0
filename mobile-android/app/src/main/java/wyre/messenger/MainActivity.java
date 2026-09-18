package wyre.messenger;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.app.DownloadManager;
import android.app.KeyguardManager;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.net.Uri;
import android.net.http.SslError;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.os.Handler;
import android.os.Looper;
import android.text.InputType;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.webkit.CookieManager;
import android.webkit.DownloadListener;
import android.webkit.PermissionRequest;
import android.webkit.SslErrorHandler;
import android.webkit.URLUtil;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.CheckBox;
import android.widget.EditText;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;
import android.widget.Toast;

/**
 * Wyre для Android — оболочка над веб-приложением мессенджера, аналог
 * Windows-приложения на Electron. Всё общение, звонки и вложения остаются
 * в WebView сайта Wyre; здесь только настройки подключения, разрешения
 * камеры/микрофона, биометрический замок приложения (через системный
 * экран блокировки), мост для фоновых push-уведомлений, загрузка файлов
 * и аккуратная обработка офлайна.
 */
public class MainActivity extends Activity {

    public static final String PREFS = "wyre";
    public static final String KEY_SERVER = "server_url";
    public static final String KEY_TRUST_SSL = "trust_ssl";
    public static final String KEY_BIOMETRIC = "biometric_lock";
    public static final String KEY_ACTION_TOKEN = "push_action_token";
    public static final String KEY_FCM_TOKEN = "fcm_token";
    private static final int REQUEST_PERMS = 1;
    private static final int REQUEST_FILE = 2;
    private static final int REQUEST_UNLOCK_APP = 3;
    private static final int REQUEST_UNLOCK_JS = 4;
    /** Повторная блокировка после стольких миллисекунд в фоне. */
    private static final long LOCK_IDLE_MS = 60_000;

    private final Handler handler = new Handler(Looper.getMainLooper());
    private float density = 1f;

    private FrameLayout root;
    private WebView webView;
    private LinearLayout errorOverlay;
    private String serverUrl;
    private boolean trustSsl;
    private ValueCallback<Uri[]> fileChooserCallback;
    private boolean doubleBackToExit = false;
    private long lastPausedAt = 0;
    private boolean appLockShown = false;
    private String pendingJsAuthCallback = null;
    private String pendingOpenChat = null;
    private String pendingOpenCall = null;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        density = getResources().getDisplayMetrics().density;
        SharedPreferences prefs = getSharedPreferences(PREFS, MODE_PRIVATE);
        serverUrl = prefs.getString(KEY_SERVER, "");
        trustSsl = prefs.getBoolean(KEY_TRUST_SSL, false);

        root = new FrameLayout(this);
        root.setBackgroundColor(getResources().getColor(R.color.wyre_bg));
        setContentView(root);

        requestCallPermissions();
        requestNotificationPermission();

        handleOpenIntent(getIntent());

        if (serverUrl.isEmpty()) {
            showSettingsScreen();
        } else {
            showWebView();
        }
    }

    private void requestCallPermissions() {
        if (checkSelfPermission(android.Manifest.permission.CAMERA) != PackageManager.PERMISSION_GRANTED
                || checkSelfPermission(android.Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(new String[]{
                    android.Manifest.permission.CAMERA,
                    android.Manifest.permission.RECORD_AUDIO,
                    android.Manifest.permission.MODIFY_AUDIO_SETTINGS,
            }, REQUEST_PERMS);
        }
    }

    private void requestNotificationPermission() {
        if (Build.VERSION.SDK_INT >= 33
                && checkSelfPermission(android.Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(new String[]{android.Manifest.permission.POST_NOTIFICATIONS}, REQUEST_PERMS);
        }
    }

    /** Deep link из уведомления: конкретный чат или экран входящего звонка. */
    private void handleOpenIntent(Intent intent) {
        if (intent == null) return;
        String chat = intent.getStringExtra("chat");
        String call = intent.getStringExtra("callId");
        if (chat != null && !chat.isEmpty()) pendingOpenChat = chat;
        if (call != null && !call.isEmpty()) pendingOpenCall = call;
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        handleOpenIntent(intent);
        openPendingLink();
    }

    /** Открывает отложенную ссылку, как только WebView загрузил приложение. */
    private void openPendingLink() {
        if (webView == null) return;
        if (pendingOpenChat != null) {
            String target = serverUrl + "/?chat=" + Uri.encode(pendingOpenChat);
            pendingOpenChat = null;
            pendingOpenCall = null;
            webView.loadUrl(target);
        } else if (pendingOpenCall != null) {
            pendingOpenCall = null;
            // Экран звонка рисует само приложение из wyre.callState.
            webView.loadUrl(serverUrl);
        }
    }

    // --- Экран настроек -------------------------------------------------------

    private int dp(float value) {
        return Math.round(value * density);
    }

    private GradientDrawable accentButtonBackground() {
        GradientDrawable drawable = new GradientDrawable(
                GradientDrawable.Orientation.TL_BR,
                new int[]{0xFF8B5CF6, 0xFF2563EB});
        drawable.setCornerRadius(dp(12));
        return drawable;
    }

    private GradientDrawable fieldBackground() {
        GradientDrawable drawable = new GradientDrawable();
        drawable.setColor(0xFF151927);
        drawable.setCornerRadius(dp(12));
        drawable.setStroke(Math.max(1, dp(1)), 0x26FFFFFF);
        return drawable;
    }

    private void showSettingsScreen() {
        ScrollView scroll = new ScrollView(this);
        scroll.setFillViewport(true);
        scroll.setBackgroundColor(getResources().getColor(R.color.wyre_bg));

        LinearLayout box = new LinearLayout(this);
        box.setOrientation(LinearLayout.VERTICAL);
        box.setGravity(Gravity.CENTER_HORIZONTAL);
        box.setPadding(dp(24), dp(48), dp(24), dp(24));
        scroll.addView(box, new ViewGroup.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));

        TextView logo = new TextView(this);
        logo.setText("W");
        logo.setTextColor(Color.WHITE);
        logo.setTypeface(Typeface.DEFAULT_BOLD);
        logo.setTextSize(30);
        logo.setGravity(Gravity.CENTER);
        GradientDrawable logoBg = accentButtonBackground();
        logoBg.setCornerRadius(dp(20));
        logo.setBackground(logoBg);
        box.addView(logo, new LinearLayout.LayoutParams(dp(72), dp(72)));

        TextView title = new TextView(this);
        title.setText("Wyre");
        title.setTextColor(getResources().getColor(R.color.wyre_text));
        title.setTypeface(Typeface.DEFAULT_BOLD);
        title.setTextSize(22);
        title.setPadding(0, dp(16), 0, 0);
        title.setGravity(Gravity.CENTER);
        box.addView(title, new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT));

        TextView subtitle = new TextView(this);
        subtitle.setText("Приватный мессенджер для семьи");
        subtitle.setTextColor(getResources().getColor(R.color.wyre_muted));
        subtitle.setTextSize(13);
        subtitle.setPadding(0, dp(4), 0, dp(28));
        subtitle.setGravity(Gravity.CENTER);
        box.addView(subtitle, new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT));

        TextView label = new TextView(this);
        label.setText("Адрес сервера");
        label.setTextColor(getResources().getColor(R.color.wyre_muted));
        label.setTextSize(12);
        label.setTypeface(Typeface.DEFAULT_BOLD);
        label.setPadding(0, 0, 0, dp(6));
        box.addView(label, new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));

        EditText input = new EditText(this);
        input.setHint("https://wyre.example.com");
        input.setText(serverUrl);
        input.setTextColor(getResources().getColor(R.color.wyre_text));
        input.setHintTextColor(getResources().getColor(R.color.wyre_muted));
        input.setInputType(InputType.TYPE_TEXT_VARIATION_URI);
        input.setBackground(fieldBackground());
        input.setPadding(dp(14), dp(12), dp(14), dp(12));
        input.setTextSize(14);
        box.addView(input, new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));

        CheckBox trust = new CheckBox(this);
        trust.setText("Доверять самоподписанному сертификату сервера (только для локальной сети)");
        trust.setTextColor(getResources().getColor(R.color.wyre_muted));
        trust.setTextSize(12);
        trust.setChecked(trustSsl);
        trust.setPadding(0, dp(10), 0, dp(6));
        box.addView(trust, new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));

        SharedPreferences prefsForSettings = getSharedPreferences(PREFS, MODE_PRIVATE);
        CheckBox biometric = new CheckBox(this);
        biometric.setText("Биометрический замок приложения (отпечаток, лицо или код блокировки)");
        biometric.setTextColor(getResources().getColor(R.color.wyre_muted));
        biometric.setTextSize(12);
        biometric.setChecked(prefsForSettings.getBoolean(KEY_BIOMETRIC, true));
        biometric.setPadding(0, dp(0), 0, dp(18));
        box.addView(biometric, new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));

        Button save = new Button(this);
        save.setText("Сохранить и открыть");
        save.setTextColor(Color.WHITE);
        save.setTypeface(Typeface.DEFAULT_BOLD);
        save.setBackground(accentButtonBackground());
        save.setPadding(dp(16), dp(12), dp(16), dp(12));
        save.setOnClickListener(view -> {
            String value = input.getText().toString().trim().replaceAll("/+$", "");
            if (!value.isEmpty() && !value.startsWith("http")) value = "https://" + value;
            if (!value.startsWith("https://") && !value.startsWith("http://")) {
                Toast.makeText(this, "Введите адрес сервера, например https://192.168.1.7:3000", Toast.LENGTH_LONG).show();
                return;
            }
            serverUrl = value;
            trustSsl = trust.isChecked();
            getSharedPreferences(PREFS, MODE_PRIVATE).edit()
                    .putString(KEY_SERVER, serverUrl)
                    .putBoolean(KEY_TRUST_SSL, trustSsl)
                    .putBoolean(KEY_BIOMETRIC, biometric.isChecked())
                    .apply();
            requestCallPermissions();
            showWebView();
        });
        box.addView(save, new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));

        root.removeAllViews();
        root.addView(scroll, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
    }

    // --- WebView ---------------------------------------------------------------

    @SuppressLint("SetJavaScriptEnabled")
    private void showWebView() {
        root.removeAllViews();
        errorOverlay = null;

        if (webView == null) {
            webView = new WebView(this);
            webView.setBackgroundColor(getResources().getColor(R.color.wyre_bg));
            WebSettings settings = webView.getSettings();
            settings.setJavaScriptEnabled(true);
            settings.setDomStorageEnabled(true);
            settings.setDatabaseEnabled(true);
            settings.setMediaPlaybackRequiresUserGesture(false);
            settings.setSupportZoom(false);
            settings.setDisplayZoomControls(false);
            settings.setAllowFileAccess(true);
            settings.setAllowContentAccess(true);
            CookieManager.getInstance().setAcceptCookie(true);

            // Service worker: офлайн-оболочка «как в последний раз» — та же,
            // что и в Windows-приложении (кэш запросов уже работает через
            // включённое DOM-хранилище).
            try {
                android.webkit.ServiceWorkerController swController = android.webkit.ServiceWorkerController.getInstance();
                android.webkit.ServiceWorkerWebSettings swSettings = swController.getServiceWorkerWebSettings();
                swSettings.setAllowFileAccess(false);
                swSettings.setAllowContentAccess(false);
            } catch (Exception ignored) {
                // На некоторых оболочках контроллер недоступен — офлайн-режим
                // тогда ограничивается кэшем запросов в localStorage.
            }

            // Мост для биометрии и фоновых push (см. utils/native.ts).
            webView.addJavascriptInterface(new WyreNativeBridge(), "WyreNative");

            webView.setWebViewClient(new WebViewClient() {
                @Override
                public void onReceivedSslError(WebView view, SslErrorHandler handler, SslError error) {
                    // Локальный сервер разработки использует самоподписанный
                    // сертификат; пользователь явно включил доверие к нему.
                    if (trustSsl && error.getUrl() != null && error.getUrl().startsWith(serverUrl)) {
                        handler.proceed();
                    } else {
                        handler.cancel();
                        Toast.makeText(MainActivity.this, "Сертификат сервера не является доверенным", Toast.LENGTH_LONG).show();
                    }
                }

                @SuppressWarnings("deprecation")
                @Override
                public boolean shouldOverrideUrlLoading(WebView view, String url) {
                    // Внешние схемы (mailto:, tel:, intent:) отдаём системе.
                    if (url != null && !url.startsWith("http://") && !url.startsWith("https://")
                            && !url.startsWith("about:") && !url.startsWith("blob:") && !url.startsWith("data:")) {
                        try {
                            startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(url)));
                        } catch (Exception ignored) {
                        }
                        return true;
                    }
                    return false;
                }

                @SuppressWarnings("deprecation")
                @Override
                public void onReceivedError(WebView view, int errorCode, String description, String failingUrl) {
                    // Показываем спокойный офлайн-экран только когда недоступен
                    // сам сервер Wyre, а не отдельный подресурс.
                    if (failingUrl != null && failingUrl.startsWith(serverUrl)
                            && (errorCode == ERROR_HOST_LOOKUP
                                || errorCode == ERROR_CONNECT
                                || errorCode == ERROR_TIMEOUT
                                || errorCode == ERROR_PROXY_AUTHENTICATION)) {
                        showErrorOverlay();
                    }
                }
            });

            webView.setWebChromeClient(new WebChromeClient() {
                @Override
                public void onPermissionRequest(final PermissionRequest request) {
                    // Камера и микрофон для звонков: сайт сам показывает свои
                    // экраны согласия, здесь только системная часть.
                    runOnUiThread(() -> {
                        for (String resource : request.getResources()) {
                            if (PermissionRequest.RESOURCE_AUDIO_CAPTURE.equals(resource)
                                    && checkSelfPermission(android.Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
                                request.deny();
                                return;
                            }
                            if (PermissionRequest.RESOURCE_VIDEO_CAPTURE.equals(resource)
                                    && checkSelfPermission(android.Manifest.permission.CAMERA) != PackageManager.PERMISSION_GRANTED) {
                                request.deny();
                                return;
                            }
                        }
                        request.grant(request.getResources());
                    });
                }

                @Override
                public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback, FileChooserParams params) {
                    if (fileChooserCallback != null) fileChooserCallback.onReceiveValue(null);
                    fileChooserCallback = callback;
                    Intent intent = new Intent(Intent.ACTION_GET_CONTENT);
                    intent.addCategory(Intent.CATEGORY_OPENABLE);
                    intent.setType("*/*");
                    try {
                        startActivityForResult(Intent.createChooser(intent, "Выбрать файл"), REQUEST_FILE);
                    } catch (Exception e) {
                        fileChooserCallback = null;
                        Toast.makeText(MainActivity.this, "Не удалось открыть выбор файла", Toast.LENGTH_SHORT).show();
                        return false;
                    }
                    return true;
                }
            });

            // Вложения скачиваются системным менеджером загрузок.
            webView.setDownloadListener(new DownloadListener() {
                @Override
                public void onDownloadStart(String url, String userAgent, String contentDisposition, String mimeType, long contentLength) {
                    try {
                        DownloadManager.Request request = new DownloadManager.Request(Uri.parse(url));
                        request.setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED);
                        String cookie = CookieManager.getInstance().getCookie(url);
                        if (cookie != null) request.addRequestHeader("Cookie", cookie);
                        String name = URLUtil.guessFileName(url, contentDisposition, mimeType);
                        request.setDestinationInExternalPublicDir(Environment.DIRECTORY_DOWNLOADS, name);
                        DownloadManager manager = (DownloadManager) getSystemService(DOWNLOAD_SERVICE);
                        manager.enqueue(request);
                        Toast.makeText(MainActivity.this, "Загрузка: " + name, Toast.LENGTH_SHORT).show();
                    } catch (Exception e) {
                        Toast.makeText(MainActivity.this, "Не удалось начать загрузку", Toast.LENGTH_SHORT).show();
                    }
                }
            });
        }

        root.addView(webView, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        if (webView.getUrl() == null || !webView.getUrl().startsWith(serverUrl)) {
            webView.loadUrl(serverUrl);
        }
        openPendingLink();
    }

    private void evalJs(String script) {
        runOnUiThread(() -> {
            if (webView != null) webView.evaluateJavascript(script, null);
        });
    }

    private static String jsString(String value) {
        return "\"" + value.replace("\\", "\\\\").replace("\"", "\\\"").replace("\n", "\\n").replace("\r", "\\r") + "\"";
    }

    /** Мост window.WyreNative: биометрия, токен действий, FCM-токен. */
    public class WyreNativeBridge {

        /** Системный экран блокировки доступен и замок приложения включён. */
        @android.webkit.JavascriptInterface
        public boolean biometricAvailable() {
            KeyguardManager keyguard = getSystemService(KeyguardManager.class);
            boolean enabled = getSharedPreferences(PREFS, MODE_PRIVATE).getBoolean(KEY_BIOMETRIC, true);
            return enabled && keyguard != null && keyguard.isKeyguardSecure();
        }

        /** Показывает системное подтверждение блокировки устройства. */
        @android.webkit.JavascriptInterface
        public void authenticate(final String reason, final String callbackId) {
            if (!callbackId.matches("[A-Za-z0-9\\-]+")) return;
            runOnUiThread(() -> {
                KeyguardManager keyguard = getSystemService(KeyguardManager.class);
                if (keyguard == null || !keyguard.isKeyguardSecure()) {
                    evalJs("window.__wyreNativeResult && window.__wyreNativeResult(" + jsString(callbackId) + ", false)");
                    return;
                }
                try {
                    pendingJsAuthCallback = callbackId;
                    startActivityForResult(
                            keyguard.createConfirmDeviceCredentialIntent(reason, "Подтвердите действие"),
                            REQUEST_UNLOCK_JS);
                } catch (Exception e) {
                    pendingJsAuthCallback = null;
                    evalJs("window.__wyreNativeResult && window.__wyreNativeResult(" + jsString(callbackId) + ", false)");
                }
            });
        }

        /** Веб-приложение передаёт токен кнопок уведомлений. */
        @android.webkit.JavascriptInterface
        public void setPushActionToken(String token) {
            if (token == null || token.isEmpty()) return;
            getSharedPreferences(PREFS, MODE_PRIVATE).edit().putString(KEY_ACTION_TOKEN, token).apply();
        }

        /** Отдаёт веб-приложению текущий FCM-токен для регистрации на сервере. */
        @android.webkit.JavascriptInterface
        public void requestFcmToken() {
            String cached = getSharedPreferences(PREFS, MODE_PRIVATE).getString(KEY_FCM_TOKEN, "");
            if (!cached.isEmpty()) {
                evalJs("window.__wyreFcmToken && window.__wyreFcmToken(" + jsString(cached) + ")");
                return;
            }
            try {
                com.google.firebase.messaging.FirebaseMessaging.getInstance().getToken()
                        .addOnSuccessListener(token -> {
                            getSharedPreferences(PREFS, MODE_PRIVATE).edit().putString(KEY_FCM_TOKEN, token).apply();
                            evalJs("window.__wyreFcmToken && window.__wyreFcmToken(" + jsString(token) + ")");
                        });
            } catch (Exception ignored) {
                // Firebase не настроен (нет google-services.json) — фоновый
                // push остаётся недоступен, это честное ограничение.
            }
        }
    }

    // --- Биометрический замок приложения ---------------------------------------

    private void lockAppIfDue() {
        SharedPreferences prefs = getSharedPreferences(PREFS, MODE_PRIVATE);
        if (!prefs.getBoolean(KEY_BIOMETRIC, true)) return;
        KeyguardManager keyguard = getSystemService(KeyguardManager.class);
        if (keyguard == null || !keyguard.isKeyguardSecure()) return;
        if (lastPausedAt != 0 && System.currentTimeMillis() - lastPausedAt < LOCK_IDLE_MS) return;
        if (appLockShown) return;
        appLockShown = true;
        try {
            startActivityForResult(
                    keyguard.createConfirmDeviceCredentialIntent("Wyre заблокировано", "Подтвердите, что это вы"),
                    REQUEST_UNLOCK_APP);
        } catch (Exception e) {
            appLockShown = false;
        }
    }

    /** Спокойный офлайн-экран вместо системной ошибки: повтор или настройки. */
    private void showErrorOverlay() {
        if (errorOverlay != null || webView == null) return;
        errorOverlay = new LinearLayout(this);
        errorOverlay.setOrientation(LinearLayout.VERTICAL);
        errorOverlay.setGravity(Gravity.CENTER);
        errorOverlay.setBackgroundColor(0xF20B0C12);
        errorOverlay.setPadding(dp(24), 0, dp(24), 0);

        TextView logo = new TextView(this);
        logo.setText("W");
        logo.setTextColor(Color.WHITE);
        logo.setTypeface(Typeface.DEFAULT_BOLD);
        logo.setTextSize(26);
        logo.setGravity(Gravity.CENTER);
        GradientDrawable logoBg = accentButtonBackground();
        logoBg.setCornerRadius(dp(18));
        logo.setBackground(logoBg);
        errorOverlay.addView(logo, new LinearLayout.LayoutParams(dp(64), dp(64)));

        TextView text = new TextView(this);
        text.setText("Wyre");
        text.setTextColor(getResources().getColor(R.color.wyre_text));
        text.setTypeface(Typeface.DEFAULT_BOLD);
        text.setTextSize(18);
        text.setGravity(Gravity.CENTER);
        text.setPadding(0, dp(14), 0, dp(4));
        errorOverlay.addView(text, new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT));

        TextView hint = new TextView(this);
        hint.setText("Ждём соединение с сервером");
        hint.setTextColor(getResources().getColor(R.color.wyre_muted));
        hint.setTextSize(13);
        hint.setGravity(Gravity.CENTER);
        hint.setPadding(0, 0, 0, dp(24));
        errorOverlay.addView(hint, new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT));

        Button retry = new Button(this);
        retry.setText("Повторить");
        retry.setTextColor(Color.WHITE);
        retry.setTypeface(Typeface.DEFAULT_BOLD);
        retry.setBackground(accentButtonBackground());
        retry.setPadding(dp(18), dp(10), dp(18), dp(10));
        retry.setOnClickListener(view -> {
            root.removeView(errorOverlay);
            errorOverlay = null;
            webView.reload();
        });
        errorOverlay.addView(retry, new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));

        Button settings = new Button(this);
        settings.setText("Настройки подключения");
        settings.setTextColor(getResources().getColor(R.color.wyre_muted));
        settings.setBackground(null);
        settings.setTextSize(12);
        settings.setOnClickListener(view -> showSettingsScreen());
        errorOverlay.addView(settings, new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));

        root.addView(errorOverlay, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
    }

    // --- Прочее -----------------------------------------------------------------

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        if (requestCode == REQUEST_FILE && fileChooserCallback != null) {
            Uri[] results = null;
            if (resultCode == RESULT_OK && data != null && data.getData() != null) {
                results = new Uri[]{data.getData()};
            }
            fileChooserCallback.onReceiveValue(results);
            fileChooserCallback = null;
            return;
        }
        if (requestCode == REQUEST_UNLOCK_APP) {
            if (resultCode == RESULT_OK) {
                appLockShown = false;
            } else {
                // Отказались подтверждать — прячем приложение, данные остаются
                // под замком до следующего открытия.
                appLockShown = false;
                lastPausedAt = System.currentTimeMillis();
                moveTaskToBack(true);
            }
            return;
        }
        if (requestCode == REQUEST_UNLOCK_JS) {
            String callbackId = pendingJsAuthCallback;
            pendingJsAuthCallback = null;
            if (callbackId != null) {
                boolean ok = resultCode == RESULT_OK;
                evalJs("window.__wyreNativeResult && window.__wyreNativeResult(" + jsString(callbackId) + ", " + ok + ")");
            }
            return;
        }
        super.onActivityResult(requestCode, resultCode, data);
    }

    @Override
    public void onBackPressed() {
        if (webView != null && webView.canGoBack()) {
            webView.goBack();
            return;
        }
        if (doubleBackToExit) {
            super.onBackPressed();
            return;
        }
        doubleBackToExit = true;
        Toast.makeText(this, "Нажмите «Назад» ещё раз, чтобы выйти", Toast.LENGTH_SHORT).show();
        handler.postDelayed(() -> doubleBackToExit = false, 2000);
    }

    @Override
    protected void onPause() {
        lastPausedAt = System.currentTimeMillis();
        if (webView != null) webView.onPause();
        super.onPause();
    }

    @Override
    protected void onResume() {
        super.onResume();
        if (webView != null) webView.onResume();
        lockAppIfDue();
    }

    @Override
    protected void onDestroy() {
        if (webView != null) {
            webView.destroy();
            webView = null;
        }
        super.onDestroy();
    }
}
