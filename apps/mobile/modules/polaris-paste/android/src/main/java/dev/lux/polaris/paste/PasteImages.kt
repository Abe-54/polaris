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
  val bitmap = checkNotNull(BitmapFactory.decodeFile(original.path))
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
        file.outputStream().use { input.copyTo(it) }
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
    } finally {
      temporary?.delete()
    }
  }
  if (images.length() == 0) return null
  return JSONObject().put("fieldId", fieldId).put("images", images).toString()
}
