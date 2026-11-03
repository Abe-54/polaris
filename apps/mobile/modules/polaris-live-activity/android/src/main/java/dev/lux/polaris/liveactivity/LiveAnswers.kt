package dev.lux.polaris.liveactivity

import android.app.Activity
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Bundle
import org.json.JSONArray
import org.json.JSONObject

internal object LiveAnswers {
  var onAnswer: (() -> Unit)? = null

  private fun preferences(context: Context) =
    context.getSharedPreferences("polaris-live-answers", Context.MODE_PRIVATE)

  @Synchronized
  fun submit(context: Context, answer: JSONObject) {
    val prefs = preferences(context)
    val queue = JSONArray(prefs.getString("queue", "[]"))
    val id = "${answer.getString("hostId")}:${answer.getString("requestId")}"
    for (i in 0 until queue.length()) {
      val existing = queue.getJSONObject(i)
      if ("${existing.getString("hostId")}:${existing.getString("requestId")}" == id) return
    }
    queue.put(answer)
    // Persist before launching JS: the process may have been cold.
    prefs.edit().putString("queue", queue.toString()).commit()
    onAnswer?.invoke()
  }

  @Synchronized
  fun take(context: Context): List<Map<String, String>> {
    val prefs = preferences(context)
    val queue = JSONArray(prefs.getString("queue", "[]"))
    prefs.edit().remove("queue").commit()
    return (0 until queue.length()).map { i ->
      val answer = queue.getJSONObject(i)
      listOf("hostId", "sessionId", "requestId", "line", "decision")
        .associateWith { answer.getString(it) }
    }
  }
}

// A direct notification Activity can open the app on Android 12+ without a trampoline receiver.
class LiveAnswerActivity : Activity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    val raw = intent.getStringExtra("answer")
    if (raw != null) {
      val answer = JSONObject(raw)
      val link = Uri.Builder().scheme("polaris").authority("session")
        .appendPath(answer.getString("hostId")).appendPath(answer.getString("sessionId")).build()
      // Do not run an approval over the lock screen, matching the iOS authentication requirement.
      val keyguard = getSystemService(android.app.KeyguardManager::class.java)
      if (keyguard.isDeviceLocked && android.os.Build.VERSION.SDK_INT >= 26) {
        keyguard.requestDismissKeyguard(this, object : android.app.KeyguardManager.KeyguardDismissCallback() {
          override fun onDismissSucceeded() { deliver(answer, link) }
          override fun onDismissCancelled() { finish() }
          override fun onDismissError() { finish() }
        })
      } else if (keyguard.isDeviceLocked) finish()
      else deliver(answer, link)
    } else finish()
  }

  private fun deliver(answer: JSONObject, link: Uri) {
    LiveAnswers.submit(this, answer)
    packageManager.getLaunchIntentForPackage(packageName)?.let {
      startActivity(it.setAction(Intent.ACTION_VIEW).setData(link)
        .addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP))
    }
    finish()
  }
}

