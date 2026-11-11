# Methods called from JavaScript are only reachable through reflection.
-keepclassmembers class app.sweepmeter.NativeBridge {
    @android.webkit.JavascriptInterface <methods>;
}
