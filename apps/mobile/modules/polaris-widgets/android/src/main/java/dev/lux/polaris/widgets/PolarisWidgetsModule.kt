package dev.lux.polaris.widgets

import android.content.Context
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

internal fun Context.widgetPreferences() = getSharedPreferences("polaris.widgets", Context.MODE_PRIVATE)

class PolarisWidgetsModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("PolarisWidgets")

    Function("write") { _: String, key: String, json: String ->
      val context = requireNotNull(appContext.reactContext)
      context.widgetPreferences().edit().putString(key, json).apply()
    }

    Function("reload") {
      HomeWidgetProvider.reload(requireNotNull(appContext.reactContext))
    }
  }
}
