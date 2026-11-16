import * as THREE from 'three';

async function loadText(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to load ${url}: ${res.status}`);
  return res.text();
}

// ---- Tuning constants -----------------------------------------------------------
const SIM_RES = 128;              // velocity/pressure/divergence/curl grid resolution
const DYE_RES = 720;              // color field resolution — higher than SIM_RES since this is what's actually visible on screen
const SPLAT_RADIUS = 0.0025;      // per-splat footprint size (UV-space Gaussian falloff radius)
const SPLAT_VELOCITY_SCALE = 3.0; // scales cursor speed into injected velocity
const DYE_INTENSITY = 0.28;       // scales cursor speed into injected color strength
// How many random hue jumps per second. Confirmed against the reference implementation's actual
// source (not guessed): color there isn't a continuous drift at all — it's a fresh random hue
// picked on a timer, dimmed down, and built up to full richness only through repeated overlapping
// splats. Concentric "rings" of distinct color come from age-ordering (fresh hue at the cursor,
// older hues pushed outward as the fluid advects away), same as our previous approach, but because
// each jump is unrelated to the last, neighboring rings can be any two colors instead of always
// adjacent ones on a wheel — that's what reads as more distinct/contrasty.
const COLOR_UPDATE_SPEED = 10.0;
// Controls how quickly leftover momentum from each splat settles before the next one lands.
// Too low, and momentum from repeated/sustained movement in one area compounds faster than it
// dissipates, so the affected region keeps growing without bound instead of reaching a steady
// size. Lowered from 6.0 so lateral vortices along a sustained stroke survive long enough to peel
// off and billow outward, instead of dying out too fast and leaving only a thin contained line.
const VELOCITY_DISSIPATION = 4.5;
const DYE_DISSIPATION = 3.5;      // how fast injected color fades
// Vorticity confinement — amount of swirl/turbulent detail. Raised from 10.0 alongside the lower
// dissipation above so the surviving lateral vortices are also strong enough to visibly curl and
// open up, not just linger faintly.
const CURL_STRENGTH = 14.0;
const PRESSURE_ITERATIONS = 20;   // Jacobi solve steps per frame for the pressure projection
// Decays the pressure field to 10% of its previous value before each frame's Jacobi solve.
// Without this, pressure carries forward at full strength indefinitely across frames and the
// simulation becomes unstable, spreading without bound rather than settling.
const PRESSURE_COEFFICIENT = 0.1;

async function main() {
  const [
    baseVert, splatFrag, advectionFrag, divergenceFrag, pressureFrag,
    gradientSubtractFrag, curlFrag, vorticityFrag, clearFrag, displayFrag,
  ] = await Promise.all([
    loadText('./shaders/base.vert'),
    loadText('./shaders/splat.frag'),
    loadText('./shaders/advection.frag'),
    loadText('./shaders/divergence.frag'),
    loadText('./shaders/pressure.frag'),
    loadText('./shaders/gradientSubtract.frag'),
    loadText('./shaders/curl.frag'),
    loadText('./shaders/vorticity.frag'),
    loadText('./shaders/clear.frag'),
    loadText('./shaders/display.frag'),
  ]);

  const canvas = document.getElementById('fx-canvas');
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, alpha: true });
  renderer.autoClear = false;

  function resize() {
    renderer.setPixelRatio(1); // sim resolution is deliberately decoupled from device pixel ratio
    renderer.setSize(window.innerWidth, window.innerHeight, false);
  }
  resize();
  window.addEventListener('resize', resize);

  function makeDoubleFBO(width, height) {
    const options = {
      type: THREE.HalfFloatType,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      wrapS: THREE.ClampToEdgeWrapping,
      wrapT: THREE.ClampToEdgeWrapping,
      depthBuffer: false,
      stencilBuffer: false,
    };
    let a = new THREE.WebGLRenderTarget(width, height, options);
    let b = new THREE.WebGLRenderTarget(width, height, options);
    return {
      get read() { return a; },
      get write() { return b; },
      swap() { const t = a; a = b; b = t; },
    };
  }
  function makeSingleFBO(width, height) {
    return new THREE.WebGLRenderTarget(width, height, {
      type: THREE.HalfFloatType,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      wrapS: THREE.ClampToEdgeWrapping,
      wrapT: THREE.ClampToEdgeWrapping,
      depthBuffer: false,
      stencilBuffer: false,
    });
  }

  const velocity = makeDoubleFBO(SIM_RES, SIM_RES);
  const dye = makeDoubleFBO(DYE_RES, DYE_RES);
  const divergence = makeSingleFBO(SIM_RES, SIM_RES);
  const curl = makeSingleFBO(SIM_RES, SIM_RES);
  const pressure = makeDoubleFBO(SIM_RES, SIM_RES);

  // One shared fullscreen quad — every pass just swaps its material and render target.
  const scene = new THREE.Scene();
  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2));
  scene.add(quad);

  function makeMaterial(fragmentShader, uniforms) {
    return new THREE.ShaderMaterial({ vertexShader: baseVert, fragmentShader, uniforms });
  }

  const simTexel = new THREE.Vector2(1 / SIM_RES, 1 / SIM_RES);
  const dyeTexel = new THREE.Vector2(1 / DYE_RES, 1 / DYE_RES);

  // On a wide (landscape) screen, additionally scale the splat radius by the aspect ratio itself
  // — separate from (and in addition to) the aspect-correction already inside splat.frag's
  // `p.x *= aspectRatio`. Without this, the splat reads noticeably smaller on wide desktop
  // screens than on square/tall ones for the same SPLAT_RADIUS value.
  function correctRadius(radius) {
    const aspectRatio = window.innerWidth / window.innerHeight;
    return aspectRatio > 1 ? radius * aspectRatio : radius;
  }

  const splatMaterial = makeMaterial(splatFrag, {
    texelSize: { value: simTexel },
    uTarget: { value: null },
    aspectRatio: { value: window.innerWidth / window.innerHeight },
    color: { value: new THREE.Vector3() },
    point: { value: new THREE.Vector2() },
    radius: { value: correctRadius(SPLAT_RADIUS) },
  });
  window.addEventListener('resize', () => {
    splatMaterial.uniforms.aspectRatio.value = window.innerWidth / window.innerHeight;
    splatMaterial.uniforms.radius.value = correctRadius(SPLAT_RADIUS);
  });
  const advectionMaterial = makeMaterial(advectionFrag, {
    texelSize: { value: simTexel },
    uVelocity: { value: null },
    uSource: { value: null },
    dt: { value: 0 },
    dissipation: { value: 1 },
  });
  const divergenceMaterial = makeMaterial(divergenceFrag, {
    texelSize: { value: simTexel },
    uVelocity: { value: null },
  });
  const pressureMaterial = makeMaterial(pressureFrag, {
    texelSize: { value: simTexel },
    uPressure: { value: null },
    uDivergence: { value: null },
  });
  const gradientSubtractMaterial = makeMaterial(gradientSubtractFrag, {
    texelSize: { value: simTexel },
    uPressure: { value: null },
    uVelocity: { value: null },
  });
  const curlMaterial = makeMaterial(curlFrag, {
    texelSize: { value: simTexel },
    uVelocity: { value: null },
  });
  const vorticityMaterial = makeMaterial(vorticityFrag, {
    texelSize: { value: simTexel },
    uVelocity: { value: null },
    uCurl: { value: null },
    curlStrength: { value: CURL_STRENGTH },
    dt: { value: 0 },
  });
  const clearMaterial = makeMaterial(clearFrag, {
    texelSize: { value: simTexel },
    uTexture: { value: null },
    value: { value: PRESSURE_COEFFICIENT },
  });
  const displayMaterial = makeMaterial(displayFrag, {
    texelSize: { value: dyeTexel },
    uDye: { value: null },
  });
  // Normal alpha compositing — gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA) — not additive.
  // display.frag derives alpha from brightness, and this blend mode is what lets that alpha
  // composite the dye cloud naturally against the page rather than summing color toward white.
  displayMaterial.transparent = true;
  displayMaterial.blending = THREE.CustomBlending;
  displayMaterial.blendSrc = THREE.OneFactor;
  displayMaterial.blendDst = THREE.OneMinusSrcAlphaFactor;
  displayMaterial.blendEquation = THREE.AddEquation;

  function pass(material, target) {
    quad.material = material;
    renderer.setRenderTarget(target);
    renderer.render(scene, camera);
  }

  // ---- Pointer tracking ------------------------------------------------------------
  const pointer = { x: 0.5, y: 0.5, prevX: 0.5, prevY: 0.5, moved: false };

  function updatePointer(clientX, clientY) {
    pointer.prevX = pointer.x;
    pointer.prevY = pointer.y;
    pointer.x = clientX / window.innerWidth;
    pointer.y = 1.0 - clientY / window.innerHeight;
    pointer.moved = true;
  }
  // Plain pointermove, no button/click required — the effect reacts to hover, not just drag.
  window.addEventListener('pointermove', (e) => updatePointer(e.clientX, e.clientY));
  window.addEventListener('touchmove', (e) => {
    if (e.touches.length > 0) updatePointer(e.touches[0].clientX, e.touches[0].clientY);
  }, { passive: true });

  // currentHue only changes when colorUpdateTimer rolls over — a fresh random pick, not a
  // continuous walk. Both are gated inside applySplat like before, so idle time doesn't advance
  // the timer either.
  let currentHue = Math.random();
  let colorUpdateTimer = 0;
  function hueColor(t) {
    const h = ((t % 1) + 1) % 1;
    const i = Math.floor(h * 6);
    const f = h * 6 - i;
    const q = 1 - f, tt = f;
    const table = [
      [1, tt, 0], [q, 1, 0], [0, 1, tt], [0, q, 1], [tt, 0, 1], [1, 0, q],
    ];
    return table[i % 6];
  }

  function applySplat(dt) {
    if (!pointer.moved) return;
    pointer.moved = false;

    // pointer.x/y are normalized independently by width and height, so on a non-square viewport a
    // physically circular mouse gesture produces an anisotropic (dx, dy) here — one axis reads a
    // bigger delta per pixel moved than the other. Scaling dx by the same aspectRatio splat.frag
    // uses for its footprint puts both axes back in the same physical-distance units, so a real
    // circular gesture actually injects a circular (not stretched) velocity field.
    const aspectRatio = splatMaterial.uniforms.aspectRatio.value;
    const dx = (pointer.x - pointer.prevX) * aspectRatio / Math.max(dt, 1 / 240);
    const dy = (pointer.y - pointer.prevY) / Math.max(dt, 1 / 240);
    const speed = Math.min(Math.hypot(dx, dy), 6.0);
    if (speed < 0.02) return; // ignore sub-pixel jitter

    colorUpdateTimer += dt * COLOR_UPDATE_SPEED;
    if (colorUpdateTimer >= 1) {
      colorUpdateTimer %= 1;
      currentHue = Math.random();
    }

    splatMaterial.uniforms.uTarget.value = velocity.read.texture;
    splatMaterial.uniforms.point.value.set(pointer.x, pointer.y);
    splatMaterial.uniforms.color.value.set(dx * SPLAT_VELOCITY_SCALE, dy * SPLAT_VELOCITY_SCALE, 0);
    pass(splatMaterial, velocity.write);
    velocity.swap();

    const intensity = Math.min(speed, 1.5) * DYE_INTENSITY;
    const [r, g, b] = hueColor(currentHue);
    splatMaterial.uniforms.uTarget.value = dye.read.texture;
    splatMaterial.uniforms.color.value.set(r * intensity, g * intensity, b * intensity);
    pass(splatMaterial, dye.write);
    dye.swap();
  }

  // ---- Render loop -------------------------------------------------------------------
  const clock = new THREE.Clock();
  function tick(dt) {
    applySplat(dt);

    curlMaterial.uniforms.uVelocity.value = velocity.read.texture;
    pass(curlMaterial, curl);

    vorticityMaterial.uniforms.uVelocity.value = velocity.read.texture;
    vorticityMaterial.uniforms.uCurl.value = curl.texture;
    vorticityMaterial.uniforms.dt.value = dt;
    pass(vorticityMaterial, velocity.write);
    velocity.swap();

    divergenceMaterial.uniforms.uVelocity.value = velocity.read.texture;
    pass(divergenceMaterial, divergence);

    clearMaterial.uniforms.uTexture.value = pressure.read.texture;
    pass(clearMaterial, pressure.write);
    pressure.swap();

    for (let i = 0; i < PRESSURE_ITERATIONS; i++) {
      pressureMaterial.uniforms.uPressure.value = pressure.read.texture;
      pressureMaterial.uniforms.uDivergence.value = divergence.texture;
      pass(pressureMaterial, pressure.write);
      pressure.swap();
    }

    gradientSubtractMaterial.uniforms.uPressure.value = pressure.read.texture;
    gradientSubtractMaterial.uniforms.uVelocity.value = velocity.read.texture;
    pass(gradientSubtractMaterial, velocity.write);
    velocity.swap();

    advectionMaterial.uniforms.uVelocity.value = velocity.read.texture;
    advectionMaterial.uniforms.uSource.value = velocity.read.texture;
    advectionMaterial.uniforms.dt.value = dt;
    advectionMaterial.uniforms.dissipation.value = VELOCITY_DISSIPATION;
    pass(advectionMaterial, velocity.write);
    velocity.swap();

    advectionMaterial.uniforms.uVelocity.value = velocity.read.texture;
    advectionMaterial.uniforms.uSource.value = dye.read.texture;
    advectionMaterial.uniforms.dissipation.value = DYE_DISSIPATION;
    pass(advectionMaterial, dye.write);
    dye.swap();

    displayMaterial.uniforms.uDye.value = dye.read.texture;
    pass(displayMaterial, null);
  }

  renderer.setAnimationLoop(() => {
    tick(Math.min(clock.getDelta(), 1 / 30));
  });

  window.__wglFxDebugTick = tick; // exposed for headless/automated verification only
}

main().catch((err) => {
  console.error('webgl-scroll-fx fluid starter v2 failed to initialize:', err);
});
