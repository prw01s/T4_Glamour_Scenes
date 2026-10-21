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
 *
 * LAYERS: each video sits in its own layer element (its painted copy, see
 * js/videoShaderRender.js, lives in the same layer). The active layer is on
 * top (z-index 2); a newly activated layer is raised and faded in from
 * opacity 0 over the other, which is then paused. The incoming video is first
 * seeked to the same scene time, so the crossfade joins matching frames.
 *
 * MODES
 *   autoplay  the active video plays; when it ends, the other one takes over
 *             from its start (which matches the ended video's last frame), so
 *             day -> night -> day ... loops endlessly. The inactive video is
 *             parked at its start in advance, so the hand-over is immediate.
 *   seek      goTo(s): play toward scene time s and pause there. Moving later
 *             in the day plays the forward video, earlier plays the backward
 *             one (switching to it first if needed), at normal speed.
 *   idle      paused at a time point (after a seek).
 *
 * Exposes window.DayNightSequence.create().
 * ======================================================================== */
(function () {
  "use strict";

  /** Crossfade between the two videos, in ms. */
  const FADE_MS = 400;

  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

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
   */

  /**
   * @param {Object} o
   * @param {Track} o.forward   Morning -> night.
   * @param {Track} o.backward  Night -> morning.
   * @param {number} [o.span=5]  Scene length in seconds (the shorter video's duration).
   * @param {number} [o.fps=24]  Frame rate, for stopping on the exact frame.
   * @param {(state: { position: number, mode: string, target: number | null }) => void} [o.onUpdate]
   *   Called on every animation frame with the scene time and mode.
   */
  function create({ forward, backward, span = 5, fps = 24, onUpdate = () => {} }) {
    const frame = 1 / fps;
    const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)");
    /** @type {Track} The track on top. */
    let active = forward;
    /** @type {"autoplay" | "seek" | "idle"} */
    let mode = "idle";
    /** Seek mode: the scene time to stop at. */
    let target = null;
    /** Bumped by every autoplay() / goTo(); stale async steps check it and stop. */
    let token = 0;

    const other = track => (track === forward ? backward : forward);
    /** Scene time shown by `track` at its video time t. */
    const sceneTime = (track, t = track.video.currentTime) => clamp(track === forward ? t : span - t, 0, span);
    /** The video time at which `track` shows scene time s. */
    const videoTime = (track, s) => clamp(track === forward ? s : span - s, 0, track.video.duration || span);
    const play = video => video.play().catch(() => {});      // autoplay may be blocked; the page retries on input

    function stack() {
      active.layer.style.zIndex = 2;
      other(active).layer.style.zIndex = 1;
    }

    /**
     * Makes `next` the visible track at scene time s: seek it (still
     * underneath), optionally start it, raise it and fade it in, then pause
     * the previous one.
     * @returns {Promise<boolean>} false if a newer command took over meanwhile.
     */
    async function handOver(next, s, startPlaying, my) {
      const v = next.video, t = videoTime(next, s);
      if (Math.abs(v.currentTime - t) > frame / 2) { v.currentTime = t; await seeked(v); }
      if (my !== token) return false;
      if (startPlaying) play(v);
      const prev = active;
      active = next;
      stack();
      if (!reducedMotion.matches) {
        await next.layer.animate([{ opacity: 0 }, { opacity: 1 }],
          { duration: FADE_MS, easing: "ease-in-out" }).finished.catch(() => {});
      }
      prev.video.pause();
      return my === token;
    }

    /** Parks the inactive video at its start, ready for the next autoplay hand-over. */
    function park() {
      const v = other(active).video;
      if (v.currentTime !== 0) v.currentTime = 0;
    }

    // Autoplay hand-over: when the active video ends, the other one continues.
    for (const track of [forward, backward]) {
      track.video.addEventListener("ended", async () => {
        if (track !== active) return;
        if (mode === "autoplay") {
          const my = token;
          if (await handOver(other(track), sceneTime(track), true, my)) park();
        } else if (mode === "seek") {
          mode = "idle";                               // reached the end of the day / night
        }
      });
    }

    /**
     * Continuous day -> night -> day playback, starting with the active video
     * from where it is now (playing forward in its own time).
     */
    function autoplay() {
      token++;
      mode = "autoplay";
      target = null;
      const v = active.video;
      if (v.ended || v.currentTime >= (v.duration || span) - frame / 2) {
        // At the very end: hand over straight away instead of replaying nothing.
        v.dispatchEvent(new Event("ended"));
      } else {
        play(v);
        park();
      }
    }

    /**
     * Plays to scene time s and pauses there: forward video if s is later in
     * the day than now, backward video if earlier.
     * @param {number} s  Scene time, 0..span.
     */
    async function goTo(s) {
      const my = ++token;
      mode = "seek";
      target = s = clamp(s, 0, span);
      const now = sceneTime(active);
      if (Math.abs(s - now) < frame / 2) {
        active.video.pause();
        mode = "idle";
        return;
      }
      const track = s > now ? forward : backward;
      if (track !== active) {
        active.video.pause();
        if (!(await handOver(track, now, false, my))) return;
      }
      const v = track.video, stopAt = videoTime(track, s);
      const stop = () => {
        if (my !== token) return;
        v.pause();
        if (Math.abs(v.currentTime - stopAt) > frame / 4) v.currentTime = stopAt;   // land on the exact frame
        mode = "idle";
      };
      // Stop on the frame that reaches the target (requestVideoFrameCallback
      // reports each presented frame); timeupdate is the coarse fallback.
      if ("requestVideoFrameCallback" in v) {
        const watch = (_, meta) => {
          if (my !== token) return;
          if (meta.mediaTime >= stopAt - frame / 2) stop();
          else v.requestVideoFrameCallback(watch);
        };
        v.requestVideoFrameCallback(watch);
      } else {
        const onTime = () => {
          if (my !== token) { v.removeEventListener("timeupdate", onTime); return; }
          if (v.currentTime >= stopAt - frame / 2) { v.removeEventListener("timeupdate", onTime); stop(); }
        };
        v.addEventListener("timeupdate", onTime);
      }
      play(v);
    }

    // Report the scene time on every animation frame (for the page's playhead).
    const tick = () => {
      onUpdate({ position: sceneTime(active), mode, target });
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
    stack();

    return {
      autoplay, goTo,
      get position() { return sceneTime(active); },
      get mode() { return mode; },
      get active() { return active === forward ? "forward" : "backward"; },
      span
    };
  }

  window.DayNightSequence = { create, FADE_MS };
})();
