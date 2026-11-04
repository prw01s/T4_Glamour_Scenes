/* ==========================================================================
 * sheenCustomRoom.js - hands a room calibrated in sheenCalibrate.html to
 * sheenSceneRenderer.html (?custom): the room's config and its three images
 * (day, night, mask) are kept in IndexedDB, which stores image Blobs
 * directly (localStorage's ~5 MB would not hold them). Also keeps the
 * calibration page's work between visits.
 *
 * Classic script: defines window.SheenCustomRoom.
 * ======================================================================== */
(function () {
  "use strict";
  const DB = "t4-sheen", STORE = "kv";

  function open() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  async function run(mode, fn) {
    const db = await open();
    try {
      return await new Promise((resolve, reject) => {
        const tx = db.transaction(STORE, mode), req = fn(tx.objectStore(STORE));
        tx.oncomplete = () => resolve(req && req.result);
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error);
      });
    } finally { db.close(); }
  }

  /** Stores a structured-cloneable value (Blobs included). */
  const save = (key, value) => run("readwrite", s => s.put(value, key));
  /** The stored value, or undefined. */
  const load = key => run("readonly", s => s.get(key));
  /** Deletes a stored value. */
  const remove = key => run("readwrite", s => s.delete(key));

  /**
   * The custom room as a ROOMS entry for sheenSceneRenderer.html (photos and
   * mask as object URLs), or null if none was saved.
   * @returns {Promise<object | null>}
   */
  async function roomEntry() {
    const c = await load("customRoom");
    if (!c || !c.config || !c.blobs) return null;
    return {
      ...c.config,
      photos: { day: URL.createObjectURL(c.blobs.day), night: URL.createObjectURL(c.blobs.night) },
      mask: URL.createObjectURL(c.blobs.mask)
    };
  }

  window.SheenCustomRoom = { save, load, remove, roomEntry };
})();
