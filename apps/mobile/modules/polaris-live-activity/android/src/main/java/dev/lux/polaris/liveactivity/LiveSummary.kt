package dev.lux.polaris.liveactivity

import org.json.JSONObject

internal data class LiveLine(
  val at: Double,
  val sessionId: String,
  val session: String,
  val line: String,
  val harness: String?
) {
  companion object {
    fun read(json: JSONObject) = LiveLine(
      json.getDouble("at"), json.getString("sessionId"), json.getString("session"),
      json.getString("line"), json.optString("harness").takeIf { it.isNotEmpty() && it != "null" }
    )
  }
}

internal data class LiveNeed(
  val hostId: String,
  val host: String,
  val requestId: String,
  val kind: String,
  val content: LiveLine
) {
  val actionable get() = kind == "approval" && !content.line.endsWith("…")
  fun answer(decision: String) = JSONObject().apply {
    put("hostId", hostId)
    put("sessionId", content.sessionId)
    put("requestId", requestId)
    put("line", content.line)
    put("decision", decision)
  }
}

internal class LiveSummary(slices: List<String>) {
  var hosts = 0
  var unreadable = 0
  var working = 0
  var needs = 0
  var since: Double? = null
  var step: LiveLine? = null
  var need: LiveNeed? = null
  val celestials = mutableListOf<String>()

  init {
    slices.forEach { raw ->
      try {
        val slice = JSONObject(raw)
        require(slice.getInt("v") == 1)
        val hostId = slice.getString("hostId")
        val host = slice.getString("host")
        val count = slice.getInt("working")
        val waiting = slice.getInt("needs")
        val started = if (slice.isNull("since")) null else slice.getDouble("since")
        val line = slice.optJSONObject("step")?.let(LiveLine::read)
        val open = slice.optJSONObject("need")?.let {
          LiveNeed(hostId, host, it.getString("requestId"), it.getString("kind"), LiveLine.read(it))
        }
        val bodies = slice.optJSONArray("celestials")
        val stars = if (bodies == null) emptyList() else (0 until bodies.length())
          .map { bodies.getString(it) }.filter { it.split("/", limit = 2).size == 2 }
        hosts++
        working += count
        needs += waiting
        if (started != null && (since == null || started < since!!)) since = started
        if (line != null && (step == null || line.at > step!!.at)) step = line
        if (open != null && (need == null || open.content.at < need!!.content.at)) need = open
        celestials += stars.take((3 - celestials.size).coerceAtLeast(0))
      } catch (_: Exception) {
        unreadable++
      }
    }
  }

  val title: String get() = need?.let {
    it.content.harness?.let { name -> "$name needs you" } ?: "An agent session needs you"
  } ?: if (working == 0) "Nothing working" else "$working working"

  val hostLabel: String get() {
    val count = hosts + unreadable
    return "Polaris · $count " + if (count == 1) "host" else "hosts"
  }

  val text: String get() = listOfNotNull(
    need?.let { "${it.content.session} · ${it.host}\n${it.content.line}" }
      ?: step?.let { "${it.session}\n${it.line}" },
    if (need != null && needs > 1) "+${needs - 1} more" else null,
    if (unreadable > 0) "Open Polaris to see every host" else null
  ).joinToString("\n")
}

