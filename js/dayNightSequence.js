/* ==========================================================================
 * dayNightSequence.js — plays two videos of one scene as a single film that
 * runs from morning to night and back (day-to-night.html).
 *
 *   forward   day -> night  (study_day-night.mp4)
 *   backward  night -> day  (study_night-to-day.mp4): its mirror image
 *
 * SCENE TIME: one clock for both videos, s = 0 (morning) .. span (night).
 * The forward video at time t shows scene time t; the backward video at time
 * t shows span - t. (Measured on these files: forward frame k matches backward
 * frame 119 - k within about 6 levels; they are separate renders, not an exact
 * reverse, so every switch between them is covered by a short crossfade.)
 * Browsers can't play video backwards, hence the second video.
 *
 * LAYERS: each video sits in its own layer element (with its painted copy,
 * see js/videoShaderRender.js). The active layer is on top (z-index 2); a
 * newly activated layer is raised and faded in from opacity 0 while it is
 * already moving, then the other one is paused.
 *
 * MODES
 *   autoplay  the active video plays; when it ends, the other one takes over
 *             from its start, so day -> night -> day ... loops endlessly.
 *             Speed eases down into each end (night, morning) and back up out
 *             of it, so the turnaround reads as a dwell, not a rewind.
 *   seek      goTo(s): move to scene time s and stop on its exact frame, with
 *             front-loaded easing: launch fast (up to MAX_RATE), decelerate as
 *             the target nears (speed ∝ remaining distance), land softly.
 *   scrub     scrubTo(s) while dragging: show the frame at s (seeks).
 *   paused    stopped by pause(), a time point, a drag, or the tab hiding.
 *
 * SPEED is steered by setting playbackRate every animation frame; frames are
 * still decoded and presented normally, and the final stop is frame-exact
 * (requestVideoFrameCallback reports each presented frame).
 *
 * Exposes window.DayNightSequence.create().
 * ======================================================================== */
