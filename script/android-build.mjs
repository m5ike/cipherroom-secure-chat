// Builds the Android app (6.0) from the repository root.
//
//   npm run android:build                         debug APK (+ the Java unit tests)
//   npm run android:build -- --release            release APK (R8), signed when a keystore is given
//   npm run android:build -- --install            … and install it on the connected phone (adb)
//   npm run android:build -- --release --upload https://chat.example.com
//                                                 … and upload it as a draft release (Android › Releases)
//
// Options:
//   --release              release build (minified); signed with M5_KEYSTORE, M5_KEYSTORE_PASSWORD,
//                          M5_KEY_ALIAS (default m5cet), M5_KEY_PASSWORD — unsigned without them
//   --server <url>         the server the app offers at enrolment (baked in as its default)
//   --server-key <kid>     pin the server's Android key id: the app refuses any other at enrolment
//   --skip-tests           no unit tests
//   --install              adb install -r on the one connected device
//   --upload <url>         POST the APK to <url>/api/admin/android/releases/upload
//   --token <token>        the administrator token for --upload (or M5_ADMIN_TOKEN)
//   --channel <c>          stable | beta | dev (upload)        --notes <text>   release notes (upload)
//
// Needs a JDK 17+ (JAVA_HOME, or found on macOS/Linux) and the Android SDK
// (ANDROID_HOME / ANDROID_SDK_ROOT, or the usual install folders); Gradle
// comes with the wrapper (android/gradlew).

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { homedir, platform } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const androidDir = join(root, "android");
const version = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(`--${name}`);
const value = (name) => { const i = argv.indexOf(`--${name}`); return i >= 0 && i + 1 < argv.length ? argv[i + 1] : undefined; };
const release = flag("release");
const type = release ? "release" : "debug";

function fail(message) {
  console.error(`\n✗ ${message}`);
  process.exit(1);
}

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { stdio: "inherit", ...opts });
  if (r.status !== 0) fail(`${cmd} ${args.join(" ")} failed (exit ${r.status ?? r.signal})`);
}

/* ------------------------------------------------------------ toolchain */

function javaHome() {
  const ok = (dir) => dir && existsSync(join(dir, "bin", platform() === "win32" ? "java.exe" : "java"));
  const major = (dir) => {
    const r = spawnSync(join(dir, "bin", "java"), ["-version"], { encoding: "utf8" });
    const m = /version "(\d+)/.exec(`${r.stderr}${r.stdout}`);
    return m ? Number(m[1]) : 0;
  };
  const candidates = [process.env.JAVA_HOME];
  if (platform() === "darwin") {
    for (const v of ["21", "17"]) {
      const r = spawnSync("/usr/libexec/java_home", ["-v", v], { encoding: "utf8" });
      if (r.status === 0) candidates.push(r.stdout.trim());
    }
    candidates.push("/Applications/Android Studio.app/Contents/jbr/Contents/Home");
    const jvms = join(homedir(), "Library", "Java", "JavaVirtualMachines");
    if (existsSync(jvms)) for (const d of readdirSync(jvms)) candidates.push(join(jvms, d, "Contents", "Home"));
  } else {
    candidates.push("/usr/lib/jvm/java-21-openjdk-amd64", "/usr/lib/jvm/java-17-openjdk-amd64", join(homedir(), "android-studio", "jbr"));
  }
  // Gradle 9 and AGP 9 want 17…25; prefer 21, then 17.
  const usable = candidates.filter(ok).map((d) => ({ d, v: major(d) })).filter((x) => x.v >= 17 && x.v <= 25);
  usable.sort((a, b) => (a.v === 21 ? -1 : b.v === 21 ? 1 : a.v === 17 ? -1 : b.v === 17 ? 1 : a.v - b.v));
  return usable[0]?.d;
}

function sdkDir() {
  const candidates = [process.env.ANDROID_HOME, process.env.ANDROID_SDK_ROOT, join(homedir(), "Library", "Android", "sdk"), join(homedir(), "Android", "Sdk"), "/opt/android-sdk"];
  return candidates.find((d) => d && existsSync(join(d, "platforms")));
}

const jdk = javaHome();
if (!jdk) fail("No JDK 17–25 found. Install one (e.g. Android Studio) or set JAVA_HOME.");
const sdk = sdkDir();
if (!sdk) fail("No Android SDK found. Install Android Studio (or the command-line tools) or set ANDROID_HOME.");
const localProps = join(androidDir, "local.properties");
if (!existsSync(localProps)) writeFileSync(localProps, `sdk.dir=${sdk.replace(/\\/g, "\\\\")}\n`);
console.log(`M5cet ${version} · ${type} · JDK ${jdk} · SDK ${sdk}`);

