package dev.lux.polaris.liveactivity

import android.Manifest
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class PolarisLiveActivityModule : Module() {
  private val context: Context get() = requireNotNull(appContext.reactContext)
  private val manager get() = context.getSystemService(NotificationManager::class.java)
  private var lastTimestamp = Double.NEGATIVE_INFINITY

  override fun definition() = ModuleDefinition {
    Name("PolarisLiveActivity")
    Events("pushToken", "pushToStartToken", "answer")

    Function("enabled") { enabled() }
    Function("pushToken") {
      val token: String? = null
      token
    }
    Function("takeAnswers") { LiveAnswers.take(context) }
    // Android launches the app to send the answer; there is no waiting background intent.
    Function("answered") { _: String -> Unit }

    AsyncFunction("start") { slices: List<String> ->
      if (enabled()) {
        post(slices, false)
        lastTimestamp = (System.currentTimeMillis() / 1000).toDouble()
        ACTIVITY_ID
      } else null
    }
    AsyncFunction("update") { slices: List<String>, timestamp: Double, alert: Boolean ->
      if (enabled() && timestamp >= lastTimestamp && showing()) {
        post(slices, alert)
        lastTimestamp = timestamp
      }
    }
    AsyncFunction("end") {
      manager.cancel(NOTIFICATION_ID)
      lastTimestamp = Double.NEGATIVE_INFINITY
    }
    OnStartObserving {
      LiveAnswers.onAnswer = { sendEvent("answer", emptyMap<String, String>()) }
    }
    OnStopObserving { LiveAnswers.onAnswer = null }
    OnDestroy { LiveAnswers.onAnswer = null }
  }

  private fun enabled(): Boolean {
    channel()
    if (Build.VERSION.SDK_INT >= 33 &&
      context.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED
    ) return false
    return manager.areNotificationsEnabled() &&
      (Build.VERSION.SDK_INT < 26 ||
        manager.getNotificationChannel(CHANNEL_ID)?.importance != NotificationManager.IMPORTANCE_NONE)
  }

  private fun channel() {
    if (Build.VERSION.SDK_INT < 26) return
    manager.createNotificationChannel(
      NotificationChannel(CHANNEL_ID, "Live Activity", NotificationManager.IMPORTANCE_DEFAULT).apply {
        description = "Working agent sessions and requests that need you"
        setSound(null, null)
        enableVibration(false)
      }
    )
  }

  private fun showing() = manager.activeNotifications.any { it.id == NOTIFICATION_ID }

  private fun open(link: Uri): PendingIntent {
    val intent = requireNotNull(context.packageManager.getLaunchIntentForPackage(context.packageName))
      .setAction(Intent.ACTION_VIEW).setData(link)
      .addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP)
    return PendingIntent.getActivity(context, 0, intent, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
  }

  private fun answer(need: LiveNeed, decision: String): PendingIntent {
    val payload = need.answer(decision).toString()
    val intent = Intent(context, LiveAnswerActivity::class.java)
      .setData(Uri.Builder().scheme("polaris-live-answer").authority(decision)
        .appendPath(need.hostId).appendPath(need.requestId).appendPath(need.content.line).build())
      .putExtra("answer", payload)
    return PendingIntent.getActivity(context, 0, intent, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
  }

  private fun post(slices: List<String>, alert: Boolean) {
    val summary = LiveSummary(slices)
    val need = summary.need
    val link = need?.let {
      Uri.Builder().scheme("polaris").authority("session")
        .appendPath(it.hostId).appendPath(it.content.sessionId).build()
    } ?: Uri.parse("polaris://home")
    val builder = (if (Build.VERSION.SDK_INT >= 26) Notification.Builder(context, CHANNEL_ID)
      else Notification.Builder(context))
      .setSmallIcon(R.drawable.polaris_live_star)
      .setContentTitle(summary.title)
      .setContentText(summary.text)
      .setSubText(summary.hostLabel)
      .setContentIntent(open(link))
      .setOngoing(true)
      .setOnlyAlertOnce(!alert)
      .setCategory(Notification.CATEGORY_PROGRESS)
      .setVisibility(Notification.VISIBILITY_PRIVATE)
    summary.since?.let {
      builder.setWhen((it * 1000).toLong()).setShowWhen(true).setUsesChronometer(true)
    } ?: builder.setShowWhen(false)
    if (need == null) builder.setLargeIcon(LiveCelestialArt.draw(summary.celestials))
    if (Build.VERSION.SDK_INT >= 36) {
      // Promotion arrived in an Android 16 update (API 36.1); on 36.0 the method is missing.
      try {
        builder.setRequestPromotedOngoing(true)
      } catch (_: NoSuchMethodError) {}
      if (need == null && summary.working > 0) {
        builder.setStyle(Notification.ProgressStyle().setProgressIndeterminate(true)
          .setStyledByProgress(false))
      } else builder.setStyle(Notification.BigTextStyle().bigText(summary.text))
    } else builder.setStyle(Notification.BigTextStyle().bigText(summary.text))
    if (need?.actionable == true) {
      listOf("approve" to "Approve", "always" to "Always here", "deny" to "Deny").forEach { (decision, title) ->
        val action = Notification.Action.Builder(null, title, answer(need, decision))
        if (Build.VERSION.SDK_INT >= 31) action.setAuthenticationRequired(true)
        builder.addAction(action.build())
      }
    } else if (need != null) {
      builder.addAction(Notification.Action.Builder(null, "Answer in Polaris", open(link)).build())
    }
    manager.notify(NOTIFICATION_ID, builder.build())
  }

  companion object {
    private const val CHANNEL_ID = "polaris-live-activity"
    private const val NOTIFICATION_ID = 880088
    private const val ACTIVITY_ID = "polaris-live-activity"
  }
}

