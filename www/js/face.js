// Face detection, 68 landmarks and a 128-number face descriptor (face-api, MIT), all running
// on the phone from bundled models: nothing is uploaded.

(function (root) {
  'use strict';

  const MODEL_URL = 'vendor/face-api/model';
  let ready = null;

  function load() {
    if (ready) return ready;
    ready = (async () => {
      const fa = root.faceapi;
      if (!fa) throw new Error('face-api did not load');
      try { await fa.tf.setBackend('webgl'); } catch (_) { /* falls back to cpu/wasm */ }
      await fa.tf.ready();
      await Promise.all([
        fa.nets.tinyFaceDetector.loadFromUri(MODEL_URL),
        fa.nets.faceLandmark68Net.loadFromUri(MODEL_URL),
        fa.nets.faceRecognitionNet.loadFromUri(MODEL_URL),
      ]);
      // first inference compiles the GPU shaders; do it now, not mid-scan
      const warm = document.createElement('canvas');
      warm.width = warm.height = 160;
      await fa.detectSingleFace(warm, new fa.TinyFaceDetectorOptions({ inputSize: 160 })).withFaceLandmarks();
      return fa.tf.getBackend();
    })();
    ready.catch(() => { ready = null; });
    return ready;
  }

  // input: video or canvas. Returns null or {box, landmarks:[[x,y]*68], descriptor?, score}.
  async function detect(input, withDescriptor = false) {
    const fa = root.faceapi;
    const opts = new fa.TinyFaceDetectorOptions({ inputSize: 320, scoreThreshold: 0.5 });
    let task = fa.detectSingleFace(input, opts).withFaceLandmarks();
    if (withDescriptor) task = task.withFaceDescriptor();
    const r = await task;
    if (!r) return null;
    const b = r.detection.box;
    return {
      box: { x: b.x, y: b.y, w: b.width, h: b.height },
      landmarks: r.landmarks.positions.map(p => [p.x, p.y]),
      descriptor: r.descriptor ? Array.from(r.descriptor) : null,
      score: r.detection.score,
    };
  }

  root.Face = { load, detect };
})(window);