/* --------------------------------------------------------------- build */

// The built-in design and icons come from the server's code.
run("npx", ["tsx", "script/android-assets.ts"], { cwd: root });

const gradleArgs = [`:app:assemble${release ? "Release" : "Debug"}`];
if (!flag("skip-tests")) gradleArgs.push(":app:testDebugUnitTest");
const server = value("server");
const serverKey = value("server-key");
if (server) gradleArgs.push(`-Pm5.server=${server}`);
if (serverKey) gradleArgs.push(`-Pm5.serverKey=${serverKey}`);
gradleArgs.push("--console=plain");
const gradlew = join(androidDir, platform() === "win32" ? "gradlew.bat" : "gradlew");
run(gradlew, gradleArgs, { cwd: androidDir, env: { ...process.env, JAVA_HOME: jdk, ANDROID_HOME: sdk } });

const outDir = join(androidDir, "app", "build", "outputs", "apk", type);
const built = [`app-${type}.apk`, `app-${type}-unsigned.apk`].map((f) => join(outDir, f)).find(existsSync);
if (!built) fail(`No APK in ${outDir}`);
const unsigned = built.endsWith("-unsigned.apk");
const dist = join(root, "dist", "android");
mkdirSync(dist, { recursive: true });
const target = join(dist, `m5cet-${version}-${type}${unsigned ? "-unsigned" : ""}.apk`);
copyFileSync(built, target);
const apk = readFileSync(target);
const sha = createHash("sha256").update(apk).digest("hex");
console.log(`\n✓ ${target}\n  ${(apk.length / 1048576).toFixed(1)} MB · SHA-256 ${sha}`);

// The signing certificate (what the server pins for releases).
const buildTools = join(sdk, "build-tools");
const apksigner = existsSync(buildTools) ? readdirSync(buildTools).sort().reverse().map((v) => join(buildTools, v, platform() === "win32" ? "apksigner.bat" : "apksigner")).find(existsSync) : undefined;
if (apksigner && !unsigned) {
  const r = spawnSync(apksigner, ["verify", "--print-certs", target], { encoding: "utf8", env: { ...process.env, JAVA_HOME: jdk, PATH: `${join(jdk, "bin")}:${process.env.PATH}` } });
  const cert = /certificate SHA-256 digest: ([0-9a-f]+)/i.exec(r.stdout || "");
  if (cert) console.log(`  signing certificate SHA-256 ${cert[1]}`);
}
if (unsigned) console.log("  unsigned: set M5_KEYSTORE, M5_KEYSTORE_PASSWORD (and M5_KEY_ALIAS / M5_KEY_PASSWORD) to sign release builds.\n  A new key: keytool -genkeypair -v -keystore m5cet.jks -alias m5cet -keyalg EC -groupname secp256r1 -validity 10000");
if (release && !unsigned && !serverKey) console.log("  tip: --server-key <kid> pins the server's Android key in the app (Android › Overview shows the key id).");

/* ------------------------------------------------------ install, upload */

if (flag("install")) {
  const adb = [process.env.ADB, join(sdk, "platform-tools", "adb"), "adb"].find((p) => p && (p === "adb" || existsSync(p)));
  const devices = spawnSync(adb, ["devices"], { encoding: "utf8" }).stdout.split("\n").slice(1).filter((l) => /\tdevice$/.test(l));
  if (devices.length !== 1) fail(`--install needs exactly one connected device (adb devices lists ${devices.length}).`);
  if (unsigned) fail("an unsigned release APK cannot be installed — sign it or build debug.");
  run(adb, ["install", "-r", target]);
  console.log("✓ installed");
}

const uploadTo = value("upload");
if (uploadTo) {
  if (unsigned) fail("an unsigned APK cannot be a release — devices would refuse it.");
  const token = value("token") || process.env.M5_ADMIN_TOKEN;
  if (!token) fail("--upload needs --token or M5_ADMIN_TOKEN (an operator's token).");
  const params = new URLSearchParams({ channel: value("channel") || "stable", notes: value("notes") || "" });
  const res = await fetch(`${uploadTo.replace(/\/+$/, "")}/api/admin/android/releases/upload?${params}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/vnd.android.package-archive" },
    body: apk,
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) fail(`upload refused: ${body.message || res.status}`);
  console.log(`✓ uploaded ${body.release.versionName} (${body.release.versionCode}) as a draft — publish it in Android › Releases.`);
}
