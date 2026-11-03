package dev.lux.polaris.hinge

import android.app.Activity
import android.content.Context
import android.hardware.Sensor
import android.hardware.SensorEvent
import android.hardware.SensorEventListener
import android.hardware.SensorManager
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.view.View
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleOwner
import androidx.lifecycle.repeatOnLifecycle
import androidx.window.layout.FoldingFeature
import androidx.window.layout.WindowInfoTracker
import androidx.window.layout.WindowMetricsCalculator
import expo.modules.kotlin.functions.Queues
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch
import org.json.JSONArray
import org.json.JSONObject

class PolarisHingeModule : Module() {
  private val main = Handler(Looper.getMainLooper())
  private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
  private var observing = false
  private var probe: PostureProbe? = null

  override fun definition() = ModuleDefinition {
    Name("PolarisHinge")
    Events("onPosture")

    AsyncFunction("current") {
      attach()
      probe?.snapshot() ?: PostureProbe.empty(appContext.currentActivity)
    }.runOnQueue(Queues.MAIN)

    OnStartObserving {
      main.post {
        observing = true
        attach()
      }
    }

    OnStopObserving {
      main.post {
        observing = false
        detach()
      }
    }

    OnActivityEntersForeground { main.post { attach() } }
    OnActivityDestroys { main.post { detach() } }
    OnDestroy {
      main.post {
        observing = false
        detach()
        scope.cancel()
      }
    }
  }

  private fun attach() {
    val activity = appContext.currentActivity ?: return
    if (!observing || probe?.activity === activity) return
    detach()
    probe = PostureProbe(activity, scope) { json -> sendEvent("onPosture", mapOf("json" to json)) }
  }

  private fun detach() {
    probe?.detach()
    probe = null
  }
}

private class PostureProbe(
  val activity: Activity,
  scope: CoroutineScope,
  private val emit: (String) -> Unit,
) : SensorEventListener {
  private var fold: FoldingFeature? = null
  private var angle: Float? = null
  private var last: String? = null
  private val decor = activity.window.decorView
  private val sensors = activity.getSystemService(Context.SENSOR_SERVICE) as SensorManager
  private val sensor = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
    sensors.getDefaultSensor(Sensor.TYPE_HINGE_ANGLE)
  } else null
  private val layout = View.OnLayoutChangeListener { _, _, _, _, _, _, _, _, _ -> publish() }
  private val job: Job? = (activity as? LifecycleOwner)?.let { owner ->
    scope.launch {
      owner.lifecycle.repeatOnLifecycle(Lifecycle.State.STARTED) {
        fold = null
        angle = null
        decor.addOnLayoutChangeListener(layout)
        sensor?.let { sensors.registerListener(this@PostureProbe, it, SensorManager.SENSOR_DELAY_NORMAL) }
        try {
          WindowInfoTracker.getOrCreate(activity).windowLayoutInfo(activity).collect { info ->
            fold = info.displayFeatures.filterIsInstance<FoldingFeature>().firstOrNull {
              it.isSeparating || it.occlusionType == FoldingFeature.OcclusionType.FULL
            }
            publish()
          }
        } finally {
          decor.removeOnLayoutChangeListener(layout)
          sensors.unregisterListener(this@PostureProbe)
          fold = null
          angle = null
        }
      }
    }
  }

  fun detach() {
    job?.cancel()
  }

  override fun onSensorChanged(event: SensorEvent) {
    val value = event.values.firstOrNull() ?: return
    if (!value.isFinite()) return
    angle = value.coerceIn(0f, 180f)
    publish()
  }

  override fun onAccuracyChanged(sensor: Sensor?, accuracy: Int) = Unit

  fun snapshot(): String = report(activity, fold, angle)

  private fun publish() {
    val next = snapshot()
    if (next == last) return
    last = next
    emit(next)
  }

  companion object {
    fun empty(activity: Activity?): String = report(activity, null, null)

    private fun report(activity: Activity?, fold: FoldingFeature?, angle: Float?): String {
      val density = activity?.resources?.displayMetrics?.density ?: 1f
      val window = activity?.let { WindowMetricsCalculator.getOrCreate().computeCurrentWindowMetrics(it).bounds }
      val divisions = JSONArray()
      var hinge: Any = JSONObject.NULL
      if (fold != null) {
        val bounds = fold.bounds
        val horizontal = fold.orientation == FoldingFeature.Orientation.HORIZONTAL
        // Ignore an old feature during rotation until WindowInfoTracker supplies its new bounds.
        val spansWindow = if (horizontal) bounds.width() == window?.width() else bounds.height() == window?.height()
        if (spansWindow) {
          val partial = fold.state == FoldingFeature.State.HALF_OPENED
          hinge = JSONObject()
            .put("status", if (partial) "partiallyOpen" else "fullyOpen")
            .put("angle", (angle ?: if (partial) 90f else 180f).toDouble())
          divisions.put(JSONObject()
            .put("x", (bounds.left / density).toDouble())
            .put("y", (bounds.top / density).toDouble())
            .put("width", (bounds.width() / density).toDouble())
            .put("height", (bounds.height() / density).toDouble()))
        }
      }
      return JSONObject()
        .put("hinge", hinge)
        .put("width", ((window?.width() ?: 0) / density).toDouble())
        .put("height", ((window?.height() ?: 0) / density).toDouble())
        .put("divisions", divisions)
        .toString()
    }
  }
}
