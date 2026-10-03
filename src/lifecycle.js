export function createRequestTracker() {
  let projectId = null,
    revisionId = 0;
  return {
    setProject(id) {
      projectId = id;
      revisionId = 0;
    },
    bump() {
      revisionId++;
      return revisionId;
    },
    token() {
      return { projectId, revisionId };
    },
    isCurrent(t) {
      return !!t && t.projectId === projectId && t.revisionId === revisionId;
    },
    get revisionId() {
      return revisionId;
    },
  };
}

/**
 * Generation-based save controller. `save(generation)` must snapshot the in-memory state
 * synchronously before its first await; a completion only acknowledges its own generation.
 */
export function createSaveController({
  save,
  debounceMs = 1500,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  onChange = (_state) => {},
}) {
  let generation = 0,
    savedGeneration = 0,
    pendingUploads = 0,
    inFlight = null,
    timer = null,
    lastError = null,
    autosave = true;
  const api = {
    markChanged() {
      generation++;
      if (autosave) schedule();
      notify();
      return generation;
    },
    setPendingUploads(n) {
      pendingUploads = n;
      notify();
    },
    isDirty() {
      return generation !== savedGeneration || pendingUploads > 0;
    },
    saveNow() {
      if (timer) {
        clearTimer(timer);
        timer = null;
      }
      return run();
    },
    async drain(maxRounds = 10) {
      for (let i = 0; i < maxRounds; i++) {
        if (!api.isDirty()) return true;
        await api.saveNow();
        if (lastError || pendingUploads > 0) return false;
      }
      return !api.isDirty();
    },
    state() {
      return {
        generation,
        savedGeneration,
        pendingUploads,
        saving: !!inFlight,
        dirty: api.isDirty(),
        error: lastError,
      };
    },
    setAutosave(v) {
      autosave = v;
    },
  };
  const notify = () => onChange(api.state());
  function schedule() {
    if (timer) clearTimer(timer);
    timer = setTimer(() => {
      timer = null;
      run();
    }, debounceMs);
  }
  async function run() {
    if (inFlight) return inFlight;
    const gen = generation;
    inFlight = (async () => {
      try {
        await save(gen);
        if (gen > savedGeneration) savedGeneration = gen;
        lastError = null;
      } catch (e) {
        lastError = e;
      } finally {
        inFlight = null;
        notify();
      }
    })();
    await inFlight;
    if (autosave && !lastError && generation !== savedGeneration) schedule();
  }
  return api;
}
