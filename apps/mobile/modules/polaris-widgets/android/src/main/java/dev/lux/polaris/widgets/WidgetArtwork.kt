package dev.lux.polaris.widgets

import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.Path

internal object WidgetPalette {
  val strong = Color.rgb(244, 245, 247)
  val subtle = Color.rgb(154, 156, 164)
  val faint = Color.rgb(104, 106, 114)
  val needsYou = Color.rgb(242, 200, 75)
  val failed = Color.rgb(240, 100, 90)
  val starlight = Color.rgb(188, 211, 255)

  fun tone(tone: String) = when (tone) {
    "needs-you" -> needsYou
    "faint" -> faint
    else -> subtle
  }

  fun harness(harness: String) = when (harness) {
    "claude" -> Color.rgb(217, 119, 87)
    "codex" -> Color.rgb(111, 203, 160)
    "opencode" -> Color.rgb(229, 154, 193)
    else -> subtle
  }
}

internal object WidgetArtwork {
  private fun star(canvas: Canvas, paint: Paint, arm: Float, waist: Float) {
    val path = Path()
    path.moveTo(8f, 8f - arm)
    path.lineTo(8f + waist, 8f - waist)
    path.lineTo(8f + arm, 8f)
    path.lineTo(8f + waist, 8f + waist)
    path.lineTo(8f, 8f + arm)
    path.lineTo(8f - waist, 8f + waist)
    path.lineTo(8f - arm, 8f)
    path.lineTo(8f - waist, 8f - waist)
    path.close()
    canvas.drawPath(path, paint)
  }

  fun glyph(density: Float, row: WidgetRow? = null): Bitmap {
    val size = (16 * density).toInt().coerceAtLeast(16)
    val bitmap = Bitmap.createBitmap(size, size, Bitmap.Config.ARGB_8888)
    val canvas = Canvas(bitmap)
    canvas.scale(size / 16f, size / 16f)
    val paint = Paint(Paint.ANTI_ALIAS_FLAG)
    when (row?.glyph) {
      null -> {
        paint.color = Color.rgb(124, 159, 232)
        star(canvas, paint, 8f, 1.4f)
        paint.color = WidgetPalette.starlight
        star(canvas, paint, 5f, 0.9f)
        paint.color = Color.WHITE
        canvas.drawCircle(8f, 8f, 1.4f, paint)
      }
      "needs-you" -> {
        paint.color = WidgetPalette.needsYou
        star(canvas, paint, 6.3f, 1.3f)
      }
      else -> {
        val working = row.glyph == "working" || row.glyph == "starting"
        paint.color = when {
          working -> WidgetPalette.harness(row.harness)
          row.glyph == "failed" -> WidgetPalette.failed
          else -> WidgetPalette.faint
        }
        if (row.glyph == "starting") paint.alpha = 128
        canvas.drawCircle(8f, 8f, if (working) 4.6f else 3.4f, paint)
      }
    }
    return bitmap
  }

  fun horizon(density: Float, moonlit: Boolean): Bitmap {
    val width = (345 * density).toInt().coerceAtLeast(345)
    val height = (44 * density).toInt().coerceAtLeast(44)
    val bitmap = Bitmap.createBitmap(width, height, Bitmap.Config.ARGB_8888)
    val canvas = Canvas(bitmap)
    canvas.scale(width / 345f, height / 44f)
    val steps = arrayOf(
      12 to 28, 20 to 26, 28 to 30, 36 to 28, 44 to 30, 60 to 32, 68 to 34,
      84 to 36, 92 to 32, 100 to 28, 116 to 30, 132 to 26, 140 to 28, 148 to 26,
      156 to 24, 164 to 26, 172 to 24, 188 to 22, 212 to 26, 228 to 30, 236 to 32,
      244 to 30, 252 to 32, 276 to 36, 292 to 32, 300 to 36, 316 to 34, 324 to 32,
      332 to 34, 372 to 36, 380 to 34, 388 to 32, 393 to 28,
    )
    val path = Path()
    path.moveTo(-24f, 44f)
    var from = 0
    for ((to, top) in steps) {
      path.lineTo(from - 24f, top.toFloat())
      path.lineTo(to - 24f, top.toFloat())
      from = to
    }
    path.lineTo(from - 24f, 44f)
    path.close()
    val paint = Paint().apply {
      color = if (moonlit) Color.rgb(38, 43, 69) else Color.rgb(21, 26, 58)
    }
    canvas.drawPath(path, paint)
    return bitmap
  }
}
