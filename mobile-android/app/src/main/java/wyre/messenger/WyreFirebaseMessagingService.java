package wyre.messenger;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.RemoteInput;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.media.RingtoneManager;
import android.os.Build;

import com.google.firebase.messaging.FirebaseMessagingService;
import com.google.firebase.messaging.RemoteMessage;

/**
 * Background push for Wyre Android. The server sends FCM data messages:
 * type=message — new chat message (reply / mark-read buttons),
 * type=call — incoming call (accept / decline buttons + full-screen intent).
 * The app always builds its own toasts so channels and buttons stay correct.
 */
public class WyreFirebaseMessagingService extends FirebaseMessagingService {

    public static final String CHANNEL_MESSAGES = "wyre_messages";
    public static final String CHANNEL_CALLS = "wyre_calls";
    public static final String KEY_REPLY_TEXT = "wyre_reply_text";

    public static final int NOTIFICATION_MESSAGE_BASE = 10001;
    public static final int NOTIFICATION_CALL_ID = 90001;

    @Override
    public void onNewToken(String token) {
        // The web app registers the token with the server (wyre.registerFcmToken)
        // through the bridge; here we only remember the latest value.
        getSharedPreferences(MainActivity.PREFS, MODE_PRIVATE)
                .edit().putString(MainActivity.KEY_FCM_TOKEN, token).apply();
    }

    @Override
    public void onMessageReceived(RemoteMessage message) {
        var data = message.getData();
        if (data == null || data.isEmpty()) return;
        String type = data.get("type");
        if ("call".equals(type)) {
            showCallNotification(data);
        } else if ("message".equals(type)) {
            showMessageNotification(data);
        }
    }

