function showMessage() {
  alert("Thank you for choosing TradeCo! Let's grow together.");
}

window.addEventListener("scroll", function () {
    const navbar = document.querySelector(".trade-navbar");

    if (window.scrollY > 50) {
        navbar.classList.add("scrolled");
    } else {
        navbar.classList.remove("scrolled");
    }
});

const languageButtons = document.querySelector(".language-buttons");
const enButton = document.querySelector(".language-en");
const arButton = document.querySelector(".language-ar");


function changeLanguage(language) {
    const elements = document.querySelectorAll("[data-en][data-ar]");

    elements.forEach(element => {
        element.textContent = element.getAttribute(`data-${language}`);
    });

    // Change page language and direction
    document.documentElement.lang = language;
    document.documentElement.dir = language === "ar" ? "rtl" : "ltr";

    // Update language buttons
    if (language === "ar") {
        languageButtons.classList.add("ar-selected");
    } else {
        languageButtons.classList.remove("ar-selected");
    }

    // Change Services direction
    const servicesSection = document.querySelector(".services-section");

    if (servicesSection) {
        servicesSection.setAttribute(
            "dir",
            language === "ar" ? "rtl" : "ltr"
        );
    }

    // Change About direction
    const aboutSection = document.querySelector(".about-section");

    if (aboutSection) {
        aboutSection.setAttribute(
            "dir",
            language === "ar" ? "rtl" : "ltr"
        );
    }

    // Rebuild About word spans after changing the language
    if (typeof window.refreshAboutWords === "function") {
        window.refreshAboutWords();
    }
}


enButton.addEventListener("click", function () {
    changeLanguage("en");
});

arButton.addEventListener("click", function () {
    changeLanguage("ar");
});


const servicesSection =
    document.querySelector(".services-section");

const servicesVideo =
    document.querySelector("#servicesVideo");

const serviceCards =
    document.querySelectorAll(".service-card");


let targetProgress = 0;
let currentProgress = 0;


/* ================================= */
/* GET SCROLL POSITION               */
/* ================================= */

function updateScrollTarget() {

    const rect =
        servicesSection.getBoundingClientRect();

    const sectionHeight =
        servicesSection.offsetHeight -
        window.innerHeight;

    const scrolled =
        -rect.top;

    targetProgress =
        scrolled / sectionHeight;

    targetProgress =
        Math.max(0, Math.min(1, targetProgress));
}


/* ================================= */
/* SMOOTH ANIMATION                  */
/* ================================= */

function animateServices() {

    /*
       Very smooth interpolation.

       0.04 = slower and more cinematic
       0.06 = smooth
       0.08 = responsive
    */

    currentProgress +=
        (targetProgress - currentProgress) * 0.50;


    /* ============================== */
    /* VIDEO                          */
    /* ============================== */

    if (
        servicesVideo.readyState >= 2 &&
        Number.isFinite(servicesVideo.duration)
    ) {

        const targetTime =
            currentProgress *
            servicesVideo.duration;


        /*
           Only update when the difference
           is meaningful.
        */

        if (
            Math.abs(
                servicesVideo.currentTime -
                targetTime
            ) > 0.050
        ) {

            servicesVideo.currentTime =
                targetTime;
        }
    }


    /* ============================== */
    /* CARDS                          */
    /* ============================== */

    const cardIndex =
        Math.min(
            serviceCards.length - 1,

            Math.floor(
                currentProgress *
                serviceCards.length
            )
        );


    serviceCards.forEach((card, index) => {

        card.classList.toggle(
            "active",
            index === cardIndex
        );

    });


    requestAnimationFrame(animateServices);
}


/* ================================= */
/* SCROLL                            */
/* ================================= */

window.addEventListener(
    "scroll",
    updateScrollTarget,
    { passive: true }
);


/* ================================= */
/* START                             */
/* ================================= */

servicesVideo.addEventListener(
    "loadedmetadata",
    () => {

        updateScrollTarget();

        currentProgress =
            targetProgress;

        requestAnimationFrame(
            animateServices
        );

    }
);


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

    const aspectRatio = splatMaterial.uniforms.aspectRatio.value;

    const dx =
        (pointer.x - pointer.prevX) *
        aspectRatio /
        Math.max(dt, 1 / 240);

    const dy =
        (pointer.y - pointer.prevY) /
        Math.max(dt, 1 / 240);

    const speed = Math.min(Math.hypot(dx, dy), 6.0);

    if (speed < 0.02) return;


    // ---------------- VELOCITY ----------------

    splatMaterial.uniforms.uTarget.value = velocity.read.texture;

    splatMaterial.uniforms.point.value.set(
        pointer.x,
        pointer.y
    );

    splatMaterial.uniforms.color.value.set(
        dx * SPLAT_VELOCITY_SCALE,
        dy * SPLAT_VELOCITY_SCALE,
        0
    );

    pass(splatMaterial, velocity.write);

    velocity.swap();


    const intensity = Math.min(speed, 1.5) * DYE_INTENSITY;

    splatMaterial.uniforms.uTarget.value = dye.read.texture;

    splatMaterial.uniforms.color.value.set(
        intensity,
        intensity,
        intensity
    );

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


