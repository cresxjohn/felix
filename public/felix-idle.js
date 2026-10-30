// Felix on standby: every few seconds the bottom bar's face does one of ten small things, picked at random and never
// the same twice in a row. Each mood is a short CSS animation (shell.css, [data-idle]) that starts and ends on his
// resting face, so one flows into the next. He rests while he listens, thinks or talks, and while the window is
// hidden; with reduced motion on he only rests.
(() => {
  /** Each mood and how long it lasts, in ms (its animation's length in shell.css). */
  const MOODS = {
    blink: 420, "double-blink": 760, "glance-left": 1800, "glance-right": 1800, "look-up": 1600,
    unwink: 1500, grin: 1600, nod: 1200, tilt: 2000, hop: 900,
  };
  const NAMES = Object.keys(MOODS);
  const reduce = matchMedia("(prefers-reduced-motion: reduce)");
  let last = "";

  /** The faces in the bar, and the chat's reply row, that are on standby. */
  const faces = () => [...document.querySelectorAll(".mark.lg")].filter((m) => !m.matches(".listening, .thinking, .talking"));

  /** Waits a little, then plays the next mood. */
  const next = () => setTimeout(play, 1600 + Math.random() * 3400);

  /** Plays one mood on every standby face, then clears it once its animation is back at rest. */
  function play() {
    const list = faces();
    if (document.hidden || reduce.matches || !list.length) return next();
    let name;
    do name = NAMES[Math.floor(Math.random() * NAMES.length)]; while (name === last);
    last = name;
    for (const m of list) m.dataset.idle = name;
    setTimeout(() => {
      for (const m of document.querySelectorAll(`.mark[data-idle="${name}"]`)) delete m.dataset.idle;
      next();
    }, MOODS[name] + 60);
  }

  next();
})();
