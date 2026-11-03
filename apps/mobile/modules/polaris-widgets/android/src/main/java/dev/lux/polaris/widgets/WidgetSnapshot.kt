package dev.lux.polaris.widgets

import org.json.JSONObject

internal const val HOME_LINK = "polaris://home"

internal data class SummaryPart(val text: String, val tone: String)
internal data class WidgetRow(
  val title: String,
  val harness: String,
  val glyph: String,
  val turn: Int?,
  val since: Double?,
  val link: String,
) {
  fun trailing(now: Long): String {
    turn?.let { return "turn $it" }
    val elapsed = since?.let { (now - it).coerceAtLeast(0.0) } ?: return ""
    return when {
      elapsed < 60_000 -> "now"
      elapsed < 3_600_000 -> "${(elapsed / 60_000).toInt()}m"
      elapsed < 86_400_000 -> "${(elapsed / 3_600_000).toInt()}h"
      else -> "${(elapsed / 86_400_000).toInt()}d"
    }
  }
}

internal data class WidgetSnapshot(
  val summary: List<SummaryPart>,
  val rows: List<WidgetRow>,
  val empty: String?,
  val stale: Boolean,
  val link: String,
) {
  companion object {
    fun decode(json: String?): WidgetSnapshot? = runCatching {
      val value = JSONObject(json ?: return null)
      if (value.getInt("version") != 1) return null
      val parts = value.getJSONArray("summary")
      val rows = value.getJSONArray("rows")
      WidgetSnapshot(
        summary = List(parts.length()) { index ->
          val part = parts.getJSONObject(index)
          SummaryPart(part.getString("text"), part.getString("tone"))
        },
        rows = List(minOf(rows.length(), 3)) { index ->
          val row = rows.getJSONObject(index)
          WidgetRow(
            title = row.getString("title"), harness = row.getString("harness"),
            glyph = row.getString("glyph"), link = row.getString("link"),
            turn = if (row.isNull("turn")) null else row.getInt("turn"),
            since = if (row.isNull("since")) null else row.getDouble("since"),
          )
        },
        empty = if (value.isNull("empty")) null else value.getString("empty"),
        stale = value.getBoolean("stale"), link = value.getString("link"),
      )
    }.getOrNull()
  }
}
