package dev.lux.polaris.paste

import android.content.ClipData
import android.os.Handler
import android.os.Looper
import android.view.View
import android.view.ViewTreeObserver
import android.view.inputmethod.InputMethodManager
import androidx.core.view.ContentInfoCompat
import androidx.core.view.ViewCompat
import com.facebook.react.uimanager.util.ReactFindViewUtil
import com.facebook.react.views.textinput.ReactEditText
import expo.modules.kotlin.functions.Queues
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.util.concurrent.Executors

class PolarisPasteModule : Module() {
  private val main = Handler(Looper.getMainLooper())
  private val writer = Executors.newSingleThreadExecutor()
  private val watched = mutableMapOf<String, Int>()
  private val bound = mutableMapOf<String, ReactEditText>()
  private var root: View? = null
  private var active = true
  private var destroyed = false
  private val layout = ViewTreeObserver.OnGlobalLayoutListener { bindFields() }
  private val retry = Runnable { observe() }

  override fun definition() = ModuleDefinition {
    Name("PolarisPaste")
    Events("onPaste")

    AsyncFunction("watch") { fieldId: String ->
      watched[fieldId] = (watched[fieldId] ?: 0) + 1
      observe()
    }.runOnQueue(Queues.MAIN)

    AsyncFunction("unwatch") { fieldId: String ->
      val count = (watched[fieldId] ?: 0) - 1
      if (count > 0) watched[fieldId] = count else {
        watched.remove(fieldId)
        unbind(fieldId)
      }
      if (watched.isEmpty()) stopObserving()
    }.runOnQueue(Queues.MAIN)

    OnActivityEntersForeground {
      main.post { active = true; observe() }
    }
    OnActivityEntersBackground {
      main.post { active = false; stopObserving() }
    }
    OnActivityDestroys {
      main.post { stopObserving() }
    }
    OnDestroy {
      main.post {
        destroyed = true
        stopObserving()
        watched.clear()
        writer.shutdown()
      }
    }
  }

  private fun observe() {
    main.removeCallbacks(retry)
    if (destroyed || !active || watched.isEmpty()) return
    val current = appContext.currentActivity?.window?.decorView
    if (current !== root) {
      stopObserving()
      root = current
      current?.viewTreeObserver?.addOnGlobalLayoutListener(layout)
    }
    if (current == null) main.postDelayed(retry, 100) else bindFields()
  }

  private fun bindFields() {
    val current = root ?: return
    for (fieldId in watched.keys) {
      val field = ReactFindViewUtil.findView(current, fieldId) as? ReactEditText
      if (bound[fieldId] === field) continue
      unbind(fieldId)
      if (field == null) continue
      bound[fieldId] = field
      ViewCompat.setOnReceiveContentListener(field, arrayOf("image/*")) { _, content ->
        receive(fieldId, field, content)
      }
      refreshKeyboard(field)
    }
  }

  private fun receive(fieldId: String, field: ReactEditText, content: ContentInfoCompat): ContentInfoCompat? {
    if (!field.isEnabled || !field.onCheckIsTextEditor() || watched[fieldId] == null) return content
    val context = field.context.applicationContext
    val images = mutableListOf<PasteSource>()
    val remainder = mutableListOf<ClipData.Item>()
    for (index in 0 until content.clip.itemCount) {
      val item = content.clip.getItemAt(index)
      val image = PasteSource.open(context.contentResolver, item, content.clip.description)
      if (image == null) remainder.add(item) else {
        images.add(image)
        if (item.text != null) remainder.add(ClipData.Item(item.text, item.htmlText))
      }
    }
    if (images.isEmpty()) return content
    writer.execute {
      val report = writeImages(context.cacheDir, fieldId, images)
      main.post {
        if (!destroyed && watched[fieldId] != null && report != null) {
          sendEvent("onPaste", mapOf("json" to report))
        }
      }
    }
    if (remainder.isEmpty()) return null
    val clip = ClipData(content.clip.description, remainder.first())
    remainder.drop(1).forEach { clip.addItem(it) }
    return ContentInfoCompat.Builder(content).setClip(clip).build()
  }

  private fun unbind(fieldId: String) {
    val field = bound.remove(fieldId) ?: return
    ViewCompat.setOnReceiveContentListener(field, null, null)
    refreshKeyboard(field)
  }

  private fun refreshKeyboard(field: ReactEditText) {
    if (field.hasFocus()) {
      field.context.getSystemService(InputMethodManager::class.java)?.restartInput(field)
    }
  }

  private fun stopObserving() {
    main.removeCallbacks(retry)
    root?.viewTreeObserver?.takeIf { it.isAlive }?.removeOnGlobalLayoutListener(layout)
    root = null
    bound.keys.toList().forEach { unbind(it) }
  }
}