(function () {
  "use strict";

  /** Crossfade between the two videos, in ms. */
  const FADE_MS = 400;
  /** Shorter crossfade when only swapping to the other video's identical end frame. */
  const SWAP_FADE_MS = 250;

  /**
   * Seek easing (scene seconds per second = playbackRate).
   *   MAX_RATE     top speed. Measured on this 1080p footage (Apple M2 Pro,
   *                Chrome): no dropped frames up to 4x; 17 % dropped at 6x.
   *                Adapts per device: lowered by 0.5x after a move that
   *                drops over 10 % of its frames (not below 2x), raised again
   *                after clean moves.
   *   MIN_RATE     speed floor for the last few frames, so the landing is
   *                soft but never crawls.
   *   APPROACH_S   speed = remaining distance / APPROACH_S: an exponential,
   *                front-loaded approach (ease-out). Measured with 0.2 s:
   *                1 s of film takes ~0.6 s, 5 s ~1.6 s (constant 2x took
   *                0.5 s and 2.5 s).
   *   LAUNCH_S     ease-in from 1x to full speed, so the start isn't a jolt.
   */
  const SEEK = { MAX_RATE: 4, MIN_RATE: 0.8, APPROACH_S: 0.2, LAUNCH_S: 0.15 };
  /**
   * Autoplay ends easing: within END_S of scene time from morning or night,
   * speed eases (smoothstep) down to END_FLOOR x the autoplay speed.
   */
  const ENDS = { END_S: 0.6, END_FLOOR: 0.35 };

  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  const smoothstep = x => { x = clamp(x, 0, 1); return x * x * (3 - 2 * x); };

  /** Resolves after the video's next "seeked" (or at once if it isn't seeking), at most `ms` later. */
  function seeked(video, ms = 1500) {
    if (!video.seeking) return Promise.resolve();
    return new Promise(resolve => {
      const done = () => { clearTimeout(timer); video.removeEventListener("seeked", done); resolve(); };
      const timer = setTimeout(done, ms);
      video.addEventListener("seeked", done);
    });
  }

  /**
   * @typedef {{ video: HTMLVideoElement, layer: HTMLElement }} Track
   *   A video and the layer element that holds it (and its painted copy).
   *
   * @typedef {Object} SequenceState  What onUpdate() receives.
   * @property {number} position  Scene time on screen, 0..span.
   * @property {"autoplay" | "seek" | "scrub" | "paused"} mode
   * @property {number | null} target  Seek target.
   * @property {boolean} playing  A video is actually moving (false if autoplay was blocked).
   */

  /**
   * @param {Object} o
   * @param {Track} o.forward   Morning -> night.
   * @param {Track} o.backward  Night -> morning.
   * @param {number} [o.span=5]  Scene length in seconds.
   * @param {number} [o.fps=24]  Frame rate, for frame-exact stops.
   * @param {number} [o.autoplayRate=1]  Autoplay speed (between the eased ends).
   * @param {(state: SequenceState) => void} [o.onUpdate]  Every animation frame while
   *   anything moves, and once when it stops.
   * @param {(s: number) => void} [o.onArrive]  A seek reached its target.
   */
  function create({ forward, backward, span = 5, fps = 24, autoplayRate = 1, onUpdate = () => {}, onArrive = () => {} }) {
    const frame = 1 / fps;
    const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)");
    /** @type {Track} The track on top. */
    let active = forward;
    /** @type {SequenceState["mode"]} */
    let mode = "paused";
    /** Seek mode: the scene time to stop at, and when the move started. */
    let target = null, seekStart = 0;
    /** Bumped by every command; stale async steps check it and stop. */
    let token = 0;
    /** Running crossfades (the animation loop keeps going while any runs). */
    let fading = 0;
    /** Top seek speed; lowered if a move drops frames. */
    let maxRate = SEEK.MAX_RATE;
    /** Dropped / presented frame counts of the moving video at the start of a seek. */
    let droppedAtStart = 0, totalAtStart = 0;
    /** Scrub mode: the latest requested scene time (applied as seeks finish). */
    let scrubTarget = null;
    /** Autoplay was running when the tab was hidden. */
    let resumeOnShow = false;

    const other = track => (track === forward ? backward : forward);
    /** Scene time shown by `track` at its video time t. */
    const sceneTime = (track, t = track.video.currentTime) => clamp(track === forward ? t : span - t, 0, span);
    /** The video time at which `track` shows scene time s. */
    const videoTime = (track, s) => clamp(track === forward ? s : span - s, 0, track.video.duration || span);
    const quality = v => (v.getVideoPlaybackQuality ? v.getVideoPlaybackQuality() : { droppedVideoFrames: 0, totalVideoFrames: 0 });

    /** Starts a video; a blocked play() (autoplay policy) leaves it paused and the state says so. */
    function play(video, rate) {
      video.playbackRate = rate;
      const p = video.play();
      if (p && p.catch) p.catch(() => { wake(); });
    }

    function stack() {
      active.layer.style.zIndex = 2;
      other(active).layer.style.zIndex = 1;
    }

    /**
     * Makes `next` the visible track at scene time s: seek it (still
     * underneath), start it at `rate` if given (so motion begins at once,
     * during the crossfade), raise it and fade it in, then pause the previous
     * track, unless a newer command has made it active again meanwhile.
     * @returns {Promise<boolean>} false if a newer command took over.
     */
    async function handOver(next, s, rate, my, fadeMs = FADE_MS) {
      const v = next.video, t = videoTime(next, s);
      if (Math.abs(v.currentTime - t) > frame / 2) { v.currentTime = t; await seeked(v); }
      if (my !== token) return false;
      if (rate) play(v, rate);
      const prev = active;
      active = next;
      stack();
      if (!reducedMotion.matches) {
        fading++;
        wake();
        await next.layer.animate([{ opacity: 0 }, { opacity: 1 }], { duration: fadeMs, easing: "ease-in-out" })
          .finished.catch(() => {});
        fading--;
      }
      if (prev !== active) prev.video.pause();
      return my === token;
    }

    /** Parks the inactive video at its start, ready for the next autoplay hand-over. */
    function park() {
      const v = other(active).video;
      if (v.currentTime !== 0 && !v.seeking) v.currentTime = 0;
    }

    // ------------------------------------------------------------ speed control

    /** Seek speed: front-loaded (∝ remaining distance), capped, with a short ease-in launch. */
    function seekRate(now) {
      const remaining = Math.abs(target - sceneTime(active));
      const cruise = clamp(remaining / SEEK.APPROACH_S, SEEK.MIN_RATE, maxRate);
      const launch = smoothstep((now - seekStart) / 1000 / SEEK.LAUNCH_S);
      return 1 + (cruise - 1) * launch;
    }

    /** Autoplay speed: eases down into morning and night, and back up out of them. */
    function autoplaySpeed() {
      const s = sceneTime(active);
      const nearEnd = Math.min(s, span - s);
      return autoplayRate * (ENDS.END_FLOOR + (1 - ENDS.END_FLOOR) * smoothstep(nearEnd / ENDS.END_S));
    }

    // ------------------------------------------------------------ animation loop

    let looping = false;
    const anyPlaying = () => !forward.video.paused || !backward.video.paused;
    /** Starts the per-frame loop (speed control + onUpdate) if it isn't running. */
    function wake() {
      if (looping) return;
      looping = true;
      requestAnimationFrame(tick);
    }
    function tick(now) {
      const v = active.video;
      if (!v.paused) {
        const rate = mode === "seek" ? seekRate(now) : mode === "autoplay" ? autoplaySpeed() : null;
        if (rate && Math.abs(v.playbackRate - rate) > 0.01) v.playbackRate = rate;
      }
      onUpdate({ position: sceneTime(active), mode, target, playing: anyPlaying() });
      // Keep going while anything moves; otherwise stop (one last update was just sent).
      if (anyPlaying() || fading || active.video.seeking || mode === "scrub") requestAnimationFrame(tick);
      else looping = false;
    }

    // ------------------------------------------------------------ autoplay

    // When the active video ends: in autoplay the other one takes over from
    // its start (matching the ended video's last frame); in a seek, the end
    // is the target (morning or night) and the arrival is handled there.
    for (const track of [forward, backward]) {
      track.video.addEventListener("ended", async () => {
        if (track !== active || mode !== "autoplay") return;
        const my = token;
        if (await handOver(other(track), sceneTime(track), autoplayRate * ENDS.END_FLOOR, my)) park();
      });
    }

    /** Continuous day -> night -> day playback from where the film is now. */
    function autoplay() {
      token++;
      mode = "autoplay";
      target = null;
      const v = active.video;
      if (v.ended || v.currentTime >= (v.duration || span) - frame / 2) v.dispatchEvent(new Event("ended"));
      else { play(v, autoplaySpeed()); park(); }
      wake();
    }

    /** Stops wherever the film is. */
    function pause() {
      token++;
      mode = "paused";
      target = null;
      forward.video.pause();
      backward.video.pause();
      wake();
    }

    // ------------------------------------------------------------ seek

    /**
     * Moves to scene time s and stops on its exact frame: the forward video if
     * s is later in the day than now, the backward video if earlier.
     * @param {number} s  Scene time, 0..span.
     */
    async function goTo(s) {
      const my = ++token;
      mode = "seek";
      target = s = clamp(s, 0, span);
      const now = sceneTime(active);
      if (Math.abs(s - now) < frame / 2) { arrive(my); return; }
      const track = s > now ? forward : backward;
      seekStart = performance.now();
      if (track !== active) {
        active.video.pause();
        // Starts moving at once, during the crossfade (no waiting for it).
        handOver(track, now, 1, my);
        await seeked(track.video);
        if (my !== token) return;
      } else {
        play(track.video, 1);
      }
      ({ droppedVideoFrames: droppedAtStart, totalVideoFrames: totalAtStart } = quality(track.video));
      wake();
      const v = track.video, stopAt = videoTime(track, s);
      // Stop on the frame that reaches the target (rVFC reports each
      // presented frame); "ended" covers targets at the very end of a video;
      // timeupdate is the coarse fallback where rVFC is missing.
      const finish = () => {
        if (my !== token) return;
        v.pause();
        if (Math.abs(v.currentTime - stopAt) > frame / 4) v.currentTime = stopAt;   // land on the exact frame
        // Adapt the top speed to this device: slower after a move that
        // dropped over 10 % of its frames, back up after a clean one.
        const q = quality(v), drops = q.droppedVideoFrames - droppedAtStart, total = q.totalVideoFrames - totalAtStart;
        if (total > 8 && drops > 0.1 * total) maxRate = Math.max(2, maxRate - 0.5);
        else if (total > 8 && drops <= 0.02 * total) maxRate = Math.min(SEEK.MAX_RATE, maxRate + 0.5);
        arrive(my);
      };
      v.addEventListener("ended", finish, { once: true });
      if ("requestVideoFrameCallback" in v) {
        const watch = (_, meta) => {
          if (my !== token) return;
          if (meta.mediaTime >= stopAt - frame / 2) finish();
          else v.requestVideoFrameCallback(watch);
        };
        v.requestVideoFrameCallback(watch);
      } else {
        const onTime = () => {
          if (my !== token) { v.removeEventListener("timeupdate", onTime); return; }
          if (v.currentTime >= stopAt - frame / 2) { v.removeEventListener("timeupdate", onTime); finish(); }
        };
        v.addEventListener("timeupdate", onTime);
      }
    }

    /**
     * A seek reached its target. Morning and night are the FIRST frames of the
     * forward and backward videos; arriving there on the other video (whose
     * last frame is one frame short), swap to the exact frame.
     */
    async function arrive(my) {
      if (my !== token) return;
      const s = target;
      for (const track of [forward, backward]) if (track !== active) track.video.pause();
      const exact = s === 0 ? forward : s === span ? backward : null;
      if (exact && exact !== active) await handOver(exact, s, 0, my, SWAP_FADE_MS);
      if (my !== token) return;
      mode = "paused";                 // only now: the exact frame is on screen
      onArrive(s);
      wake();
    }

    // ------------------------------------------------------------ scrub

    /**
     * Shows the frame at scene time s while dragging (pauses playback). Seeks
     * are issued one at a time: while one is in flight, only the latest
     * position is kept, so the film keeps up with the pointer.
     */
    function scrubTo(s) {
      if (mode !== "scrub") {
        token++;
        mode = "scrub";
        target = null;
        forward.video.pause();
        backward.video.pause();
      }
      scrubTarget = clamp(s, 0, span);
      const v = active.video;
      if (!v.seeking) v.currentTime = videoTime(active, scrubTarget);
      wake();
    }
    for (const track of [forward, backward]) {
      track.video.addEventListener("seeked", () => {
        if (mode !== "scrub" || track !== active || scrubTarget === null) return;
        const t = videoTime(active, scrubTarget);
        if (Math.abs(track.video.currentTime - t) > frame / 2) track.video.currentTime = t;
      });
    }
    /** Ends a drag where it is (paused). */
    function endScrub() {
      if (mode !== "scrub") return;
      mode = "paused";
      scrubTarget = null;
      wake();
    }

    // ------------------------------------------------------------ background tabs

    // Pause while the tab is hidden (saves battery); resume autoplay on return.
    document.addEventListener("visibilitychange", () => {
      if (document.hidden) {
        resumeOnShow = mode === "autoplay";
        if (resumeOnShow) { forward.video.pause(); backward.video.pause(); }
      } else if (resumeOnShow && mode === "autoplay") {
        resumeOnShow = false;
        play(active.video, autoplaySpeed());
        wake();
      }
    });

    stack();
    wake();

    return {
      autoplay, pause, goTo, scrubTo, endScrub,
      get position() { return sceneTime(active); },
      get mode() { return mode; },
      get playing() { return anyPlaying(); },
      get active() { return active === forward ? "forward" : "backward"; },
      get maxRate() { return maxRate; },
      span
    };
  }

  window.DayNightSequence = { create, FADE_MS, SWAP_FADE_MS, SEEK, ENDS };
})();
