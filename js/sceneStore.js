/* ==========================================================================
 * sceneStore.js - a small IndexedDB key-value store for the scene uploaded
 * on shaderSceneRenderer.html (key "sceneUpload": its four images). IndexedDB
 * stores image Blobs directly (localStorage's ~5 MB would not hold them).
 *
 * The database keeps its original name ("t4-sheen") so uploads stored
 * before the rename are still found.
 *
 * Classic script: defines window.SceneStore.
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

  window.SceneStore = { save, load, remove };
})();
