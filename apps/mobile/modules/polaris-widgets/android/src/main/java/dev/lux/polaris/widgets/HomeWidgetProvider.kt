package dev.lux.polaris.widgets

import android.app.PendingIntent
import android.appwidget.AppWidgetManager
import android.appwidget.AppWidgetProvider
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.graphics.Color
import android.net.Uri
import android.os.Bundle
import android.text.SpannableStringBuilder
import android.text.Spanned
import android.text.style.ForegroundColorSpan
import android.view.View
import android.widget.RemoteViews

class HomeWidgetProvider : AppWidgetProvider() {
  override fun onUpdate(context: Context, manager: AppWidgetManager, ids: IntArray) {
    ids.forEach { update(context, manager, it) }
  }

  override fun onAppWidgetOptionsChanged(
    context: Context, manager: AppWidgetManager, id: Int, newOptions: Bundle,
  ) {
    update(context, manager, id)
  }

  companion object {
    fun reload(context: Context) {
      val manager = AppWidgetManager.getInstance(context)
      manager.getAppWidgetIds(ComponentName(context, HomeWidgetProvider::class.java))
        .forEach { update(context, manager, it) }
    }

    private fun open(context: Context, id: Int, link: String): PendingIntent? {
      val intent = context.packageManager.getLaunchIntentForPackage(context.packageName) ?: return null
      val uri = Uri.parse(link)
      intent.action = Intent.ACTION_VIEW
      intent.data = if (uri.scheme == "polaris") uri else Uri.parse(HOME_LINK)
      intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP)
      return PendingIntent.getActivity(
        context, id, intent, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
      )
    }

    private fun summary(snapshot: WidgetSnapshot?): CharSequence {
      if (snapshot == null || snapshot.summary.isEmpty()) return "Polaris"
      return SpannableStringBuilder().apply {
        snapshot.summary.forEachIndexed { index, part ->
          if (index > 0) append(" · ")
          val start = length
          append(part.text)
          setSpan(ForegroundColorSpan(WidgetPalette.tone(part.tone)), start, length, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
        }
      }
    }

    private fun row(context: Context, id: Int, row: WidgetRow, stale: Boolean): RemoteViews {
      return RemoteViews(context.packageName, R.layout.polaris_widget_row).apply {
        setTextViewText(R.id.polaris_row_title, row.title)
        setTextColor(R.id.polaris_row_title, WidgetPalette.strong)
        setTextViewText(R.id.polaris_row_trailing, row.trailing(System.currentTimeMillis()))
        setTextColor(R.id.polaris_row_trailing, when (row.glyph) {
          "needs-you" -> WidgetPalette.needsYou
          "working", "starting" -> WidgetPalette.subtle
          else -> WidgetPalette.faint
        })
        setImageViewBitmap(R.id.polaris_row_glyph, WidgetArtwork.glyph(context.resources.displayMetrics.density, row))
        setFloat(R.id.polaris_row, "setAlpha", if (stale) 0.55f else 1f)
        setContentDescription(R.id.polaris_row, "${row.title}, ${row.glyph}, ${row.trailing(System.currentTimeMillis())}")
        open(context, id, row.link)?.let { setOnClickPendingIntent(R.id.polaris_row, it) }
      }
    }

    private fun update(context: Context, manager: AppWidgetManager, id: Int) {
      val preferences = context.widgetPreferences()
      val snapshot = WidgetSnapshot.decode(preferences.getString("polaris.widgets.snapshot", null))
      val moonlit = preferences.getString("polaris.theme", null) == "moonlit"
      val density = context.resources.displayMetrics.density
      val height = manager.getAppWidgetOptions(id).getInt(AppWidgetManager.OPTION_APPWIDGET_MIN_HEIGHT, 160)
      val capacity = ((height - 54) / 32).coerceIn(1, 3)
      val views = RemoteViews(context.packageName, R.layout.polaris_home_widget).apply {
        setInt(R.id.polaris_widget_root, "setBackgroundColor", if (moonlit) Color.rgb(26, 27, 29) else Color.rgb(10, 11, 13))
        setTextViewText(R.id.polaris_widget_summary, summary(snapshot))
        setImageViewBitmap(R.id.polaris_widget_star, WidgetArtwork.glyph(density))
        setImageViewBitmap(R.id.polaris_widget_horizon, WidgetArtwork.horizon(density, moonlit))
        removeAllViews(R.id.polaris_widget_rows)
        snapshot?.rows?.take(capacity)?.forEach { addView(R.id.polaris_widget_rows, row(context, id, it, snapshot.stale)) }
        val empty = when {
          snapshot == null -> context.getString(R.string.polaris_widget_open)
          snapshot.empty == "Link this iPhone from Polaris on your Mac" -> "Link this phone from Polaris on your Mac"
          else -> snapshot.empty
        }
        setViewVisibility(R.id.polaris_widget_empty, if (empty == null) View.GONE else View.VISIBLE)
        setTextViewText(R.id.polaris_widget_empty, empty ?: "")
        open(context, id, snapshot?.link ?: HOME_LINK)?.let { setOnClickPendingIntent(R.id.polaris_widget_root, it) }
      }
      manager.updateAppWidget(id, views)
    }
  }
}
