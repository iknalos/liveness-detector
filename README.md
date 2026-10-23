# LivenessCheck

An Android app that tells a **live face** from a **photo, printed picture or screen replay** by
flashing light from the phone's screen and measuring how the face reflects it, then checks the
face against the one you registered. No cloud, no uploads: everything runs on the phone.

## What the screen light can and can't measure

A phone screen has three kinds of emitter: red, green and blue sub-pixels (around 620, 530 and
460 nm on an OLED). Every colour it shows is a mix of those three. "Orange" is red + green
light; there is no 590 nm light in it. Light adds linearly, so a face lit by orange looks exactly
like (face under red) + (face under green). Flashing red, green and blue once therefore captures
all the colour information a screen can give. Showing 24 colours, as v1 did, repeats the same
three measurements with more noise. The app shows this on your own phone: *white ÷ (red + green +
blue)* comes out close to 1.

Those three bands do hit very different parts of skin's absorption curve: melanin absorbs the
blue, haemoglobin the green, and red reflects strongly. That **3 × 3 response** (the camera's R,
G and B channels under the screen's R, G and B light) is the skin's spectral signature here.

The screen can also light the face **from different directions**: its left, right, top or
bottom half. That shows 3D shape, which a photo can't fake.

## The scan (~7 s)

1. Line your face up in the oval (25–35 cm). The app takes a face descriptor for identity.
2. White balance is locked, and the screen flashes a **random** sequence: white, red, green, blue,
   left/right halves, top/bottom halves and fine stripes. Every flash is followed by black, and
   every slot length is randomly jittered.
3. Each camera frame of the face is stored with its timestamp. The camera's lag behind the
   screen is measured from the reflection itself.

## The checks

| Check | Physics | Catches |
|---|---|---|
| Follows the flash sequence | Brightness must follow the random sequence (partial R² over a slow drift) | Pictures, replays of an earlier scan |
| Whole face reflects | Every face region must reflect the white flash well above noise | Screens (they mirror light only in a glare spot) |
| Not self-lit | Light seen during black slots ÷ reflected light | Phone/tablet screens; also a too-bright room |
| No mirror-like glare | Stripes are reflected only by mirrors; colourless glare changes the shading more in green/blue than in red; relief too strong for a face | Glossy prints, screens |
| 3D shape: side light | log(left ÷ right) must step across the nose beyond the smooth trend of the rest of the face | Flat, tilted and bent prints, screens |
| 3D shape: top/bottom light | log(top ÷ bottom) must be far from a smooth surface | Same |
| Kept still | Landmarks before vs after, and repeat-to-repeat spread | Movement (asks you to retry) |

The ratio maps cancel the albedo, meaning the picture printed on the paper. A photo of a face,
even with its shading baked in, gives the smooth near-planar map of a sheet of paper.

**Verification** also requires the face descriptor to match the registered one (face-api
128-D distance ≤ 0.5) and the skin's spectral signature to match the registration (an AWB- and
exposure-independent ratio of the 3 × 3 response).

## How the thresholds were set

`test/sim_geometry.py` renders the MediaPipe canonical face mesh lit by the halves of an
S21-sized screen, 30 cm away with the camera at the top edge. It renders a flat, tilted and bent
print of the same face too. A real face gives a nose step of about **0.17** (log ratio) and a
vertical relief of **0.06**. Prints give **< 0.005** and **< 0.002**. Thresholds sit at roughly
⅓ of the face values.

`test/analysis.test.js` runs the full analysis on a simulated camera with skin colour, ambient
light, colour crosstalk, display lag, exposure blur, auto-exposure wobble, gamma, noise and
8-bit rounding. A real face passes, in a dim room, a lit room, at 15 fps and with dark skin.
Matte, semi-gloss and glossy prints, a face on a phone screen and a static picture all fail.

`test/e2e/run_e2e.py` drives the real app in Chrome with a virtual camera that relights a face
photo from the same simulation. It registers, verifies, and tries a different person, prints
and a screen.

These are simulations. Real phones add things the model doesn't have, so the result screen has
**Show measurement details**: the reflection maps, the spectral table and a **Copy report**
button. Those numbers are what to look at if a real face fails or a photo passes.

## Install

Download `LivenessCheck.apk` from the [latest release](https://github.com/iknalos/liveness-detector/releases/latest)
and install it (allow installs from your browser once). Installed copies update themselves: the
app shows **Update available** when a newer build is out.

Builds before 2.0 were signed with a throwaway debug key. Uninstall that version once before
installing 2.0.

## Usage

1. **Register**: indoors, face 25–35 cm from the screen, keep still. Only a scan that passes
   every liveness check can register.
2. **Verify**: same position. Try it with a photo of yourself, on paper or on another phone, to
   see the liveness checks reject it.

Best in normal indoor light or dimmer. In direct sunlight the screen's light is lost in the
ambient light.

## Limits

- 3D masks and silicone heads are not addressed: they are 3D and reflect light like skin's surface.
- Thresholds come from simulation. Real-phone data (Copy report) is what tunes them.
- The face descriptor is face-api's (99.4% on LFW). It is not certified biometrics.
- No pulse or heat check: the camera can't see heat (that needs a thermal sensor), and pulse
  detection from video (rPPG) would need a longer, very still scan. Possible next step.

## Build locally

Requirements: Node 20+, Java 17, Android SDK 34.

```bash
npm install
npm test               # simulated-camera tests
npm run build          # bundle face models into www/vendor, cap sync
cd android && ./gradlew assembleDebug
```

## Layout

```
www/js/patterns.js   flash patterns + random sequence
www/js/analysis.js   timing fit, reflection, spectral, 3D and glare checks (pure, tested in Node)
www/js/face.js       face-api wrapper (detection, 68 landmarks, descriptor)
www/js/main.js       camera, scan flow, results, diagnostics
www/js/updater.js    in-app update banner
android/.../UpdaterPlugin.java, BrightnessPlugin.java
test/                simulator, Node tests, browser end-to-end test
```
