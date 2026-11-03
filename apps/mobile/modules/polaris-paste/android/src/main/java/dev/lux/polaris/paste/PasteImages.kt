package dev.lux.polaris.paste

import android.content.ClipData
import android.content.ClipDescription
import android.content.ContentResolver
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.net.Uri
import java.io.File
import java.io.InputStream
import org.json.JSONArray
import org.json.JSONObject

internal class PasteSource(val stream: InputStream) {
  companion object {
    fun open(resolver: ContentResolver, item: ClipData.Item, description: ClipDescription): PasteSource? {
      val uri = item.uri ?: return null
      if (uri.scheme != "content") return null
      return try {
        val mime = resolver.getType(uri)
        val image = mime?.startsWith("image/") ?: description.hasMimeType("image/*")
        if (!image) null else resolver.openInputStream(uri)?.let { PasteSource(it) }
      } catch (_: Exception) {
        null
      }
    }
  }
}

/** Pasted files larger than this are skipped before they are copied. */
private const val MAX_PASTE_BYTES = 50L * 1024 * 1024

/** Other formats are decoded to re-encode them; larger images are downsampled to this many pixels. */
private const val MAX_DECODE_PIXELS = 16L * 1024 * 1024

/** The power of two that brings width x height within MAX_DECODE_PIXELS. */
private fun sampleSize(width: Int, height: Int): Int {
  var sample = 1
  while ((width.toLong() / sample) * (height.toLong() / sample) > MAX_DECODE_PIXELS) sample *= 2
  return sample
}

private fun copyBounded(input: InputStream, output: File) {
  output.outputStream().use { out ->
    val buffer = ByteArray(64 * 1024)
    var total = 0L
    while (true) {
      val read = input.read(buffer)
      if (read < 0) break
      total += read
      check(total <= MAX_PASTE_BYTES) { "pasted image is too large" }
      out.write(buffer, 0, read)
    }
  }
}

private fun normalizeImage(original: File): Pair<File, String> {
  val info = BitmapFactory.Options().apply { inJustDecodeBounds = true }
  BitmapFactory.decodeFile(original.path, info)
  check(info.outWidth > 0 && info.outHeight > 0)
  if (info.outMimeType == "image/png" || info.outMimeType == "image/jpeg") {
    val ext = if (info.outMimeType == "image/png") "png" else "jpg"
    val renamed = File(original.parentFile, "${original.nameWithoutExtension}.$ext")
    check(original.renameTo(renamed))
    return renamed to info.outMimeType
  }
  val options = BitmapFactory.Options().apply { inSampleSize = sampleSize(info.outWidth, info.outHeight) }
  val bitmap = checkNotNull(BitmapFactory.decodeFile(original.path, options))
  val alpha = bitmap.hasAlpha()
  val ext = if (alpha) "png" else "jpg"
  val output = File(original.parentFile, "${original.nameWithoutExtension}.$ext")
  try {
    output.outputStream().use {
      val format = if (alpha) Bitmap.CompressFormat.PNG else Bitmap.CompressFormat.JPEG
      check(bitmap.compress(format, 90, it))
    }
    return output to if (alpha) "image/png" else "image/jpeg"
  } catch (error: Exception) {
    output.delete()
    throw error
  } finally {
    bitmap.recycle()
  }
}

internal fun writeImages(cache: File, fieldId: String, sources: List<PasteSource>): String? {
  val images = JSONArray()
  val folder = File(cache, "polaris-paste")
  for (source in sources) {
    var temporary: File? = null
    var output: File? = null
    try {
      source.stream.use { input ->
        check(folder.isDirectory || folder.mkdirs())
        val file = File.createTempFile("paste-", ".tmp", folder)
        temporary = file
        copyBounded(input, file)
      }
      val (file, mimeType) = normalizeImage(checkNotNull(temporary))
      output = file
      images.put(JSONObject().apply {
        put("uri", Uri.fromFile(file).toString())
        put("name", "pasted-${images.length() + 1}.${file.extension}")
        put("mimeType", mimeType)
        put("size", file.length())
      })
    } catch (_: Exception) {
      output?.delete()
    } catch (_: OutOfMemoryError) {
      // A backstop: decoding is already bounded by MAX_DECODE_PIXELS.
      output?.delete()
    } finally {
      temporary?.delete()
    }
  }
  if (images.length() == 0) return null
  return JSONObject().put("fieldId", fieldId).put("images", images).toString()
}
