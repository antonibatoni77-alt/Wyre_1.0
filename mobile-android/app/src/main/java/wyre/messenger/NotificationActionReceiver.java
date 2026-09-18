package wyre.messenger;

import android.app.NotificationManager;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;

import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;

/**
 * Notification action buttons (Ответить / Прочитано / Принять / Отклонить).
 * Acts through the server's /api/push-action/* endpoints with the opaque
 * action token the web app handed to the shell — no session cookie needed.
 */
public class NotificationActionReceiver extends BroadcastReceiver {

    public static final String ACTION_READ = "wyre.messenger.ACTION_READ";
    public static final String ACTION_REPLY = "wyre.messenger.ACTION_REPLY";
    public static final String ACTION_CALL = "wyre.messenger.ACTION_CALL";

    @Override
    public void onReceive(Context context, Intent intent) {
        String action = intent.getAction();
        if (action == null) return;

        int notificationId = intent.getIntExtra("notificationId", -1);
        NotificationManager manager = (NotificationManager) context.getSystemService(Context.NOTIFICATION_SERVICE);
        if (manager != null && notificationId != -1) manager.cancel(notificationId);

        final PendingResult result = goAsync();
        new Thread(() -> {
            try {
                SharedPreferences prefs = context.getSharedPreferences(MainActivity.PREFS, Context.MODE_PRIVATE);
                String serverUrl = prefs.getString(MainActivity.KEY_SERVER, "");
                String actionToken = prefs.getString(MainActivity.KEY_ACTION_TOKEN, "");
                if (serverUrl.isEmpty() || actionToken.isEmpty()) return;

                String endpoint;
                String body;
                if (ACTION_READ.equals(action)) {
                    String chatId = intent.getStringExtra("chatId");
                    if (chatId == null || chatId.isEmpty()) return;
                    endpoint = "/api/push-action/read";
                    body = "{\"token\":\"" + escape(actionToken) + "\",\"chatId\":\"" + escape(chatId) + "\"}";
                } else if (ACTION_REPLY.equals(action)) {
                    String chatId = intent.getStringExtra("chatId");
                    CharSequence text = getReplyText(intent);
                    if (chatId == null || chatId.isEmpty() || text == null || text.length() == 0) return;
                    endpoint = "/api/push-action/reply";
                    body = "{\"token\":\"" + escape(actionToken) + "\",\"chatId\":\"" + escape(chatId)
                            + "\",\"text\":\"" + escape(text.toString()) + "\"}";
                } else if (ACTION_CALL.equals(action)) {
                    String callId = intent.getStringExtra("callId");
                    if (callId == null || callId.isEmpty()) return;
                    boolean accept = intent.getBooleanExtra("accept", false);
                    endpoint = "/api/push-action/call";
                    body = "{\"token\":\"" + escape(actionToken) + "\",\"callId\":\"" + escape(callId)
                            + "\",\"accept\":" + accept + "}";
                } else {
                    return;
                }

                post(serverUrl + endpoint, body);
            } catch (Exception ignored) {
                // A failed notification action is simply dropped; the user can
                // always act inside the app.
            } finally {
                result.finish();
            }
        }, "wyre-push-action").start();
    }

    private static CharSequence getReplyText(Intent intent) {
        android.os.Bundle results = android.app.RemoteInput.getResultsFromIntent(intent);
        if (results == null) return null;
        return results.getCharSequence(WyreFirebaseMessagingService.KEY_REPLY_TEXT);
    }

    private static void post(String url, String jsonBody) throws Exception {
        HttpURLConnection connection = (HttpURLConnection) new URL(url).openConnection();
        try {
            connection.setRequestMethod("POST");
            connection.setConnectTimeout(10_000);
            connection.setReadTimeout(10_000);
            connection.setDoOutput(true);
            connection.setRequestProperty("Content-Type", "application/json");
            byte[] bytes = jsonBody.getBytes(StandardCharsets.UTF_8);
            try (OutputStream output = connection.getOutputStream()) {
                output.write(bytes);
            }
            connection.getResponseCode();
        } finally {
            connection.disconnect();
        }
    }

    /** Minimal JSON string escaping for token/chatId/text values. */
    private static String escape(String value) {
        StringBuilder builder = new StringBuilder(value.length() + 8);
        for (int i = 0; i < value.length(); i++) {
            char c = value.charAt(i);
            if (c == '"' || c == '\\') builder.append('\\').append(c);
            else if (c == '\n') builder.append("\\n");
            else if (c == '\r') builder.append("\\r");
            else if (c == '\t') builder.append("\\t");
            else if (c < 0x20) builder.append(String.format("\\u%04x", (int) c));
            else builder.append(c);
        }
        return builder.toString();
    }
}
