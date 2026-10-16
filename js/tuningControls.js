/* ==========================================================================
 * tuningControls.js — the tinting controls shared by both visualizer pages:
 *
 *   Tinting algo           v3 / v2 / v1 (setModel)
 *   Contrast, Saturation   sliders, -100..100, centre = as shot (setContrast,
 *                          setSaturation; sent to the renderer as -1..1)
 *   Difference from white  how Saturation measures each pixel (setSatMeasure)
 *   Reset                  both sliders back to the centre
 *
 * Usage (classic script; exposes window.TuningControls):
 *
 *   const controls = TuningControls.mount(fieldset, { subject: "video" });
 *   const renderer = create...({ initialModel: controls.model, ... });
 *   controls.bind(renderer, { onChange: () => renderer.play() });
 *
 * mount() writes the markup into the page's <fieldset class="controls">;
 * bind() wires it to a renderer with setModel / setContrast / setSaturation /
 * setSatMeasure (both page renderers have them). Styles: css/visualizer.css.
 * ======================================================================== */
(function () {
  "use strict";

  /** The "Tinting algo" options, in display order: [value, label]. */
  const MODELS = [["v3", "Physical (v3)"], ["v2", "Perceptual (v2)"], ["v1", "HSV (v1)"]];
  /** The model selected at load (the look the pages had before v3). */
  const DEFAULT_MODEL = "v2";
  /** Slider values within SNAP of the centre snap to it, so the default is easy to find again. */
  const SNAP = 3;

  /**
   * Wording per page. `noun` is what the sliders adjust; `asShot` labels the
   * slider centre; `median` says what each pixel is compared with.
   */
  const SUBJECTS = {
    photos: { title: "Photo light, before tinting", noun: "photos'", asShot: "As shot",
              median: "the median pixel of the room's photos", pivot: "the room's median brightness" },
    video:  { title: "Video, before tinting", noun: "video's", asShot: "As filmed",
              median: "the median pixel of the video", pivot: "its median brightness" }
  };

  /** A segmented radio group: [value, label] pairs; the first matching `checked` is checked. */
  function segmented(name, options, checked, labelledBy = null) {
    return `<div class="segmented"${labelledBy ? ` role="radiogroup" aria-labelledby="${labelledBy}"` : ""}>` +
      options.map(([value, label]) =>
        `<label><input class="vh" type="radio" name="${name}" value="${value}"${value === checked ? " checked" : ""}><span>${label}</span></label>`
      ).join("") + `</div>`;
  }

  /** One slider block. All text is trusted constant copy from SUBJECTS. */
  function slider(id, label, ends, hint, extra = "") {
    return `
      <div class="slider">
        <div class="slider__head">
          <label class="slider__label" for="${id}">${label}</label>
          <output class="slider__value" id="${id}Value" for="${id}">0</output>
        </div>
        <input class="slider__input" type="range" id="${id}" name="${id}"
          min="-100" max="100" step="1" value="0" list="sliderCentre" aria-describedby="${id}Hint">
        <div class="slider__ends" aria-hidden="true">${ends.map(e => `<span>${e}</span>`).join("")}</div>
        <p class="slider__hint" id="${id}Hint">${hint}</p>${extra}
      </div>`;
  }

  /**
   * Writes the controls into `fieldset` (its old content is replaced).
   * @param {HTMLFieldSetElement} fieldset  The page's fieldset.controls.
   * @param {{ subject: "photos" | "video", model?: string }} o
   * @returns {{ model: string, bind: (renderer: object, opts?: { onChange?: () => void }) => void }}
   */
  function mount(fieldset, { subject, model = DEFAULT_MODEL }) {
    const S = SUBJECTS[subject];
    fieldset.innerHTML = `
      <legend class="vh">Tinting controls</legend>
      <fieldset class="model">
        <legend class="vh">Shader model</legend>
        <div class="model__row">
          <span class="model__label" aria-hidden="true">Tinting algo</span>
          ${segmented("model", MODELS, model)}
        </div>
      </fieldset>
      <fieldset class="sliders">
        <legend class="vh">${S.title}: adjustments applied before the paint color</legend>
        <div class="sliders__head">
          <span class="sliders__title" aria-hidden="true">${S.title}</span>
          <button class="sliders__reset" type="button" disabled>Reset</button>
        </div>
        ${slider("contrast", "Contrast", ["Flatter", S.asShot, "Punchier"],
          `Spreads the ${S.noun} light and shade apart or pulls them together, around ${S.pivot}.`)}
        ${slider("saturation", "Saturation", ["Muted", S.asShot, "Richer"],
          `Strength of the light's color. Each pixel changes in proportion to how far it is from pure white, compared with ${S.median}.`,
          `
        <div class="model__row slider__measure">
          <span class="model__label" id="satMeasureLabel">Difference from white</span>
          ${segmented("satMeasure", [["full", "Color + brightness"], ["chroma", "Color only"]], "full", "satMeasureLabel")}
        </div>`)}
        <datalist id="sliderCentre"><option value="0"></option></datalist>
      </fieldset>`;

    const inputs = ["contrast", "saturation"].map(id => fieldset.querySelector(`#${id}`));
    const reset = fieldset.querySelector(".sliders__reset");

    return {
      model,
      bind(renderer, { onChange = () => {} } = {}) {
        const setters = { contrast: v => renderer.setContrast(v), saturation: v => renderer.setSaturation(v) };
        /** Applies one slider: snap, show the value, send it to the renderer as -1..1. */
        const apply = input => {
          let value = Math.round(+input.value);
          if (Math.abs(value) <= SNAP) value = 0;
          input.value = value;
          fieldset.querySelector(`#${input.id}Value`).textContent =
            value > 0 ? `+${value}` : value < 0 ? `−${-value}` : "0";
          setters[input.name](value / 100);
          reset.disabled = inputs.every(i => +i.value === 0);
        };
        // "input" fires while dragging, so the walls follow the thumb.
        fieldset.addEventListener("input", e => { if (inputs.includes(e.target)) apply(e.target); });
        // "change" fires for clicks, taps and arrow keys on the radios.
        fieldset.addEventListener("change", e => {
          const t = e.target;
          if (t.name === "model") renderer.setModel(t.value);
          else if (t.name === "satMeasure") renderer.setSatMeasure(t.value);
          else return;
          onChange();
        });
        reset.addEventListener("click", () => { for (const input of inputs) { input.value = 0; apply(input); } });
      }
    };
  }

  window.TuningControls = { mount, MODELS, DEFAULT_MODEL, SNAP };
})();
