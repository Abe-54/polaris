import { AndroidConfig, type ConfigPlugin, withAndroidStyles } from "expo/config-plugins";

const APP_THEME = AndroidConfig.Styles.getAppThemeGroup();

const SPLASH_THEME = { name: "Theme.App.SplashScreen", parent: "AppTheme" };

const BLACK = "@color/activityBackground";

// The app is always dark: Android 10+ draws no light scrim behind 3-button navigation, and
// launch shows black instead of the template's placeholder image (white on Android 12+).
const ITEMS = [
  {
    parent: APP_THEME,
    name: "android:enforceNavigationBarContrast",
    value: "false",
    targetApi: "29",
  },
  { parent: SPLASH_THEME, name: "android:windowBackground", value: BLACK },
  {
    parent: SPLASH_THEME,
    name: "android:windowSplashScreenBackground",
    value: BLACK,
    targetApi: "31",
  },
];

const withAndroidDarkTheme: ConfigPlugin = (config) =>
  withAndroidStyles(config, (styles) => {
    for (const item of ITEMS) {
      styles.modResults = AndroidConfig.Styles.assignStylesValue(styles.modResults, {
        add: true,
        ...item,
      });
    }

    return styles;
  });

export default withAndroidDarkTheme;