    private void ensureChannels() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        NotificationManager manager = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
        if (manager == null) return;
        NotificationChannel messages = new NotificationChannel(CHANNEL_MESSAGES, "Сообщения", NotificationManager.IMPORTANCE_HIGH);
        messages.setDescription("Новые сообщения в чатах");
        NotificationChannel calls = new NotificationChannel(CHANNEL_CALLS, "Звонки", NotificationManager.IMPORTANCE_HIGH);
        calls.setDescription("Входящие звонки");
        calls.setSound(RingtoneManager.getDefaultUri(RingtoneManager.TYPE_RINGTONE), null);
        calls.enableVibration(true);
        manager.createNotificationChannel(messages);
        manager.createNotificationChannel(calls);
    }

    private void showMessageNotification(java.util.Map<String, String> data) {
        String title = valueOr(data.get("title"), "Wyre");
        String body = valueOr(data.get("body"), "Новое сообщение");
        String chatId = valueOr(data.get("chatId"), "");
        String eventId = valueOr(data.get("eventId"), title + body);
        int notificationId = NOTIFICATION_MESSAGE_BASE + (eventId.hashCode() & 0x7ffff);

        ensureChannels();
        Intent open = new Intent(this, MainActivity.class);
        open.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        open.putExtra("chat", chatId);
        PendingIntent contentIntent = PendingIntent.getActivity(
                this, notificationId, open,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);

        Intent read = new Intent(this, NotificationActionReceiver.class);
        read.setAction(NotificationActionReceiver.ACTION_READ);
        read.putExtra("chatId", chatId);
        read.putExtra("notificationId", notificationId);
        PendingIntent readIntent = PendingIntent.getBroadcast(
                this, notificationId + 1, read,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);

        Intent reply = new Intent(this, NotificationActionReceiver.class);
        reply.setAction(NotificationActionReceiver.ACTION_REPLY);
        reply.putExtra("chatId", chatId);
        reply.putExtra("notificationId", notificationId);
        PendingIntent replyIntent = PendingIntent.getBroadcast(
                this, notificationId + 2, reply,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);

        RemoteInput remoteInput = new RemoteInput.Builder(KEY_REPLY_TEXT)
                .setLabel("Ответить")
                .build();
        Notification.Action replyAction = new Notification.Action.Builder(
                android.R.drawable.ic_menu_edit, "Ответить", replyIntent)
                .addRemoteInput(remoteInput)
                .build();
        Notification.Action readAction = new Notification.Action.Builder(
                android.R.drawable.ic_menu_agenda, "Прочитано", readIntent)
                .build();

        Notification.Builder builder = Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
                ? new Notification.Builder(this, CHANNEL_MESSAGES)
                : new Notification.Builder(this);
        builder.setSmallIcon(android.R.drawable.ic_dialog_email)
                .setContentTitle(title)
                .setContentText(body)
                .setContentIntent(contentIntent)
                .setAutoCancel(true)
                .addAction(replyAction)
                .addAction(readAction);
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
            builder.setPriority(Notification.PRIORITY_HIGH);
        }
        NotificationManager manager = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
        if (manager != null) manager.notify(notificationId, builder.build());
    }

    private void showCallNotification(java.util.Map<String, String> data) {
        String title = valueOr(data.get("title"), "Входящий звонок");
        String body = valueOr(data.get("body"), "Вам звонят");
        String callId = valueOr(data.get("callId"), "");
        boolean video = "video".equals(data.get("kind"));

        ensureChannels();
        Intent open = new Intent(this, MainActivity.class);
        open.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        open.putExtra("callId", callId);
        PendingIntent contentIntent = PendingIntent.getActivity(
                this, NOTIFICATION_CALL_ID, open,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        PendingIntent fullScreenIntent = PendingIntent.getActivity(
                this, NOTIFICATION_CALL_ID + 1, open,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);

        Intent accept = new Intent(this, NotificationActionReceiver.class);
        accept.setAction(NotificationActionReceiver.ACTION_CALL);
        accept.putExtra("callId", callId);
        accept.putExtra("accept", true);
        accept.putExtra("notificationId", NOTIFICATION_CALL_ID);
        PendingIntent acceptIntent = PendingIntent.getBroadcast(
                this, NOTIFICATION_CALL_ID + 2, accept,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);

        Intent decline = new Intent(this, NotificationActionReceiver.class);
        decline.setAction(NotificationActionReceiver.ACTION_CALL);
        decline.putExtra("callId", callId);
        decline.putExtra("accept", false);
        decline.putExtra("notificationId", NOTIFICATION_CALL_ID);
        PendingIntent declineIntent = PendingIntent.getBroadcast(
                this, NOTIFICATION_CALL_ID + 3, decline,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);

        Notification.Builder builder = Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
                ? new Notification.Builder(this, CHANNEL_CALLS)
                : new Notification.Builder(this);
        builder.setSmallIcon(android.R.drawable.ic_menu_call)
                .setContentTitle(title)
                .setContentText(video ? "Входящий видеозвонок" : body)
                .setFullScreenIntent(fullScreenIntent, true)
                .setContentIntent(contentIntent)
                .setCategory(Notification.CATEGORY_CALL)
                .setOngoing(true)
                .setAutoCancel(true)
                .addAction(new Notification.Action.Builder(
                        android.R.drawable.ic_menu_close_clear_cancel, "Отклонить", declineIntent).build())
                .addAction(new Notification.Action.Builder(
                        android.R.drawable.ic_menu_call, "Принять", acceptIntent).build());
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
            builder.setPriority(Notification.PRIORITY_MAX);
        }
        NotificationManager manager = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
        if (manager != null) manager.notify(NOTIFICATION_CALL_ID, builder.build());
    }

    private static String valueOr(String value, String fallback) {
        return value == null || value.isEmpty() ? fallback : value;
    }

    /** Latest FCM token, shared with MainActivity for the bridge. */
    public static String storedToken(Context context) {
        SharedPreferences prefs = context.getSharedPreferences(MainActivity.PREFS, MODE_PRIVATE);
        return prefs.getString(MainActivity.KEY_FCM_TOKEN, "");
    }
}