//----------------------------------------------------------------
function initAboutAnimation() {
    const aboutSection = document.querySelector(".about-scroll-section");
    const aboutVideo = document.querySelector("#AboutVideo");
    const aboutTitle = document.querySelector(".about-content h2");
    const aboutTimeline = document.querySelector(".about-timeline");
    const timelineProgress = document.querySelector(".timeline-progress");
    const timelineStartDot = document.querySelector(".timeline-point-start .timeline-dot");
    const timelineEndDot = document.querySelector(".timeline-point-end .timeline-dot");
    const aboutCards = Array.from(
        document.querySelectorAll(".about-card")
    );

    if (!aboutSection || !aboutVideo || !aboutTitle || !aboutCards.length) {
        console.error("About section elements were not found.");
        return;
    }

    let targetProgress = 0;
    let currentProgress = 0;

    const cardsStart = 0.25;
    const cardsDuration = 1 - cardsStart;
    const totalCards = aboutCards.length;

    // Store each card's word elements so they can be refreshed.
    let cardWords = [];

    function rebuildAboutWords() {
        cardWords = aboutCards.map(card => {
            const paragraph = card.querySelector("p");

            if (!paragraph) return [];

            // Keep the current translated text, but rebuild its word spans.
            const text = paragraph.textContent.trim();
            paragraph.replaceChildren();

            const words = text ? text.split(/\s+/) : [];

            words.forEach((word, index) => {
                const span = document.createElement("span");
                span.className = "word";
                span.textContent = word;

                if (/[a-zA-Z]/.test(word)) {
                    span.classList.add("latin-word");
                    span.setAttribute("dir", "ltr");
                }

                paragraph.appendChild(span);

                if (index < words.length - 1) {
                    paragraph.appendChild(document.createTextNode(" "));
                }
            });

            return Array.from(paragraph.querySelectorAll(".word"));
        });
    }

    // Build the initial word spans.
    rebuildAboutWords();

    function updateScrollTarget() {
        const rect = aboutSection.getBoundingClientRect();
        const scrollDistance =
            aboutSection.offsetHeight - window.innerHeight;

        targetProgress = scrollDistance > 0
            ? -rect.top / scrollDistance
            : 0;

        targetProgress = Math.max(0, Math.min(1, targetProgress));
    }

    function animateAbout() {
        // Smoothly follow scroll progress.
        currentProgress += (targetProgress - currentProgress) * 0.2;

        if (Math.abs(targetProgress - currentProgress) < 0.0005) {
            currentProgress = targetProgress;
        }

        // Scrub the background video.
        if (
            aboutVideo.readyState >= 2 &&
            Number.isFinite(aboutVideo.duration) &&
            aboutVideo.duration > 0
        ) {
            const targetTime = currentProgress * aboutVideo.duration;

            if (Math.abs(aboutVideo.currentTime - targetTime) > 0.05) {
                aboutVideo.currentTime = targetTime;
            }
        }

        // Animate the About title.
        const titleProgress = Math.min(currentProgress / 0.30, 1);
        const titleScale = 1 - titleProgress * 0.55;
        const titleMoveY = titleProgress * -70;

        aboutTitle.style.transform =
            `translate(-50%, calc(-50% + ${titleMoveY}px)) scale(${titleScale})`;

        // Hide cards before the card sequence starts.
        if (currentProgress < cardsStart) {
            aboutCards.forEach(card => card.classList.remove("active"));

            cardWords.forEach(words => {
                words.forEach(word => word.classList.remove("revealed"));
            });

            requestAnimationFrame(animateAbout);
            return;
        }

       // Progress through the entire card sequence.
        const cardsProgress = Math.min(
            (currentProgress - cardsStart) / cardsDuration,
            1
        );

        // Reserve part of each card's scroll interval for a pause.
        const revealPortion = 0.75;
        const cardPosition = cardsProgress * totalCards;

        const cardIndex = Math.min(
            Math.floor(cardPosition),
            totalCards - 1
        );

        const progressWithinCard = cardPosition - cardIndex;

        // Reveal words during the first 75% of the card's interval.
        // Use the remaining 25% to keep the completed card visible.
        const wordProgress = Math.min(
            progressWithinCard / revealPortion,
            1
        );
        
        // Timeline begins at the third card and ends at the last card.
        const timelineStart = 2;
        const timelineEnd = totalCards;

        if (cardIndex >= timelineStart) {
            aboutTimeline.classList.add("visible");

            const timelineProgressValue = Math.max(
                0,
                Math.min(
                    1,
                    (cardPosition - timelineStart) /
                    (timelineEnd - timelineStart)
                )
            );

            timelineProgress.style.width =
                `${timelineProgressValue * 100}%`;

            // Glow the start point as soon as the timeline appears.
            timelineStartDot.classList.add("glowing");

            // Glow the end point when the line reaches it.
            timelineEndDot.classList.toggle(
                "glowing",
                timelineProgressValue >= 1
            );

        } 
        else {
            aboutTimeline.classList.remove("visible");
            timelineProgress.style.width = "0%";

            timelineStartDot.classList.remove("glowing");
            timelineEndDot.classList.remove("glowing");
        }

        // Activate exactly one card.
        aboutCards.forEach((card, index) => {
            card.classList.toggle("active", index === cardIndex);
        });

        // Reveal words belonging ONLY to the active card.
        cardWords.forEach((words, index) => {
            words.forEach((word, wordIndex) => {
                let revealed = false;

                if (index < cardIndex) {
                    revealed = true;
                } else if (index === cardIndex) {
                    const threshold = (wordIndex + 1) / words.length;
                    revealed = wordProgress >= threshold;
                }

                word.classList.toggle("revealed", revealed);
            });
        });

        requestAnimationFrame(animateAbout);
    }

    window.addEventListener("scroll", updateScrollTarget, {
        passive: true
    });

    window.addEventListener("resize", updateScrollTarget);

    aboutVideo.addEventListener("loadedmetadata", updateScrollTarget);

    window.addEventListener("pageshow", updateScrollTarget);

    updateScrollTarget();

    currentProgress = targetProgress;

    requestAnimationFrame(animateAbout);
    window.refreshAboutWords = rebuildAboutWords;
}

// Initialize after the HTML elements exist.
if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initAboutAnimation);
} else {
    initAboutAnimation();
}