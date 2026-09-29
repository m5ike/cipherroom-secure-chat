# WebRTC is called from native code by name.
-keep class org.webrtc.** { *; }
-dontwarn org.webrtc.**
# The app's classes reached by name (the manifest's components are kept by AGP).
-keepattributes *Annotation*,Signature,InnerClasses,EnclosingMethod
